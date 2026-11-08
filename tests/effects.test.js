import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EffectQueue, Later } from '../src/effects.js';
import { MemoryEffectStore } from '../src/memory.js';

function setup(options = {}) {
  const store = new MemoryEffectStore();
  let clock = 1000;
  const queue = new EffectQueue(store, { now: () => clock, ...options });
  return {
    store,
    queue,
    advance(ms) {
      clock += ms;
    },
    now() {
      return clock;
    },
  };
}

/** Deterministic timer double: nothing fires until `flush()` is called. */
function manualTimers() {
  const tasks = [];
  return {
    timers: {
      start(ms, fire) {
        const task = { ms, fire, cancelled: false };
        tasks.push(task);
        return () => {
          task.cancelled = true;
        };
      },
    },
    flush() {
      for (const task of tasks.splice(0)) if (!task.cancelled) task.fire();
    },
  };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test('re-enqueueing the same key keeps its position and bumps the generation', () => {
  const { store } = setup();
  store.upsert('mail', 'k1', 'v1', 1000);
  const first = store.oldest('mail');

  store.upsert('mail', 'k1', 'v2', 1200);
  const second = store.oldest('mail');

  assert.equal(second.seq, first.seq, 'queue position is preserved');
  assert.equal(second.generation, first.generation + 1);
  assert.equal(second.value, 'v2');
  assert.equal(second.due, 1200);
  assert.equal(second.attempts, 0, 'a new payload gets a fresh failure budget');
});

test('a pass runs due rows and removes completed ones', async () => {
  const { store, queue } = setup();
  const seen = [];
  queue.register('mail', (value, key) => {
    seen.push([key, value]);
  });
  store.upsert('mail', 'k1', 'v1', 1000);

  const reports = await queue.run();

  assert.deepEqual(seen, [['k1', 'v1']]);
  assert.equal(store.has('mail'), false);
  assert.deepEqual(reports, [{ kind: 'mail', picked: 1, done: 1, deferred: 0, failed: 0 }]);
});

test('rows that are not due yet stay put', async () => {
  const { store, queue, advance, now } = setup();
  const seen = [];
  queue.register('mail', (value) => seen.push(value));
  store.upsert('mail', 'k1', 'v1', now() + 5000);

  await queue.run();
  assert.deepEqual(seen, []);
  assert.equal(store.has('mail', 'k1'), true);

  advance(5000);
  await queue.run();
  assert.deepEqual(seen, ['v1']);
});

test('ordered kinds block behind a failing head', async () => {
  const { store, queue, advance, now } = setup();
  const processed = [];
  let failuresLeft = 2;
  queue.register(
    'mail',
    (value) => {
      if (value === 'v1' && failuresLeft-- > 0) throw new Error('head failed');
      processed.push(value);
    },
    { ordered: true },
  );
  store.upsert('mail', 'k1', 'v1', 1000);
  store.upsert('mail', 'k2', 'v2', 1000);
  store.upsert('mail', 'k3', 'v3', 1000);

  let reports = await queue.run();
  assert.deepEqual(reports[0], { kind: 'mail', picked: 1, done: 0, deferred: 0, failed: 1 });
  assert.equal(store.has('mail', 'k3'), true);

  // Jump to each row's own due time: backoff doubles after every failure.
  for (let pass = 0; pass < 6 && processed.length < 3; pass += 1) {
    const head = store.oldest('mail');
    advance(head.due - now());
    await queue.run();
  }

  assert.deepEqual(processed, ['v1', 'v2', 'v3'], 'later rows waited for the head, then ran in order');
  assert.equal(store.has('mail'), false);
});

test('unordered kinds run up to the concurrency limit per pass', async () => {
  const { store, queue } = setup();
  const seen = [];
  queue.register('mail', (value) => seen.push(value), { limit: 2 });
  store.upsert('mail', 'k1', 'v1', 1000);
  store.upsert('mail', 'k2', 'v2', 1000);
  store.upsert('mail', 'k3', 'v3', 1000);

  const first = await queue.run();
  assert.equal(first[0].done, 2);
  assert.deepEqual(seen, ['v1', 'v2']);
  assert.equal(store.has('mail', 'k3'), true);

  const second = await queue.run();
  assert.equal(second[0].done, 1);
  assert.deepEqual(seen, ['v1', 'v2', 'v3']);
});

test('Later defers without counting an attempt', async () => {
  const { store, queue, advance } = setup();
  queue.register('mail', () => Later, { retry: [100, 500] });
  store.upsert('mail', 'k1', 'v1', 1000);

  const reports = await queue.run();
  assert.deepEqual(reports[0], { kind: 'mail', picked: 1, done: 0, deferred: 1, failed: 0 });

  const row = store.oldest('mail');
  assert.equal(row.attempts, 0);
  assert.equal(row.due, 1100);
  assert.equal(store.has('mail', 'k1'), true);

  advance(100);
  await queue.run();
  assert.equal(store.oldest('mail').attempts, 0, 'deferrals still do not count');
});

test('failures back off exponentially up to the cap', async () => {
  const { store, queue, advance, now } = setup();
  queue.register(
    'mail',
    () => {
      throw new Error('kaboom');
    },
    { retry: [100, 400] },
  );
  store.upsert('mail', 'k1', 'v1', 1000);

  const failures = [];
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    await queue.run();
    const row = store.oldest('mail');
    assert.equal(row.attempts, attempt);
    assert.equal(row.error, 'Error: kaboom');
    failures.push(row.due - now());
    advance(row.due - now());
  }

  assert.deepEqual(failures, [100, 200, 400, 400], 'delay doubles until it hits the cap');
});

