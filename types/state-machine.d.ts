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
export function nextState<S extends string, C extends string>(table: TransitionTable<S, C>, from: S, command: C): S;
/**
 * @template {string} S
 * @template {string} C
 * @param {TransitionTable<S, C>} table
 * @param {S} from
 * @param {C} command
 * @returns {boolean}
 */
export function canTransition<S extends string, C extends string>(table: TransitionTable<S, C>, from: S, command: C): boolean;
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
export function commandsFrom<S extends string, C extends string>(table: TransitionTable<S, C>, from: S): C[];
/**
 * Small wrapper that holds the current state. `send` either returns the next
 * state or throws `IllegalTransition` and leaves the state untouched.
 *
 * @template {string} S
 * @template {string} C
 * @param {TransitionTable<S, C>} table
 * @param {S} initial
 */
export function createMachine<S extends string, C extends string>(table: TransitionTable<S, C>, initial: S): {
    readonly state: S;
    /** @param {C} command @returns {boolean} */
    can(command: C): boolean;
    /** @param {C} command @returns {S} */
    send(command: C): S;
};
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
    constructor(from: string, command: string);
    from: string;
    command: string;
}
export type TransitionTable<S extends string, C extends string> = Partial<Record<S, Partial<Record<C, S>>>>;
