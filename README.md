# plc-runtime-kit

> **Reference implementation, not a production dependency.** This repo shows
> *how* the runtime properties below can be built in roughly a thousand lines
> of dependency-free JavaScript. It has no users, no production endorsement and
> no long-term owner. Read it, copy it, argue with it — do not put money,
> mail or migrations on top of it and call it durable.
>
> **It is not an industrial PLC and not a PLC-compatibility library.** There is
> no ladder logic, no IEC 61131 runtime, no fieldbus, no scan-cycle scheduler.
> The name borrows four properties only: bounded passes, enumerable state, an
> explicit commit boundary, idempotent effects.

Four small runtime primitives for long-running Node services that must survive
crashes without losing or duplicating work:

- **units of work** — one savepoint transaction per unit, post-commit callbacks,
  and a pass runner that stops at the first failure but keeps what already
  committed;
- **a durable effect queue** — `(kind, key)` idempotency, queue order, a
  generation guard, per-kind concurrency, `Later`, capped backoff, and a
  per-attempt deadline that fails a row while an uncancellable handler keeps
  running;
- **a single-writer health board** — one claimant per component name, snapshot
  reads, late writes dropped;
- **an explicit transition table** — `(state, command) -> state`, with
  `IllegalTransition` for everything that is not in the table.

Zero runtime dependencies. Plain ESM JavaScript with JSDoc types, so it runs on
Node without a build step and can be consumed from `node_modules` (Node's type
stripping does **not** apply inside `node_modules`, which is why this is `.js`
rather than `.ts`).

Status: **0.1.0, reference implementation**. GitHub only — not published to
npm. Tests: 42/42. Node >= 20 (the SQLite adapter needs >= 22.5).

## Why

A service that runs a "tick" over work items has two failure modes that look
different but are the same bug:

1. a tick writes several things in one transaction, one write fails, and the
   whole tick is rolled back — including work that was already correct;
2. a tick writes side effects (send a mail, call a model) inline, the process
   dies, and after restart the side effect is either lost or repeated.

This kit makes the unit of work explicit (`runPass` + `createUnit`), and makes
side effects rows that commit atomically with the state change and are
dispatched afterwards (`EffectQueue`). The rest of the box is the paperwork
needed to observe and reject: health and transitions.

## The six properties

The design this was extracted from claims six runtime properties. What this
package actually delivers:

| # | Property | Status | Where |
|---|---|---|---|
| 1 | One transaction per unit of work; a pass is not one transaction | **implemented** | `createUnit`, `runPass` |
| 2 | Idempotency keys: same `(kind, key)` coalesces, keeps position, bumps generation | **implemented** | `EffectQueue.enqueue`, store ports |
| 3 | Attempt-level deadline; the abandoned handler cannot corrupt the row | **implemented** | `register(..., { deadlineMs })` |
| 4 | Explicit transition table; illegal transitions rejected by type | **implemented (new code)** | `state-machine.js` |
| 5 | Single-writer health snapshot | **partially implemented** — the board is here; the status/event code registry is not | `HealthBoard` |
| 6 | Crash resume and half-cold-start redelivery | **partial** — rows survive and are picked up by the next `run()`, but redelivering domain cards and rebuilding in-memory read caches are application logic | `sqlite.js` + `run()` |

Not implemented on purpose: the status/event code registry (it is domain
vocabulary — "assessing", "maildrop" — that solves no generic caller problem),
card redelivery, and agent-session rehydration.

## What is missing before this could be a production dependency

The gap is not "polish". Each item below changes the correctness story, not just
the ergonomics:

1. **A Postgres outbox adapter.** Only `node:sqlite` and an in-memory driver
   ship here. A real service needs a row-locked Postgres port, and the port
   contracts have not been exercised against one.
2. **A formal at-least-once + idempotency argument with failure injection.**
   There is a design intent (enqueue in the same transaction, dispatch after
   commit, guard every mutation) and unit tests, but no fault-injection suite
   covering crash between commit and dispatch, crash mid-attempt, two dispatchers
   racing, or a clock jump during backoff.
3. **Metrics and trace hooks.** The queue reports events through one callback.
   There are no spans, timers, backlog gauges, or dead-letter counters — an
   operator cannot see this system from the outside.
4. **An owner and a security process.** Nobody is on call for this repo, and
   there is no vulnerability disclosure path.
5. **Production endorsement.** No company runs this. The only users are its
   own tests.

If you need these guarantees today, use a transactional outbox built into your
database (or a mature queue) and treat this repo as a readable model of the
mechanism.

## Installation

Not on npm. Clone the repo, or install it as a Git dependency:

