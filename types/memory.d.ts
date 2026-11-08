/**
 * A unit of work plus an in-memory effect store, wired together so a rolled
 * back unit also rolls back its queued effects. Useful in tests and examples.
 *
 * @returns {{store: MemoryEffectStore, driver: MemoryDriver, unit: ReturnType<typeof createUnit>}}
 */
export function createMemoryRuntime(): {
    store: MemoryEffectStore;
    driver: MemoryDriver;
    unit: ReturnType<typeof createUnit>;
};
/**
 * Snapshot-based transaction driver for in-memory state.
 *
 * Every savepoint clones the whole state, so rollback is exact but O(state).
 * That is fine for tests, examples and local development; use the SQLite
 * adapters for real workloads.
 */
export class MemoryDriver {
    /**
     * @param {() => unknown} read      returns the current state
     * @param {(state: unknown) => void} write  replaces the current state
     * @param {(state: unknown) => unknown} [clone]  must deep-copy; defaults to structuredClone
     */
    constructor(read: () => unknown, write: (state: unknown) => void, clone?: (state: unknown) => unknown);
    /** @param {string} name */
    savepoint(name: string): void;
    /** @param {string} name */
    release(name: string): void;
    /** @param {string} name */
    rollbackTo(name: string): void;
    #private;
}
/**
 * In-memory implementation of the effect store port.
 */
export class MemoryEffectStore {
    /** @param {{key: string, value: string, seq: number, generation: number, attempts: number, error: string, due: number}} row */
    static "__#private@#view"(row: {
        key: string;
        value: string;
        seq: number;
        generation: number;
        attempts: number;
        error: string;
        due: number;
    }): {
        key: string;
        value: string;
        seq: number;
        generation: number;
        attempts: number;
        error: string;
        due: number;
    };
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
    due(kind: string, now: number, limit: number): {
        key: string;
        value: string;
        seq: number;
        generation: number;
        attempts: number;
        error: string;
        due: number;
    }[];
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
    /**
     * Serializes all rows for the snapshot driver.
     *
     * @returns {{seq: number, rows: Array<[string, {kind: string, key: string, value: string, seq: number, generation: number, attempts: number, error: string, due: number, since: number}]>}}
     */
    snapshot(): {
        seq: number;
        rows: Array<[string, {
            kind: string;
            key: string;
            value: string;
            seq: number;
            generation: number;
            attempts: number;
            error: string;
            due: number;
            since: number;
        }]>;
    };
    /** @param {ReturnType<MemoryEffectStore['snapshot']>} snapshot */
    restore(snapshot: ReturnType<MemoryEffectStore["snapshot"]>): void;
    #private;
}
import { createUnit } from './unit.js';
