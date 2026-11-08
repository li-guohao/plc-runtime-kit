// Behaviour derived from dsh-superagent `src/app/effects.ts:64-166` (MIT).
// Rewritten over a store port; see NOTICE. No upstream lines were copied.

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
export const systemTimers = {
  start(ms, fire) {
    const handle = setTimeout(fire, ms);
    // A pending deadline must not keep a shutting-down process alive.
    handle.unref?.();
    return () => clearTimeout(handle);
  },
};

/**
 * Return this from a handler to defer without counting a failure. The row
 * keeps its queue position and its attempt count.
 */
export const Later = Symbol.for('plc-runtime-kit.later');

/**
 * @typedef {object} EffectEvent
 * @property {'failed' | 'dispatch' | 'abandoned'} type
 * @property {string} kind
 * @property {string} [key]
 * @property {number} [attempts]
 * @property {unknown} error
 */

/**
 * @typedef {object} EffectsOptions
 * @property {() => number} [now]
 * @property {Timers} [timers]
 * @property {number} [pageSize]                 how many unordered rows one pass may pick, default 16
 * @property {(event: EffectEvent) => void} [report]
 */

/**
 * @typedef {object} Registration
 * @property {number | (() => number)} [limit]   concurrency, default 1; `ordered` forces 1
 * @property {[number, number]} [retry]          [baseDelayMs, maxDelayMs], default [2000, 60000]
 * @property {boolean} [ordered]                 one at a time, strict queue order, failed head blocks the rest
 * @property {number} [deadlineMs]               per-attempt deadline, 0 (default) disables it
 */

const REQUIRED = ['upsert', 'oldest', 'due', 'drop', 'reschedule', 'has', 'summary'];

/**
 * A durable effect queue. Rows are written (normally inside the caller's
 * `unit.atomic`) and dispatched afterwards, so an effect is lost only if it was
 * never enqueued in a committed transaction.
 */
export class EffectQueue {
  #store;
  #now;
  #timers;
  #pageSize;
  #report;
  /** @type {Map<string, {handler: (value: string, key: string) => unknown, ordered: boolean, limit: number | (() => number), retry: [number, number], deadlineMs: number}>} */
  #handlers = new Map();
  /** `${kind}\0${key}` -> kind; guards against a second pass claiming the same row. */
  #inflight = new Map();

  /**
   * @param {EffectStore} store
   * @param {EffectsOptions} [options]
   */
  constructor(store, options = {}) {
    if (store === null || typeof store !== 'object') throw new TypeError('EffectQueue needs an effect store');
    if (options === null || typeof options !== 'object') throw new TypeError('EffectQueue options must be an object');
    // Methods are looked up by name, so the port is widened to an indexable
    // view here; the public `EffectStore` type stays exact.
    const view = /** @type {Record<string, unknown>} */ (store);
    for (const method of REQUIRED) {
      if (typeof view[method] !== 'function') throw new TypeError(`EffectQueue store is missing ${method}()`);
    }
    const now = options.now ?? Date.now;
    const timers = options.timers ?? systemTimers;
    const pageSize = options.pageSize ?? 16;
    const report = options.report ?? (() => {});
    if (typeof now !== 'function') throw new TypeError('EffectQueue needs now to be a function');
    if (timers === null || typeof timers !== 'object' || typeof timers.start !== 'function') {
      throw new TypeError('EffectQueue needs timers with start()');
    }
    if (!Number.isInteger(pageSize) || pageSize < 1) throw new TypeError('pageSize must be a positive integer');
    if (typeof report !== 'function') throw new TypeError('EffectQueue needs report to be a function');

    this.#store = store;
    this.#now = now;
    this.#timers = timers;
    this.#pageSize = pageSize;
    this.#report = report;
  }

