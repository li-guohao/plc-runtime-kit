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
export function meetsMinimumNode(version: string): boolean;
/**
 * Fails loudly, with the three facts a caller needs, before any adapter is built.
 * Exported so tests can inject a version and a loader instead of changing the real
 * Node version.
 *
 * @param {string} [version]  Node version to check, defaults to the running one
 * @param {() => SqliteModule | undefined} [load]  module loader, injectable for tests
 * @returns {SqliteModule}
 */
export function assertSqliteAvailable(version?: string, load?: () => SqliteModule | undefined): SqliteModule;
export type SqliteModule = {
    DatabaseSync: typeof import("node:sqlite").DatabaseSync;
};
