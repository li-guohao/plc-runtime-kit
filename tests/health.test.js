import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HealthBoard } from '../src/health.js';

test('claim creates a ready snapshot stamped with the clock', () => {
  const board = new HealthBoard({ now: () => 1000 });
  const entry = board.claim('effects');

  assert.equal(entry.live, true);
  assert.deepEqual(board.get('effects'), { state: 'ready', detail: '', at: 1000 });
  assert.deepEqual(board.snapshot(), { effects: { state: 'ready', detail: '', at: 1000 } });
});

test('a second claim of the same name is rejected', () => {
  const board = new HealthBoard();
  board.claim('effects');
  assert.throws(() => board.claim('effects'), /already claimed/);
});

test('set updates the snapshot and snapshot() returns copies', () => {
  let now = 1000;
  const board = new HealthBoard({ now: () => now });
  const entry = board.claim('effects');

  now = 2000;
  entry.set('error', '3 attempts failed');

  assert.deepEqual(board.get('effects'), { state: 'error', detail: '3 attempts failed', at: 2000 });

  const copy = board.get('effects');
  copy.state = 'ready';
  assert.equal(board.get('effects').state, 'error', 'mutating a returned snapshot does not touch the board');
});

test('release unregisters the entry and late writes are dropped', () => {
  let now = 1000;
  const board = new HealthBoard({ now: () => now });
  const entry = board.claim('sessions');
  entry.set('degraded', 'warming');

  entry.release();
  entry.release();
  assert.equal(entry.live, false);
  assert.equal(board.get('sessions'), undefined);
  assert.deepEqual(board.snapshot(), {});

  now = 5000;
  entry.set('error', 'too late');
  assert.equal(board.get('sessions'), undefined, 'a released entry cannot resurrect its name');
});

test('a stale entry cannot affect a newer claimant', () => {
  const board = new HealthBoard();
  const first = board.claim('outbox');
  first.release();

  const second = board.claim('outbox');
  first.set('error', 'stale writer');
  assert.equal(board.get('outbox').state, 'ready');

  second.set('degraded', 'retrying');
  assert.equal(board.get('outbox').state, 'degraded');
});

test('entries are independent and names are validated', () => {
  const board = new HealthBoard();
  const a = board.claim('a');
  const b = board.claim('b');

  a.set('degraded', 'slow');
  assert.equal(b.get().state, 'ready');

  assert.throws(() => board.claim(''), /non-empty/);
  assert.throws(() => board.claim('   '), /non-empty/);
  assert.throws(() => a.set('broken', 'x'), /unknown health state/);
  assert.throws(() => a.set('ready', 42), /detail must be a string/);
});
