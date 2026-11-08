// New code, no upstream counterpart: dsh-superagent has no explicit
// (state, command) -> state table (see NOTICE).

/**
 * Thrown when a command has no rule for the current state. Keeping this a
 * distinct class lets callers tell "the caller sent a bad command" apart from
 * "the store failed".
 */
export class IllegalTransition extends Error {
  /**
   * @param {string} from
   * @param {string} command
   */
  constructor(from, command) {
    super(`illegal transition: no rule for "${command}" in state "${from}"`);
    this.name = 'IllegalTransition';
    this.from = from;
    this.command = command;
  }
}

/**
 * @template {string} S
 * @template {string} C
 * @typedef {Partial<Record<S, Partial<Record<C, S>>>>} TransitionTable
 */

/**
 * Resolves the next state, or throws `IllegalTransition`. A self-loop must be
 * written explicitly (`{running: {heartbeat: 'running'}}`); absence of a rule
 * always means "not allowed", never "stay put".
 *
 * @template {string} S
 * @template {string} C
 * @param {TransitionTable<S, C>} table
 * @param {S} from
 * @param {C} command
 * @returns {S}
 */
export function nextState(table, from, command) {
  if (table === null || typeof table !== 'object') {
    throw new TypeError('nextState needs a transition table object');
  }
  const rules = table[from];
  if (rules === undefined || !Object.hasOwn(rules, command) || typeof rules[command] !== 'string') {
    throw new IllegalTransition(from, command);
  }
  return /** @type {S} */ (rules[command]);
}

/**
 * @template {string} S
 * @template {string} C
 * @param {TransitionTable<S, C>} table
 * @param {S} from
 * @param {C} command
 * @returns {boolean}
 */
export function canTransition(table, from, command) {
  if (table === null || typeof table !== 'object') return false;
  const rules = table[from];
  return rules !== undefined && Object.hasOwn(rules, command) && typeof rules[command] === 'string';
}

/**
 * Commands that are legal in `from`, sorted so the result is stable for
 * diagnostics and tests.
 *
 * @template {string} S
 * @template {string} C
 * @param {TransitionTable<S, C>} table
 * @param {S} from
 * @returns {C[]}
 */
export function commandsFrom(table, from) {
  if (table === null || typeof table !== 'object') return [];
  const rules = table[from];
  if (rules === undefined) return [];
  return /** @type {C[]} */ (Object.keys(rules).sort());
}

/**
 * Small wrapper that holds the current state. `send` either returns the next
 * state or throws `IllegalTransition` and leaves the state untouched.
 *
 * @template {string} S
 * @template {string} C
 * @param {TransitionTable<S, C>} table
 * @param {S} initial
 */
export function createMachine(table, initial) {
  if (typeof initial !== 'string') throw new TypeError('createMachine needs an initial state string');
  /** @type {S} */
  let state = initial;
  return {
    get state() {
      return state;
    },
    /** @param {C} command @returns {boolean} */
    can(command) {
      return canTransition(table, state, command);
    },
    /** @param {C} command @returns {S} */
    send(command) {
      const next = nextState(table, state, command);
      state = next;
      return next;
    },
  };
}
