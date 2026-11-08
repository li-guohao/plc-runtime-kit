// New code, no upstream counterpart; see NOTICE.

import { createUnit } from './unit.js';

/**
 * Snapshot-based transaction driver for in-memory state.
 *
 * Every savepoint clones the whole state, so rollback is exact but O(state).
 * That is fine for tests, examples and local development; use the SQLite
 * adapters for real workloads.
 */
export class MemoryDriver {
  #read;
  #write;
  #clone;
  /** @type {Map<string, unknown>} */
  #snapshots = new Map();

  /**
   * @param {() => unknown} read      returns the current state
   * @param {(state: unknown) => void} write  replaces the current state
   * @param {(state: unknown) => unknown} [clone]  must deep-copy; defaults to structuredClone
   */
  constructor(read, write, clone = structuredClone) {
    if (typeof read !== 'function' || typeof write !== 'function') {
      throw new TypeError('MemoryDriver needs read() and write(state) functions');
    }
    if (typeof clone !== 'function') throw new TypeError('MemoryDriver needs clone to be a function');
    this.#read = read;
    this.#write = write;
    this.#clone = clone;
  }

  /** @param {string} name */
  savepoint(name) {
    this.#snapshots.set(name, this.#clone(this.#read()));
  }

  /** @param {string} name */
  release(name) {
    this.#snapshots.delete(name);
  }

  /** @param {string} name */
  rollbackTo(name) {
    if (!this.#snapshots.has(name)) throw new Error(`no snapshot for savepoint "${name}"`);
    this.#write(this.#snapshots.get(name));
    this.#snapshots.delete(name);
  }
}

/**
 * In-memory implementation of the effect store port.
 */
export class MemoryEffectStore {
  /** @type {Map<string, {kind: string, key: string, value: string, seq: number, generation: number, attempts: number, error: string, due: number, since: number}>} */
  #rows = new Map();
  #seq = 0;

  /** @param {string} kind @param {string} key @returns {string} */
  #id(kind, key) {
    return `${kind}\u0000${key}`;
  }

  /** @param {{key: string, value: string, seq: number, generation: number, attempts: number, error: string, due: number}} row */
  static #view(row) {
    return {
      key: row.key,
      value: row.value,
      seq: row.seq,
      generation: row.generation,
      attempts: row.attempts,
      error: row.error,
      due: row.due,
    };
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

    const id = this.#id(kind, key);
    const existing = this.#rows.get(id);
    if (existing !== undefined) {
      // Coalesce onto the waiting row: keep its queue position and `since`,
      // bump the generation, and give the new payload a fresh failure budget.
      existing.value = value;
      existing.generation += 1;
      existing.attempts = 0;
      existing.error = '';
      existing.due = now;
      return;
    }

    this.#seq += 1;
    this.#rows.set(id, {
      kind,
      key,
      value,
      seq: this.#seq,
      generation: 0,
      attempts: 0,
      error: '',
      due: now,
      since: now,
    });
  }

  /** @param {string} kind */
  oldest(kind) {
    let best;
    for (const row of this.#rows.values()) {
      if (row.kind !== kind) continue;
      if (best === undefined || row.seq < best.seq) best = row;
    }
    return best === undefined ? undefined : MemoryEffectStore.#view(best);
  }

  /**
   * @param {string} kind
   * @param {number} now
   * @param {number} limit
   */
  due(kind, now, limit) {
    /** @type {Array<{key: string, value: string, seq: number, generation: number, attempts: number, error: string, due: number}>} */
    const rows = [];
    for (const row of this.#rows.values()) {
      if (row.kind === kind && row.due <= now) rows.push(MemoryEffectStore.#view(row));
    }
    rows.sort((left, right) => left.seq - right.seq);
    return rows.slice(0, limit);
  }

  /**
   * @param {string} kind
   * @param {string} key
   * @param {{seq: number, generation: number}} guard
   */
  drop(kind, key, guard) {
    const id = this.#id(kind, key);
    const row = this.#rows.get(id);
    if (row === undefined || row.seq !== guard.seq || row.generation !== guard.generation) return;
    this.#rows.delete(id);
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
    const row = this.#rows.get(this.#id(kind, key));
    if (row === undefined || row.seq !== guard.seq || row.generation !== guard.generation) return;
    row.due = due;
    row.attempts = attempts;
    row.error = error;
  }

  /**
   * @param {string} kind
   * @param {string} [key]
   * @returns {boolean}
   */
  has(kind, key) {
    if (key === undefined) {
      for (const row of this.#rows.values()) if (row.kind === kind) return true;
      return false;
    }
    return this.#rows.has(this.#id(kind, key));
  }

  /** @param {string} kind */
  summary(kind) {
    let waiting = 0;
    let oldestSince = null;
    let oldestDue = null;
    let maxAttempts = 0;
    let lastError = null;
    let lastErrorSeq = -1;

    for (const row of this.#rows.values()) {
      if (row.kind !== kind) continue;
      waiting += 1;
      oldestSince = oldestSince === null ? row.since : Math.min(oldestSince, row.since);
      oldestDue = oldestDue === null ? row.due : Math.min(oldestDue, row.due);
      maxAttempts = Math.max(maxAttempts, row.attempts);
      if (row.error !== '' && row.seq > lastErrorSeq) {
        lastError = row.error;
        lastErrorSeq = row.seq;
      }
    }

    return { waiting, oldestSince, oldestDue, maxAttempts, lastError };
  }

  /**
   * Serializes all rows for the snapshot driver.
   *
   * @returns {{seq: number, rows: Array<[string, {kind: string, key: string, value: string, seq: number, generation: number, attempts: number, error: string, due: number, since: number}]>}}
   */
  snapshot() {
    return {
      seq: this.#seq,
      rows: [...this.#rows.entries()].map(([id, row]) => [id, { ...row }]),
    };
  }

  /** @param {ReturnType<MemoryEffectStore['snapshot']>} snapshot */
  restore(snapshot) {
    this.#rows.clear();
    for (const [id, row] of snapshot.rows) this.#rows.set(id, { ...row });
    this.#seq = snapshot.seq;
  }
}

/**
 * A unit of work plus an in-memory effect store, wired together so a rolled
 * back unit also rolls back its queued effects. Useful in tests and examples.
 *
 * @returns {{store: MemoryEffectStore, driver: MemoryDriver, unit: ReturnType<typeof createUnit>}}
 */
export function createMemoryRuntime() {
  const store = new MemoryEffectStore();
  const driver = new MemoryDriver(
    () => store.snapshot(),
    (state) => store.restore(/** @type {ReturnType<MemoryEffectStore['snapshot']>} */ (state)),
  );
  return { store, driver, unit: createUnit(driver) };
}
