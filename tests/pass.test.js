import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EffectQueue } from '../src/effects.js';
import { createMemoryRuntime } from '../src/memory.js';
import { runPass } from '../src/unit.js';

test('one pass commits per unit, rolls back only the failed unit, and resumes next pass', async () => {
  const { store, unit } = createMemoryRuntime();
  const queue = new EffectQueue(store, { now: () => 1000 });
  const delivered = [];
  queue.register('mail', (value) => {
    delivered.push(value);
  });

  const steps = [
    () => store.upsert('mail', 'a', 'A', 1000),
    () => {
      store.upsert('mail', 'b', 'B', 1000);
      throw new Error('second unit failed');
    },
    () => store.upsert('mail', 'c', 'C', 1000),
  ];

  const first = runPass(unit, steps);
  assert.equal(first.committed, 1);
  assert.match(String(first.error), /second unit failed/);
  assert.equal(store.has('mail', 'a'), true, 'unit 1 stayed committed');
  assert.equal(store.has('mail', 'b'), false, 'the failed unit rolled back together with its effect');
  assert.equal(store.has('mail', 'c'), false, 'the pass stopped');

  await queue.run();
  assert.deepEqual(delivered, ['A']);

  const second = runPass(unit, steps.slice(2));
  assert.equal(second.committed, 1);
  assert.equal(store.has('mail', 'c'), true);

  await queue.run();
  assert.deepEqual(delivered, ['A', 'C'], 'the next pass finished the remaining work');
});

test('a committed unit survives a later unit failing inside the same pass', () => {
  const { store, unit } = createMemoryRuntime(); // no effects needed here

  const result = runPass(unit, [
    () => store.upsert('mail', 'a', 'A', 1000),
    () => store.upsert('mail', 'b', 'B', 1000),
    () => {
      throw new Error('last unit failed');
    },
  ]);

  assert.equal(result.committed, 2);
  assert.equal(store.has('mail', 'a'), true);
  assert.equal(store.has('mail', 'b'), true);
});
