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
export function createUnit(driver: TransactionDriver, report?: (event: UnitEvent) => void): Unit;
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
export function runPass(unit: Unit, steps: Iterable<() => void>): {
    committed: number;
    error?: unknown;
};
/**
 * A savepoint-capable database handle. `createUnit` only calls these three
 * methods, so SQLite, Postgres, an in-memory journal, or a test double all fit.
 */
export type TransactionDriver = {
    /**
     * opens a named savepoint
     */
    savepoint: (name: string) => void;
    /**
     * commits (releases) that savepoint
     */
    release: (name: string) => void;
    /**
     * rolls back to it
     */
    rollbackTo: (name: string) => void;
};
/**
 * Diagnostic callback. An `afterCommitError` never fails the committed unit:
 * by the time it fires the data is already durable.
 */
export type UnitEvent = {
    kind: "commit" | "rollback" | "afterCommitError";
    /**
     * nesting depth the event belongs to (0 = outermost)
     */
    depth: number;
    error?: unknown;
};
export type Unit = {
    atomic: <T>(operation: () => T) => T;
    afterCommit: (action: () => void) => void;
    depth: number;
};
