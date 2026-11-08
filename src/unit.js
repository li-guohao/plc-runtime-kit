// Behaviour derived from dsh-superagent `src/app/store.ts:140-162` (MIT).
// Rewritten against a driver port; see NOTICE. No upstream lines were copied.

/**
 * A savepoint-capable database handle. `createUnit` only calls these three
 * methods, so SQLite, Postgres, an in-memory journal, or a test double all fit.
 *
 * @typedef {object} TransactionDriver
 * @property {(name: string) => void} savepoint  opens a named savepoint
 * @property {(name: string) => void} release    commits (releases) that savepoint
 * @property {(name: string) => void} rollbackTo rolls back to it
 */

/**
 * Diagnostic callback. An `afterCommitError` never fails the committed unit:
 * by the time it fires the data is already durable.
 *
 * @typedef {object} UnitEvent
 * @property {'commit' | 'rollback' | 'afterCommitError'} kind
 * @property {number} depth  nesting depth the event belongs to (0 = outermost)
 * @property {unknown} [error]
 */

/**
 * @typedef {object} Unit
 * @property {<T>(operation: () => T) => T} atomic
 * @property {(action: () => void) => void} afterCommit
 * @property {number} depth
 */

/**
 * Builds a unit-of-work helper over any savepoint-capable driver.
 *
 * Semantics (all covered by tests):
 * - `atomic(op)` opens a savepoint, runs `op` synchronously, releases on
 *   success and rolls back to that savepoint on failure. Nesting is allowed.
 * - `afterCommit(action)` inside a unit defers the action until the outermost
 *   commit; an inner level that rolls back discards its actions, and a level
 *   that commits hands them to its parent. Outside a unit it runs immediately.
 * - After-commit actions run after the data is committed, so a throwing action
 *   is reported through `report` and never rolls anything back. One failing
 *   action does not stop the others.
 *
 * @param {TransactionDriver} driver
 * @param {(event: UnitEvent) => void} [report]
 * @returns {Unit}
 */
export function createUnit(driver, report = () => {}) {
  if (
    driver === null ||
    typeof driver !== 'object' ||
    typeof driver.savepoint !== 'function' ||
    typeof driver.release !== 'function' ||
    typeof driver.rollbackTo !== 'function'
  ) {
    throw new TypeError('createUnit needs a driver with savepoint(), release() and rollbackTo()');
  }
  if (typeof report !== 'function') throw new TypeError('createUnit needs report to be a function');

  let nextName = 0;
  /** One callback list per open level; index 0 is the outermost level. @type {Array<Array<() => void>>} */
  const pending = [];

  /**
   * Runs deferred actions, reporting each failure instead of aborting the rest.
   *
   * @param {Array<() => void>} actions
   * @param {number} depth
   */
  function runAfterCommit(actions, depth) {
    for (const action of actions) {
      try {
        action();
      } catch (error) {
        report({ kind: 'afterCommitError', depth, error });
      }
    }
  }

  return {
    get depth() {
      return pending.length;
    },

    /**
     * @template T
     * @param {() => T} operation
     * @returns {T}
     */
    atomic(operation) {
      if (typeof operation !== 'function') throw new TypeError('unit.atomic needs a function');

      const depth = pending.length;
      const name = `unit_${nextName++}`;
      /** @type {Array<() => void>} */
      const actions = [];
      pending.push(actions);
      driver.savepoint(name);

      let value;
      try {
        value = operation();
        driver.release(name);
      } catch (error) {
        pending.pop();
        // The original failure is the root cause; a driver failure while
        // rolling back is worse (the transaction state is unknown), so it wins.
        let failure = error;
        try {
          driver.rollbackTo(name);
        } catch (rollbackError) {
          failure = rollbackError;
        }
        try {
          driver.release(name);
        } catch (releaseError) {
          if (failure === error) failure = releaseError;
        }
        report({ kind: 'rollback', depth, error: failure });
        throw failure;
      }

      pending.pop();
      if (depth > 0) {
        // Committed at an inner level: the actions still wait for the parent,
        // which may itself roll back later.
        pending[depth - 1].push(...actions);
      } else {
        runAfterCommit(actions, 0);
      }
      report({ kind: 'commit', depth });
      return value;
    },

    /**
     * @param {() => void} action
     */
    afterCommit(action) {
      if (typeof action !== 'function') throw new TypeError('unit.afterCommit needs a function');
      if (pending.length === 0) {
        action();
        return;
      }
      pending[pending.length - 1].push(action);
    },
  };
}

/**
 * One pass over a list of work steps: every step is its own transaction, and
 * the pass stops at the first failure. Units committed earlier in the pass stay
 * committed, and the failed step leaves no partial state behind. The caller
 * runs the pass again later, which is what "a crash point is resumed by the
 * next tick" means in practice.
 *
 * @param {Unit} unit
 * @param {Iterable<() => void>} steps
 * @returns {{committed: number, error?: unknown}}
 */
export function runPass(unit, steps) {
  if (unit === null || typeof unit !== 'object' || typeof unit.atomic !== 'function') {
    throw new TypeError('runPass needs a unit built by createUnit');
  }
  if (steps === null || typeof steps !== 'object' || typeof steps[Symbol.iterator] !== 'function') {
    throw new TypeError('runPass needs an iterable of step functions');
  }

  let committed = 0;
  for (const step of steps) {
    if (typeof step !== 'function') throw new TypeError('runPass steps must be functions');
    try {
      unit.atomic(step);
      committed += 1;
    } catch (error) {
      return { committed, error };
    }
  }
  return { committed };
}
