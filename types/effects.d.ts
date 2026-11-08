/**
 * One waiting effect row. `value` is an opaque serialized payload: the queue
 * never parses or validates it.
 *
 * @typedef {object} EffectRow
 * @property {string} key
 * @property {string} value
 * @property {number} seq         queue position, preserved when the payload is replaced
 * @property {number} generation  bumped on re-enqueue, so a stale attempt cannot touch a newer payload
 * @property {number} attempts    failed attempts so far
 * @property {string} error       last failure text, '' when there is none
 * @property {number} due         earliest time (ms) this row may run
 */
/**
 * The only thing an attempt is allowed to use to mutate its row. Both fields
 * are checked, so a replaced payload or a completed row is never overwritten.
 *
 * @typedef {{seq: number, generation: number}} Guard
 */
/**
 * Storage port. Implement it over SQLite, Postgres, Redis or a Map; every
 * method is synchronous inside the caller's transaction.
 *
 * @typedef {object} EffectStore
 * @property {(kind: string, key: string, value: string, now: number) => void} upsert
 * @property {(kind: string) => EffectRow | undefined} oldest
 * @property {(kind: string, now: number, limit: number) => EffectRow[]} due
 * @property {(kind: string, key: string, guard: Guard) => void} drop
 * @property {(kind: string, key: string, guard: Guard, due: number, attempts: number, error: string) => void} reschedule
 * @property {(kind: string, key?: string) => boolean} has
 * @property {(kind: string) => {waiting: number, oldestSince: number | null, oldestDue: number | null, maxAttempts: number, lastError: string | null}} summary
 */
/**
 * Timers are injectable so a deadline can be tested without sleeping.
 *
 * @typedef {object} Timers
 * @property {(ms: number, fire: () => void) => (() => void)} start  returns a cancel function
 */
/** @type {Timers} */
export const systemTimers: Timers;
/**
 * Return this from a handler to defer without counting a failure. The row
 * keeps its queue position and its attempt count.
 */
export const Later: unique symbol;
/**
 * A durable effect queue. Rows are written (normally inside the caller's
 * `unit.atomic`) and dispatched afterwards, so an effect is lost only if it was
 * never enqueued in a committed transaction.
 */
export class EffectQueue {
    /**
     * @param {EffectStore} store
     * @param {EffectsOptions} [options]
     */
    constructor(store: EffectStore, options?: EffectsOptions);
    /**
     * @param {string} kind
     * @param {(value: string, key: string) => unknown} handler  return `Later` to defer
     * @param {Registration} [options]
     */
    register(kind: string, handler: (value: string, key: string) => unknown, options?: Registration): void;
    /**
     * Enqueues (or replaces) an effect. Call this inside a transaction so the row
     * commits with the state change that caused it.
     *
     * @param {string} kind
     * @param {string} key
     * @param {string} value  serialized payload
     */
    enqueue(kind: string, key: string, value: string): void;
    /** @param {string} kind @param {string} [key] @returns {boolean} */
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
     * One dispatch pass. Runs only rows that are due now; survivors stay in the
     * store and are picked up by a later pass, which is how a restart resumes.
     *
     * @returns {Promise<Array<{kind: string, picked: number, done: number, deferred: number, failed: number}>>}
     */
    run(): Promise<Array<{
        kind: string;
        picked: number;
        done: number;
        deferred: number;
        failed: number;
    }>>;
    #private;
}
/**
 * One waiting effect row. `value` is an opaque serialized payload: the queue
 * never parses or validates it.
 */
export type EffectRow = {
    key: string;
    value: string;
    /**
     * queue position, preserved when the payload is replaced
     */
    seq: number;
    /**
     * bumped on re-enqueue, so a stale attempt cannot touch a newer payload
     */
    generation: number;
    /**
     * failed attempts so far
     */
    attempts: number;
    /**
     * last failure text, '' when there is none
     */
    error: string;
    /**
     * earliest time (ms) this row may run
     */
    due: number;
};
/**
 * The only thing an attempt is allowed to use to mutate its row. Both fields
 * are checked, so a replaced payload or a completed row is never overwritten.
 */
export type Guard = {
    seq: number;
    generation: number;
};
/**
 * Storage port. Implement it over SQLite, Postgres, Redis or a Map; every
 * method is synchronous inside the caller's transaction.
 */
export type EffectStore = {
    upsert: (kind: string, key: string, value: string, now: number) => void;
    oldest: (kind: string) => EffectRow | undefined;
    due: (kind: string, now: number, limit: number) => EffectRow[];
    drop: (kind: string, key: string, guard: Guard) => void;
    reschedule: (kind: string, key: string, guard: Guard, due: number, attempts: number, error: string) => void;
    has: (kind: string, key?: string) => boolean;
    summary: (kind: string) => {
        waiting: number;
        oldestSince: number | null;
        oldestDue: number | null;
        maxAttempts: number;
        lastError: string | null;
    };
};
/**
 * Timers are injectable so a deadline can be tested without sleeping.
 */
export type Timers = {
    /**
     * returns a cancel function
     */
    start: (ms: number, fire: () => void) => (() => void);
};
export type EffectEvent = {
    type: "failed" | "dispatch" | "abandoned";
    kind: string;
    key?: string | undefined;
    attempts?: number | undefined;
    error: unknown;
};
export type EffectsOptions = {
    now?: (() => number) | undefined;
    timers?: Timers | undefined;
    /**
     * how many unordered rows one pass may pick, default 16
     */
    pageSize?: number | undefined;
    report?: ((event: EffectEvent) => void) | undefined;
};
export type Registration = {
    /**
     * concurrency, default 1; `ordered` forces 1
     */
    limit?: number | (() => number) | undefined;
    /**
     * [baseDelayMs, maxDelayMs], default [2000, 60000]
     */
    retry?: [number, number] | undefined;
    /**
     * one at a time, strict queue order, failed head blocks the rest
     */
    ordered?: boolean | undefined;
    /**
     * per-attempt deadline, 0 (default) disables it
     */
    deadlineMs?: number | undefined;
};
