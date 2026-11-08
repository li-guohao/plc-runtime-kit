// New adapters on Node's built-in `node:sqlite`; see NOTICE.
// Import this module only when you need SQLite: it pulls in a built-in module
// that is unavailable on older Node versions (needs >= 22.5).

import { createRequire } from 'node:module';

const MIN_NODE = [22, 5, 0];
const requireFromHere = createRequire(import.meta.url);

/**
 * @typedef {{DatabaseSync: typeof import('node:sqlite').DatabaseSync}} SqliteModule
 * @typedef {import('node:sqlite').DatabaseSync} SqliteDatabase
 */

/**
 * Compares the first three components of a Node version numerically. A prerelease
 * suffix does not matter here: the built-in module is gated by major/minor.
 *
 * @param {string} version
 * @returns {boolean}
 */
function meetsMinimumNode(version) {
  const parts = String(version).split('.');
  for (let index = 0; index < MIN_NODE.length; index += 1) {
    const actual = Number.parseInt(parts[index] ?? '', 10);
    if (!Number.isInteger(actual)) return false;
    if (actual !== MIN_NODE[index]) return actual > MIN_NODE[index];
  }
  return true;
}

/**
 * @param {string} version
 * @param {string} detail  why the module is unavailable, appended verbatim
 * @returns {string}
 */
function unavailableMessage(version, detail) {
  return (
    '`plc-runtime-kit/sqlite` requires Node >= 22.5 for the built-in `node:sqlite` module' +
    `${detail}; this process is Node ${version}. ` +
    'Use `plc-runtime-kit/memory` for an in-process effect store, or upgrade Node to 22.5 or newer.'
  );
}

/**
 * Resolves `node:sqlite`, or `undefined` when this Node build lacks it. The catch
 * is deliberately narrow: only the module load itself is wrapped, so a failure
 * inside SQLite is never disguised as a version problem.
 *
 * @returns {SqliteModule | undefined}
 */
function loadSqliteModule() {
  try {
    return /** @type {SqliteModule} */ (requireFromHere('node:sqlite'));
  } catch {
    return undefined;
  }
}

/**
 * Fails loudly, with the three facts a caller needs, before any adapter is built.
 * Exported so tests can inject a version and a loader instead of changing the real
 * Node version.
 *
 * @param {string} [version]  Node version to check, defaults to the running one
 * @param {() => SqliteModule | undefined} [load]  module loader, injectable for tests
 * @returns {SqliteModule}
 */
export function assertSqliteAvailable(version = process.versions.node, load = loadSqliteModule) {
  if (!meetsMinimumNode(version)) {
    throw new Error(unavailableMessage(version, ' (this Node version is too old)'));
  }
  const sqlite = load();
  if (sqlite === undefined || typeof sqlite.DatabaseSync !== 'function') {
    throw new Error(unavailableMessage(version, ' (the module is missing from this Node build)'));
  }
  return sqlite;
}

const { DatabaseSync } = assertSqliteAvailable();

const SAVEPOINT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Savepoint names are interpolated into DDL-free statements, so they are
 * validated rather than quoted: anything that is not a plain identifier is a
 * caller bug and must not reach the database.
 *
 * @param {string} name
 * @returns {string}
 */
function safeName(name) {
  if (typeof name !== 'string' || !SAVEPOINT_NAME.test(name)) {
    throw new TypeError(`invalid savepoint name "${String(name)}"`);
  }
  return name;
}

/**
 * Transaction driver over `node:sqlite`. It only issues savepoints, so it
 * composes with a surrounding transaction instead of forcing `BEGIN`.
 */
export class SqliteTransactionDriver {
  #db;

  /** @param {SqliteDatabase} db */
  constructor(db) {
    if (db === null || typeof db !== 'object' || typeof db.exec !== 'function') {
      throw new TypeError('SqliteTransactionDriver needs a DatabaseSync handle');
    }
    this.#db = db;
  }

  /** @param {string} name */
  savepoint(name) {
    this.#db.exec(`SAVEPOINT ${safeName(name)}`);
  }

  /** @param {string} name */
  release(name) {
    this.#db.exec(`RELEASE ${safeName(name)}`);
  }

  /** @param {string} name */
  rollbackTo(name) {
    this.#db.exec(`ROLLBACK TO ${safeName(name)}`);
  }
}

/**
 * Effect store on a single `effect` table. One writer connection is assumed,
 * which matches the queue's one-pass-at-a-time contract.
 */
export class SqliteEffectStore {
  #db;
  /** @type {Map<string, ReturnType<SqliteDatabase['prepare']>>} */
  #statements = new Map();

  /** @param {SqliteDatabase} db */
  constructor(db) {
    if (db === null || typeof db !== 'object' || typeof db.prepare !== 'function' || typeof db.exec !== 'function') {
      throw new TypeError('SqliteEffectStore needs a DatabaseSync handle');
    }
    this.#db = db;
    db.exec(`
      CREATE TABLE IF NOT EXISTS effect (
        kind TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        seq INTEGER NOT NULL,
        generation INTEGER NOT NULL,
        attempts INTEGER NOT NULL,
        error TEXT NOT NULL,
        due INTEGER NOT NULL,
        since INTEGER NOT NULL,
        PRIMARY KEY (kind, key)
      )
    `);
  }