```sh
npm install "github:li-guohao/plc-runtime-kit"
```

The package is ESM-only, has zero runtime dependencies, and ships generated
`.d.ts` declarations next to the `.js` sources.

## Modules

| File | What it is |
|---|---|
| `src/unit.js` | `createUnit(driver, report?)`, `runPass(unit, steps)` |
| `src/effects.js` | `EffectQueue`, `Later`, `systemTimers`, store port contract |
| `src/health.js` | `HealthBoard`, `HealthEntry` |
| `src/state-machine.js` | `nextState`, `canTransition`, `commandsFrom`, `createMachine`, `IllegalTransition` |
| `src/memory.js` | snapshot-based `MemoryDriver`, `MemoryEffectStore`, `createMemoryRuntime()` |
| `src/sqlite.js` | `openSqlite(path)`, `SqliteTransactionDriver`, `SqliteEffectStore` (subpath export) |

## Quickstart (in memory)

```js
import { createMemoryRuntime, EffectQueue } from 'plc-runtime-kit';

const { store, unit } = createMemoryRuntime();
const queue = new EffectQueue(store, { now: () => Date.now() });
queue.register('mail', async (value) => {
  await send(JSON.parse(value)); // must be idempotent, or guard on your side
});

// The write and its effect commit together, or neither does.
unit.atomic(() => {
  store.upsert('mail', 'order-42', JSON.stringify({ to: 'ops@example.com' }), Date.now());
});

// Dispatch after commit. A crash before this call loses nothing:
// the row is still there, and the next process resumes it.
await queue.run();
```

## Quickstart (SQLite)

```js
import { createUnit } from 'plc-runtime-kit';
import { openSqlite } from 'plc-runtime-kit/sqlite';

const { db, driver, store } = openSqlite('./runtime.db');
const unit = createUnit(driver);
// EffectQueue(store, ...) as above.
db.close();
```

`node:sqlite` requires Node >= 22.5. The core has no version-specific imports
and runs on Node >= 20 with `node --test`.

## Semantics worth knowing

- **A pass is not a transaction.** `runPass` runs each step in its own
  savepoint. A failing step rolls back only that step; earlier units stay
  committed and later steps are not attempted. The next pass resumes.
- **`afterCommit` fires after the outermost commit**, never before. Callbacks
  from a rolled-back level are discarded. A callback that throws is reported
  through `report` and does not roll back data that is already durable.
- **`(kind, key)` is the idempotency key.** Re-enqueueing while a row is
  waiting replaces the payload, keeps `seq`, bumps `generation`, and resets the
  failure budget.
- **The guard is `{seq, generation}`.** An attempt may only delete or reschedule
  the exact row it picked. A payload replaced while the handler ran survives.
- **Ordered kinds block behind their oldest row**, even when that row is not
  due. `limit` is per kind; `ordered` forces one at a time.
- **`deadlineMs` fails the attempt, not the handler.** The handler cannot be
  cancelled; it keeps running without a guard, so it cannot delete the row or
  overwrite the retry. A late failure is reported as `abandoned`.
- **`Later` is not a failure.** The row is deferred by the base retry delay and
  keeps its attempt count.
- **Health has one writer per name.** A second `claim` configures a bug and
  throws. A released entry's writes are dropped instead of throwing.
- **A missing transition rule is illegal.** Self-loops must be written
  explicitly; there is no "unknown commands are ignored" mode.

## Tests

42 tests, run with Node's built-in runner:

```sh
node --test
```

Coverage includes nested savepoint rollback, after-commit ordering and error
isolation, merge-on-re-enqueue, ordered head blocking, deadline vs. abandoned
handler, backoff cap, stale-guard protection, SQLite close/reopen resume,
health ownership, and transition rejection.

## What stays behind

This is a rewrite, not a port of an internal agent runtime. Deliberately absent:
the agent pass itself (work-item loops, assessors, sessions), the DSH settings
and policy layers, the Cordis plugin context, the status/event code vocabulary,
card redelivery, and every tool registration. Those depend on the host
application and would drag it along.

## Provenance and license

MIT. See [LICENSE](./LICENSE).

Behaviour in `unit.js`, `effects.js`, and `health.js` is derived from the
`dsh-superagent` prototype (`src/app/store.ts:140-162`, `src/app/effects.ts:64-166`,
`src/infra/health.ts:1-35`), Copyright (c) 2026 DeepSeek Harness Team, MIT.
Those modules were rewritten against ports; no upstream lines were copied.
`state-machine.js`, `memory.js`, `sqlite.js`, and the tests are new. Per-file
detail is in [NOTICE](./NOTICE).