test('an attempt deadline fails the row while the abandoned handler keeps running', async () => {
  const manual = manualTimers();
  const { store, queue } = setup({ timers: manual.timers });
  let release;
  queue.register('mail', () => new Promise((resolve) => { release = resolve; }), { deadlineMs: 50 });
  store.upsert('mail', 'k1', 'v1', 1000);

  const running = queue.run();
  await settle();
  manual.flush();
  const reports = await running;

  assert.equal(reports[0].failed, 1);
  const row = store.oldest('mail');
  assert.equal(row.attempts, 1);
  assert.match(row.error, /exceeded its 50ms deadline/);
  assert.equal(store.has('mail', 'k1'), true, 'the row is retried, not dropped');

  release('late success');
  await settle();
  assert.equal(store.oldest('mail').attempts, 1, 'the abandoned handler cannot mutate the row');
  assert.equal(store.has('mail', 'k1'), true);
});

test('an abandoned handler that later fails is reported, not swallowed', async () => {
  const events = [];
  const manual = manualTimers();
  const { store, queue } = setup({ timers: manual.timers, report: (event) => events.push(event) });
  let reject;
  queue.register('mail', () => new Promise((_resolve, rejectLate) => { reject = rejectLate; }), { deadlineMs: 50 });
  store.upsert('mail', 'k1', 'v1', 1000);

  const running = queue.run();
  await settle();
  manual.flush();
  await running;

  reject(new Error('late boom'));
  await settle();

  const abandoned = events.filter((event) => event.type === 'abandoned');
  assert.equal(abandoned.length, 1);
  assert.match(String(abandoned[0].error), /late boom/);
  assert.equal(events.filter((event) => event.type === 'failed').length, 1);
});

test('a stale guard cannot delete a newer payload', () => {
  const { store } = setup();
  store.upsert('mail', 'k1', 'v1', 1000);
  const row = store.oldest('mail');
  const guard = { seq: row.seq, generation: row.generation };

  store.upsert('mail', 'k1', 'v2', 1000);
  store.drop('mail', 'k1', guard);

  assert.equal(store.has('mail', 'k1'), true);
  const current = store.oldest('mail');
  assert.equal(current.value, 'v2');
  assert.equal(current.generation, guard.generation + 1);
});

test('kind isolation, summaries and argument validation', async () => {
  const { store, queue } = setup({ report: () => {} });
  store.upsert('alpha', 'k1', 'v1', 1000);
  store.upsert('beta', 'k1', 'v1', 1000);

  assert.deepEqual(store.summary('alpha'), {
    waiting: 1,
    oldestSince: 1000,
    oldestDue: 1000,
    maxAttempts: 0,
    lastError: null,
  });

  let ran = 0;
  queue.register('alpha', () => {
    ran += 1;
  });
  await queue.run();

  assert.equal(ran, 1);
  assert.equal(store.has('beta', 'k1'), true, 'a kind without a handler is untouched');

  assert.throws(() => queue.register('alpha', () => {}), /already have a handler/);
  assert.throws(() => queue.enqueue('alpha', '', 'v'), /key/);
  assert.throws(() => queue.enqueue('alpha', 'k', 42), /string/);
  assert.throws(() => new EffectQueue({}), /missing/);
  assert.throws(() => queue.register('gamma', () => {}, { retry: [500, 100] }), /retry/);
});