  /** @param {string} sql */
  #prepare(sql) {
    let statement = this.#statements.get(sql);
    if (statement === undefined) {
      statement = this.#db.prepare(sql);
      this.#statements.set(sql, statement);
    }
    return statement;
  }

  /**
   * @param {string} kind
   * @param {string} key
   * @param {string} value
   * @param {number} now
   */
  upsert(kind, key, value, now) {
    if (typeof kind !== 'string' || kind === '') throw new TypeError('effect kind must be a non-empty string');
    if (typeof key !== 'string' || key === '') throw new TypeError('effect key must be a non-empty string');
    if (typeof value !== 'string') throw new TypeError('effect value must be a string');
    if (!Number.isFinite(now)) throw new TypeError('now must be a finite number');

    const updated = this.#prepare(
      `UPDATE effect SET value = ?, generation = generation + 1, attempts = 0, error = '', due = ?
       WHERE kind = ? AND key = ?`,
    ).run(value, now, kind, key);
    if (Number(updated.changes) > 0) return;

    this.#prepare(
      `INSERT INTO effect (kind, key, value, seq, generation, attempts, error, due, since)
       VALUES (?, ?, ?, (SELECT IFNULL(MAX(seq), 0) + 1 FROM effect), 0, 0, '', ?, ?)`,
    ).run(kind, key, value, now, now);
  }

  /** @param {string} kind */
  oldest(kind) {
    return this.#row(
      this.#prepare(
        `SELECT key, value, seq, generation, attempts, error, due FROM effect WHERE kind = ? ORDER BY seq LIMIT 1`,
      ).get(kind),
    );
  }

  /**
   * @param {string} kind
   * @param {number} now
   * @param {number} limit
   */
  due(kind, now, limit) {
    const rows = this.#prepare(
      `SELECT key, value, seq, generation, attempts, error, due
       FROM effect WHERE kind = ? AND due <= ? ORDER BY seq LIMIT ?`,
    ).all(kind, now, limit);
    // `all()` yields only real rows, so the `undefined` arm of #row cannot
    // happen here; the cast keeps the public port free of a phantom `undefined`.
    /** @type {import('./effects.js').EffectRow[]} */
    const views = rows.map((row) => /** @type {import('./effects.js').EffectRow} */ (this.#row(row)));
    return views;
  }

  /**
   * @param {string} kind
   * @param {string} key
   * @param {{seq: number, generation: number}} guard
   */
  drop(kind, key, guard) {
    this.#prepare(`DELETE FROM effect WHERE kind = ? AND key = ? AND seq = ? AND generation = ?`).run(
      kind,
      key,
      guard.seq,
      guard.generation,
    );
  }

  /**
   * @param {string} kind
   * @param {string} key
   * @param {{seq: number, generation: number}} guard
   * @param {number} due
   * @param {number} attempts
   * @param {string} error
   */
  reschedule(kind, key, guard, due, attempts, error) {
    this.#prepare(
      `UPDATE effect SET due = ?, attempts = ?, error = ?
       WHERE kind = ? AND key = ? AND seq = ? AND generation = ?`,
    ).run(due, attempts, error, kind, key, guard.seq, guard.generation);
  }

  /**
   * @param {string} kind
   * @param {string} [key]
   * @returns {boolean}
   */
  has(kind, key) {
    const row =
      key === undefined
        ? this.#prepare(`SELECT 1 AS found FROM effect WHERE kind = ? LIMIT 1`).get(kind)
        : this.#prepare(`SELECT 1 AS found FROM effect WHERE kind = ? AND key = ? LIMIT 1`).get(kind, key);
    return row !== undefined;
  }

  /** @param {string} kind */
  summary(kind) {
    const row = this.#prepare(
      `SELECT COUNT(*) AS waiting, MIN(since) AS oldestSince, MIN(due) AS oldestDue, MAX(attempts) AS maxAttempts,
        (SELECT error FROM effect WHERE kind = ? AND error != '' ORDER BY seq DESC LIMIT 1) AS lastError
       FROM effect WHERE kind = ?`,
    ).get(kind, kind);

    return {
      waiting: Number(row?.waiting ?? 0),
      oldestSince: row?.oldestSince === null || row?.oldestSince === undefined ? null : Number(row.oldestSince),
      oldestDue: row?.oldestDue === null || row?.oldestDue === undefined ? null : Number(row.oldestDue),
      maxAttempts: Number(row?.maxAttempts ?? 0),
      lastError: row?.lastError === null || row?.lastError === undefined ? null : String(row.lastError),
    };
  }

  /**
   * @param {Record<string, unknown> | undefined} row
   */
  #row(row) {
    if (row === undefined) return undefined;
    return {
      key: String(row.key),
      value: String(row.value),
      seq: Number(row.seq),
      generation: Number(row.generation),
      attempts: Number(row.attempts),
      error: String(row.error),
      due: Number(row.due),
    };
  }
}

/**
 * Opens a SQLite file (or `':memory:'`) and returns the three pieces wired for
 * use. The caller owns `db` and must close it.
 *
 * @param {string} path
 * @returns {{db: SqliteDatabase, driver: SqliteTransactionDriver, store: SqliteEffectStore}}
 */
export function openSqlite(path) {
  if (typeof path !== 'string' || path === '') throw new TypeError('openSqlite needs a file path or ":memory:"');
  const db = new DatabaseSync(path);
  return {
    db,
    driver: new SqliteTransactionDriver(db),
    store: new SqliteEffectStore(db),
  };
}
