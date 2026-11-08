// Behaviour derived from dsh-superagent `src/infra/health.ts:1-35` (MIT).
// Rewritten; see NOTICE. No upstream lines were copied.

/**
 * @typedef {'ready' | 'degraded' | 'error'} HealthState
 * @typedef {{state: HealthState, detail: string, at: number}} HealthSnapshot
 */

const STATES = new Set(['ready', 'degraded', 'error']);

/**
 * One component's health slot. Only the object returned by
 * `HealthBoard.claim` may write it, and it stops writing once released: a
 * retired component must not keep overwriting a name that has been reclaimed.
 */
export class HealthEntry {
  #snapshot;
  #now;
  #detach;
  #live = true;

  /**
   * @param {string} name
   * @param {HealthState} initial
   * @param {() => number} now
   * @param {(entry: HealthEntry) => void} detach
   */
  constructor(name, initial, now, detach) {
    this.name = name;
    this.#now = now;
    this.#detach = detach;
    this.#snapshot = { state: initial, detail: '', at: now() };
  }

  /** @returns {HealthSnapshot} a copy: callers cannot mutate the board's state */
  get() {
    return { ...this.#snapshot };
  }

  /**
   * @param {HealthState} state
   * @param {string} [detail]
   */
  set(state, detail = '') {
    if (!STATES.has(state)) throw new TypeError(`unknown health state "${String(state)}"`);
    if (typeof detail !== 'string') throw new TypeError('health detail must be a string');
    // A released entry belongs to a retired component. Late writes are dropped
    // rather than thrown: the write path must not fail because of teardown.
    if (!this.#live) return;
    this.#snapshot = { state, detail, at: this.#now() };
  }

  get live() {
    return this.#live;
  }

  /** Unregisters the entry. Idempotent. */
  release() {
    if (!this.#live) return;
    this.#live = false;
    this.#detach(this);
  }
}

/**
 * Single-writer registry of component health. Every name is owned by exactly
 * one claimant; a second claim throws, because two writers on one name is a
 * wiring bug that would otherwise show up as flapping status.
 */
export class HealthBoard {
  #entries = new Map();
  #now;

  /**
   * @param {{now?: () => number}} [options]
   */
  constructor(options = {}) {
    if (options === null || typeof options !== 'object') {
      throw new TypeError('HealthBoard options must be an object');
    }
    const now = options.now ?? Date.now;
    if (typeof now !== 'function') throw new TypeError('HealthBoard needs now to be a function');
    this.#now = now;
  }

  /**
   * @param {string} name
   * @param {HealthState} [initial]
   * @returns {HealthEntry}
   */
  claim(name, initial = 'ready') {
    if (typeof name !== 'string' || name.trim() === '') {
      throw new TypeError('health entry names must be non-empty strings');
    }
    if (!STATES.has(initial)) throw new TypeError(`unknown health state "${String(initial)}"`);
    if (this.#entries.has(name)) throw new Error(`health entry "${name}" is already claimed`);

    const entry = new HealthEntry(name, initial, this.#now, (released) => {
      // Only the current holder may detach the name, so a stale release cannot
      // evict a newer claimant.
      if (this.#entries.get(name) === released) this.#entries.delete(name);
    });
    this.#entries.set(name, entry);
    return entry;
  }

  /** @param {string} name @returns {HealthSnapshot | undefined} */
  get(name) {
    return this.#entries.get(name)?.get();
  }

  /** @returns {Record<string, HealthSnapshot>} */
  snapshot() {
    /** @type {Record<string, HealthSnapshot>} */
    const out = {};
    for (const [name, entry] of this.#entries) out[name] = entry.get();
    return out;
  }
}
