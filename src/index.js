// Public entry point. SQLite lives on the `plc-runtime-kit/sqlite` subpath so
// importing the core never touches `node:sqlite`.

export { createUnit, runPass } from './unit.js';
export { EffectQueue, Later, systemTimers } from './effects.js';
export { HealthBoard, HealthEntry } from './health.js';
export { IllegalTransition, canTransition, commandsFrom, createMachine, nextState } from './state-machine.js';
export { MemoryDriver, MemoryEffectStore, createMemoryRuntime } from './memory.js';

// Type-only re-exports. JSDoc typedefs emit as `export type` in the generated
// declarations, so a TypeScript consumer can name the ports it implements
// without reaching into the internal module layout. Nothing here exists at
// runtime, and the package stays dependency-free.
/**
 * @typedef {import('./unit.js').TransactionDriver} TransactionDriver
 * @typedef {import('./unit.js').UnitEvent} UnitEvent
 * @typedef {import('./unit.js').Unit} Unit
 * @typedef {import('./effects.js').EffectStore} EffectStore
 * @typedef {import('./effects.js').EffectRow} EffectRow
 * @typedef {import('./effects.js').EffectEvent} EffectEvent
 * @typedef {import('./effects.js').Registration} Registration
 * @typedef {import('./effects.js').Timers} Timers
 * @typedef {import('./health.js').HealthSnapshot} HealthSnapshot
 */
