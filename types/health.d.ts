/**
 * One component's health slot. Only the object returned by
 * `HealthBoard.claim` may write it, and it stops writing once released: a
 * retired component must not keep overwriting a name that has been reclaimed.
 */
export class HealthEntry {
    /**
     * @param {string} name
     * @param {HealthState} initial
     * @param {() => number} now
     * @param {(entry: HealthEntry) => void} detach
     */
    constructor(name: string, initial: HealthState, now: () => number, detach: (entry: HealthEntry) => void);
    name: string;
    /** @returns {HealthSnapshot} a copy: callers cannot mutate the board's state */
    get(): HealthSnapshot;
    /**
     * @param {HealthState} state
     * @param {string} [detail]
     */
    set(state: HealthState, detail?: string): void;
    get live(): boolean;
    /** Unregisters the entry. Idempotent. */
    release(): void;
    #private;
}
/**
 * Single-writer registry of component health. Every name is owned by exactly
 * one claimant; a second claim throws, because two writers on one name is a
 * wiring bug that would otherwise show up as flapping status.
 */
export class HealthBoard {
    /**
     * @param {{now?: () => number}} [options]
     */
    constructor(options?: {
        now?: () => number;
    });
    /**
     * @param {string} name
     * @param {HealthState} [initial]
     * @returns {HealthEntry}
     */
    claim(name: string, initial?: HealthState): HealthEntry;
    /** @param {string} name @returns {HealthSnapshot | undefined} */
    get(name: string): HealthSnapshot | undefined;
    /** @returns {Record<string, HealthSnapshot>} */
    snapshot(): Record<string, HealthSnapshot>;
    #private;
}
export type HealthState = "ready" | "degraded" | "error";
export type HealthSnapshot = {
    state: HealthState;
    detail: string;
    at: number;
};