  /**
   * @param {string} kind
   * @param {(value: string, key: string) => unknown} handler  return `Later` to defer
   * @param {Registration} [options]
   */
  register(kind, handler, options = {}) {
    if (typeof kind !== 'string' || kind === '') throw new TypeError('effect kind must be a non-empty string');
    if (typeof handler !== 'function') throw new TypeError('effect handler must be a function');
    if (this.#handlers.has(kind)) throw new Error(`effects of kind "${kind}" already have a handler`);

    const ordered = options.ordered === true;
    const limit = options.limit ?? 1;
    const retry = options.retry ?? [2000, 60_000];
    const deadlineMs = options.deadlineMs ?? 0;

    if (!(typeof limit === 'function' || (Number.isInteger(limit) && limit >= 0))) {
      throw new TypeError('limit must be a non-negative integer or a function');
    }
    if (
      !Array.isArray(retry) ||
      retry.length !== 2 ||
      !Number.isFinite(retry[0]) ||
      !Number.isFinite(retry[1]) ||
      retry[0] < 0 ||
      retry[1] < retry[0]
    ) {
      throw new TypeError('retry must be [baseDelayMs, maxDelayMs] with max >= base');
    }
    if (!Number.isFinite(deadlineMs) || deadlineMs < 0) throw new TypeError('deadlineMs must be >= 0');

    this.#handlers.set(kind, {
      handler,
      ordered,
      limit,
      retry: /** @type {[number, number]} */ ([retry[0], retry[1]]),
      deadlineMs,
    });
  }

  /**
   * Enqueues (or replaces) an effect. Call this inside a transaction so the row
   * commits with the state change that caused it.
   *
   * @param {string} kind
   * @param {string} key
   * @param {string} value  serialized payload
   */
  enqueue(kind, key, value) {
    if (typeof kind !== 'string' || kind === '') throw new TypeError('effect kind must be a non-empty string');
    if (typeof key !== 'string' || key === '') throw new TypeError('effect key must be a non-empty string');
    if (typeof value !== 'string') throw new TypeError('effect value must be a string (serialize the payload yourself)');
    this.#store.upsert(kind, key, value, this.#now());
  }

  /** @param {string} kind @param {string} [key] @returns {boolean} */
  has(kind, key) {
    return this.#store.has(kind, key);
  }

  /** @param {string} kind */
  summary(kind) {
    return this.#store.summary(kind);
  }

  /**
   * One dispatch pass. Runs only rows that are due now; survivors stay in the
   * store and are picked up by a later pass, which is how a restart resumes.
   *
   * @returns {Promise<Array<{kind: string, picked: number, done: number, deferred: number, failed: number}>>}
   */
  async run() {
    /** @type {Array<{kind: string, picked: number, done: number, deferred: number, failed: number}>} */
    const reports = [];
    for (const [kind, registration] of this.#handlers) {
      const report = { kind, picked: 0, done: 0, deferred: 0, failed: 0 };
      try {
        await this.#runKind(kind, registration, report);
      } catch (error) {
        // A broken store or a throwing limit() must not stop other kinds.
        this.#report({ type: 'dispatch', kind, error });
      }
      reports.push(report);
    }
    return reports;
  }

  /** @param {string} kind @param {string} key @returns {string} */
  #id(kind, key) {
    return `${kind}\u0000${key}`;
  }

  /** @param {string} kind @returns {number} */
  #inflightCount(kind) {
    let count = 0;
    for (const busy of this.#inflight.values()) if (busy === kind) count += 1;
    return count;
  }

  /**
   * @param {{limit: number | (() => number)}} registration
   * @returns {number}
   */
  #limit(registration) {
    const value = typeof registration.limit === 'function' ? registration.limit() : registration.limit;
    if (!Number.isInteger(value) || value < 0) throw new TypeError('limit() must return a non-negative integer');
    return value;
  }

  /**
   * @param {{retry: [number, number]}} registration
   * @param {number} attemptsSoFar
   * @returns {number}
   */
  #backoff(registration, attemptsSoFar) {
    return Math.min(registration.retry[1], registration.retry[0] * 2 ** Math.min(attemptsSoFar, 16));
  }

  /**
   * @param {string} kind
   * @param {{handler: (value: string, key: string) => unknown, ordered: boolean, limit: number | (() => number), retry: [number, number], deadlineMs: number}} registration
   * @param {{kind: string, picked: number, done: number, deferred: number, failed: number}} report
   */
  async #runKind(kind, registration, report) {
    const now = this.#now();
    let rows;
    if (registration.ordered) {
      // Ordered kinds block behind their oldest row even when it is not due
      // yet: a failed head holds back everything queued after it.
      if (this.#inflightCount(kind) > 0) return;
      const head = this.#store.oldest(kind);
      if (head === undefined || head.due > now) return;
      rows = [head];
    } else {
      const room = Math.max(0, this.#limit(registration) - this.#inflightCount(kind));
      if (room === 0) return;
      rows = this.#store
        .due(kind, now, this.#pageSize)
        .filter((row) => !this.#inflight.has(this.#id(kind, row.key)))
        .slice(0, room);
    }
    if (rows.length === 0) return;
    await Promise.all(rows.map((row) => this.#attempt(kind, registration, row, report)));
  }

  /**
   * @param {string} kind
   * @param {{handler: (value: string, key: string) => unknown, ordered: boolean, limit: number | (() => number), retry: [number, number], deadlineMs: number}} registration
   * @param {EffectRow} row
   * @param {{kind: string, picked: number, done: number, deferred: number, failed: number}} report
   */
  async #attempt(kind, registration, row, report) {
    const id = this.#id(kind, row.key);
    this.#inflight.set(id, kind);
    try {
      const guard = { seq: row.seq, generation: row.generation };
      const [base] = registration.retry;

      // The handler result is mapped to a value object, never a rejection, so
      // a handler that fails after its deadline cannot become an unhandled
      // rejection.
      /** @type {Promise<{ok: true, value: unknown} | {ok: false, error: unknown}>} */
      const work = /** @type {any} */ (
        Promise.resolve()
          .then(() => registration.handler(row.value, row.key))
          .then(
            (value) => ({ ok: true, value }),
            (error) => ({ ok: false, error }),
          )
      );

      /** @type {{ok: boolean, value?: unknown, error?: unknown, deadline?: boolean}} */
      let result;
      /** @type {(() => void) | undefined} */
      let cancel;
      if (registration.deadlineMs > 0) {
        /** @type {Promise<{ok: false, deadline: true, error: Error}>} */
        const timeout = new Promise((resolve) => {
          cancel = this.#timers.start(registration.deadlineMs, () =>
            resolve({
              ok: false,
              deadline: true,
              error: new Error(`effect attempt exceeded its ${registration.deadlineMs}ms deadline`),
            }),
          );
        });
        result = await Promise.race([work, timeout]);
        if (cancel) cancel();
      } else {
        result = await work;
      }
      report.picked += 1;

      if (result.ok) {
        if (result.value === Later) {
          // Deferral is not a failure: attempts are untouched, position kept.
          this.#store.reschedule(kind, row.key, guard, this.#now() + base, row.attempts, row.error);
          report.deferred += 1;
        } else {
          // A payload replaced while the handler ran carries a newer
          // generation, so this delete is a no-op instead of data loss.
          this.#store.drop(kind, row.key, guard);
          report.done += 1;
        }
        return;
      }

      const attempts = row.attempts + 1;
      const delay = this.#backoff(registration, row.attempts);
      const error = result.deadline
        ? /** @type {Error} */ (result.error).message
        : String(result.error).slice(0, 1000);
      // A deadline fails the attempt while the handler keeps running. The
      // abandoned handler holds no guard, so it can neither delete the row nor
      // overwrite the retry it is racing with.
      this.#store.reschedule(kind, row.key, guard, this.#now() + delay, attempts, error);
      report.failed += 1;
      this.#report({ type: 'failed', kind, key: row.key, attempts, error: result.error });

      if (result.deadline) {
        work.then((late) => {
          if (!late.ok) this.#report({ type: 'abandoned', kind, key: row.key, error: late.error });
        });
      }
    } finally {
      this.#inflight.delete(id);
    }
  }
}
