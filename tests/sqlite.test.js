import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EffectQueue } from '../src/effects.js';
import { assertSqliteAvailable, openSqlite } from '../src/sqlite.js';
import { createUnit } from '../src/unit.js';

test('a committed unit survives a close and reopen; the queue resumes it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'plc-runtime-kit-'));
  const file = join(dir, 'runtime.db');
  try {
    let handle = openSqlite(file);
    createUnit(handle.driver).atomic(() => handle.store.upsert('mail', 'k1', 'v1', 1000));
    handle.db.close();

    handle = openSqlite(file);
    const queue = new EffectQueue(handle.store, { now: () => 2000 });
    const seen = [];
    queue.register('mail', (value, key) => seen.push([key, value]));

    const reports = await queue.run();
    assert.deepEqual(seen, [['k1', 'v1']]);
    assert.deepEqual(reports, [{ kind: 'mail', picked: 1, done: 1, deferred: 0, failed: 0 }]);
    assert.equal(handle.store.has('mail'), false);
    handle.db.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a rolled-back unit leaves no effect row in sqlite', () => {
  const { db, driver, store } = openSqlite(':memory:');
  const unit = createUnit(driver);
  try {
    assert.throws(
      () =>
        unit.atomic(() => {
          store.upsert('mail', 'k1', 'v1', 1000);
          throw new Error('rolled back');
        }),
      /rolled back/,
    );
    assert.equal(store.has('mail'), false);
  } finally {
    db.close();
  }
});

test('nested savepoints roll back only the inner level', () => {
  const { db, driver, store } = openSqlite(':memory:');
  const unit = createUnit(driver);
  try {
    unit.atomic(() => {
      store.upsert('mail', 'outer', 'O', 1000);
      assert.throws(
        () =>
          unit.atomic(() => {
            store.upsert('mail', 'inner', 'I', 1000);
            throw new Error('inner failed');
          }),
        /inner failed/,
      );
      assert.equal(store.has('mail', 'inner'), false);
      assert.equal(store.has('mail', 'outer'), true);
    });
    assert.equal(store.has('mail', 'outer'), true);
  } finally {
    db.close();
  }
});

test('the sqlite guard protects a newer payload', () => {
  const { db, store } = openSqlite(':memory:');
  try {
    store.upsert('mail', 'k1', 'v1', 1000);
    const row = store.oldest('mail');
    store.upsert('mail', 'k1', 'v2', 1000);

    store.drop('mail', 'k1', { seq: row.seq, generation: row.generation });
    assert.equal(store.has('mail', 'k1'), true);

    const current = store.oldest('mail');
    assert.equal(current.value, 'v2');
    assert.equal(current.generation, row.generation + 1);
  } finally {
    db.close();
  }
});

test('ordered dispatch holds back later rows on sqlite', async () => {
  const { db, store } = openSqlite(':memory:');
  let clock = 1000;
  try {
    const queue = new EffectQueue(store, { now: () => clock });
    const processed = [];
    let failuresLeft = 1;
    queue.register(
      'mail',
      (value) => {
        if (value === 'v1' && failuresLeft-- > 0) throw new Error('head failed');
        processed.push(value);
      },
      { ordered: true, retry: [100, 400] },
    );
    store.upsert('mail', 'k1', 'v1', clock);
    store.upsert('mail', 'k2', 'v2', clock);

    const first = await queue.run();
    assert.equal(first[0].failed, 1);
    assert.equal(store.has('mail', 'k2'), true, 'the second row must wait');

    clock = store.oldest('mail').due;
    await queue.run();
    assert.deepEqual(processed, ['v1'], 'the head ran first after its retry became due');

    const second = await queue.run();
    assert.equal(second[0].done, 1);
    assert.deepEqual(processed, ['v1', 'v2']);
    assert.equal(store.has('mail'), false);
  } finally {
    db.close();
  }
});

test('summary reports attempts and the last error', async () => {
  const { db, store } = openSqlite(':memory:');
  try {
    const queue = new EffectQueue(store, { now: () => 1000 });
    queue.register(
      'mail',
      () => {
        throw new Error('kaboom');
      },
      { retry: [100, 400] },
    );
    store.upsert('mail', 'k1', 'v1', 1000);
    await queue.run();

    const summary = store.summary('mail');
    assert.equal(summary.waiting, 1);
    assert.equal(summary.maxAttempts, 1);
    assert.equal(summary.lastError, 'Error: kaboom');
    assert.equal(summary.oldestDue, 1100);

    assert.deepEqual(store.summary('mail-with-no-rows'), {
      waiting: 0,
      oldestSince: null,
      oldestDue: null,
      maxAttempts: 0,
      lastError: null,
    });
  } finally {
    db.close();
  }
});

test('savepoint names are validated before reaching sqlite', () => {
  const { db, driver } = openSqlite(':memory:');
  try {
    assert.throws(() => driver.savepoint('x; DROP TABLE effect'), /invalid savepoint name/);
    assert.throws(() => driver.savepoint(''), /invalid savepoint name/);
    assert.throws(() => openSqlite(''), /path/);
  } finally {
    db.close();
  }
});

test('the sqlite guard accepts Node 22.5 and newer', () => {
  const real = assertSqliteAvailable();
  assert.equal(typeof real.DatabaseSync, 'function');
  // Versions are compared numerically, not textually: "22.5.10" must pass just
  // like "22.6.0".
  assert.equal(assertSqliteAvailable('22.5.0', () => real), real);
  assert.equal(assertSqliteAvailable('22.5.10', () => real), real);
  assert.equal(assertSqliteAvailable('23.0.0', () => real), real);
});

test('the sqlite guard names the minimum, the actual version and the fallback', () => {
  let probed = false;
  assert.throws(
    () =>
      assertSqliteAvailable('22.4.9', () => {
        probed = true;
        return undefined;
      }),
    (error) => {
      assert.match(error.message, /Node >= 22\.5/);
      assert.match(error.message, /this process is Node 22\.4\.9/);
      assert.match(error.message, /plc-runtime-kit\/memory/);
      return true;
    },
  );
  // A version that is already ruled out must not probe the module: the guard
  // is a specific version check, not a catch-all around the import.
  assert.equal(probed, false);
});

test('the sqlite guard reports a failed module load without hiding the version', () => {
  assert.throws(
    () => assertSqliteAvailable('24.0.0', () => undefined),
    /Node >= 22\.5.*this process is Node 24\.0\.0.*plc-runtime-kit\/memory/s,
  );
});

