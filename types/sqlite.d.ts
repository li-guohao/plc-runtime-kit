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
/**
 * Opens a SQLite file (or `':memory:'`) and returns the three pieces wired for
 * use. The caller owns `db` and must close it.
 *
 * @param {string} path
 * @returns {{db: SqliteDatabase, driver: SqliteTransactionDriver, store: SqliteEffectStore}}
 */
export function openSqlite(path: string): {
    db: SqliteDatabase;
    driver: SqliteTransactionDriver;
    store: SqliteEffectStore;
};
/**
 * Transaction driver over `node:sqlite`. It only issues savepoints, so it
 * composes with a surrounding transaction instead of forcing `BEGIN`.
 */
export class SqliteTransactionDriver {
    /** @param {SqliteDatabase} db */
    constructor(db: SqliteDatabase);
    /** @param {string} name */
    savepoint(name: string): void;
    /** @param {string} name */
    release(name: string): void;
    /** @param {string} name */
    rollbackTo(name: string): void;
    #private;
}
/**
 * Effect store on a single `effect` table. One writer connection is assumed,
 * which matches the queue's one-pass-at-a-time contract.
 */
export class SqliteEffectStore {
    /** @param {SqliteDatabase} db */
    constructor(db: SqliteDatabase);
    /**
     * @param {string} kind
     * @param {string} key
     * @param {string} value
     * @param {number} now
     */
    upsert(kind: string, key: string, value: string, now: number): void;
    /** @param {string} kind */
    oldest(kind: string): {
        key: string;
        value: string;
        seq: number;
        generation: number;
        attempts: number;
        error: string;
        due: number;
    } | undefined;
    /**
     * @param {string} kind
     * @param {number} now
     * @param {number} limit
     */
    due(kind: string, now: number, limit: number): import("./effects.js").EffectRow[];
    /**
     * @param {string} kind
     * @param {string} key
     * @param {{seq: number, generation: number}} guard
     */
    drop(kind: string, key: string, guard: {
        seq: number;
        generation: number;
    }): void;
    /**
     * @param {string} kind
     * @param {string} key
     * @param {{seq: number, generation: number}} guard
     * @param {number} due
     * @param {number} attempts
     * @param {string} error
     */
    reschedule(kind: string, key: string, guard: {
        seq: number;
        generation: number;
    }, due: number, attempts: number, error: string): void;
    /**
     * @param {string} kind
     * @param {string} [key]
     * @returns {boolean}
     */
    has(kind: string, key?: string): boolean;
    /** @param {string} kind */
    summary(kind: string): {
        waiting: number;
        oldestSince: number | null;
        oldestDue: number | null;
        maxAttempts: number;
        lastError: string | null;
    };
    #private;
}
export type SqliteModule = {
    DatabaseSync: typeof import("node:sqlite").DatabaseSync;
};
export type SqliteDatabase = import("node:sqlite").DatabaseSync;
