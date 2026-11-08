// The guard lives in its own module because `sqlite.js` throws at import time on
// old Node (by design). Keeping the check importable everywhere lets the test
// suite exercise it on Node 20/22.4 without pulling in `node:sqlite`.

import { createRequire } from 'node:module';

const MIN_NODE = [22, 5, 0];
const requireFromHere = createRequire(import.meta.url);

/**
 * @typedef {{DatabaseSync: typeof import('node:sqlite').DatabaseSync}} SqliteModule
 */

/**
 * Compares the first three components of a Node version numerically. A prerelease
 * suffix does not matter here: the built-in module is gated by major/minor.
 *
 * @param {string} version
 * @returns {boolean}
 */
export function meetsMinimumNode(version) {
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
