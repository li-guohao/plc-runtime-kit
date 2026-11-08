import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createUnit, runPass } from '../src/unit.js';
import { MemoryDriver } from '../src/memory.js';

/**
 * A single mutable Map held behind a snapshot driver, so rollback has real
 * observable effects.
 */
function makeCell(report) {
  /** @type {Map<string, number>} */
  let cell = new Map();
  const driver = new MemoryDriver(
    () => new Map(cell),
    (snapshot) => {
      cell = new Map(snapshot);
    },
    (snapshot) => new Map(snapshot),
  );
  return { cell: () => cell, unit: createUnit(driver, report) };
}

test('commits writes and returns the operation value', () => {
  const { cell, unit } = makeCell();

  const value = unit.atomic(() => {
    cell().set('a', 1);
    assert.equal(unit.depth, 1);
    return 'ok';
  });

  assert.equal(value, 'ok');
  assert.equal(cell().get('a'), 1);
  assert.equal(unit.depth, 0);
});

test('nested rollback keeps the outer write', () => {
  const { cell, unit } = makeCell();

  unit.atomic(() => {
    cell().set('a', 1);
    assert.throws(
      () =>
        unit.atomic(() => {
          cell().set('a', 2);
          throw new Error('inner failed');
        }),
      /inner failed/,
    );
    assert.equal(cell().get('a'), 1, 'rollback to the inner savepoint restored the outer value');
  });

  assert.equal(cell().get('a'), 1);
});

test('outer rollback discards an inner commit', () => {
  const { cell, unit } = makeCell();

  assert.throws(
    () =>
      unit.atomic(() => {
        cell().set('a', 1);
        unit.atomic(() => {
          cell().set('b', 2);
        });
        throw new Error('outer failed');
      }),
    /outer failed/,
  );

  assert.equal(cell().size, 0, 'the inner release did not make the write durable');
});

test('afterCommit waits for the outermost commit, in push order', () => {
  const { cell, unit } = makeCell();
  const seen = [];

  unit.atomic(() => {
    cell().set('a', 1);
    unit.afterCommit(() => seen.push(['outer', cell().get('a'), cell().get('b')]));
    unit.atomic(() => {
      cell().set('b', 2);
      unit.afterCommit(() => seen.push(['inner', cell().get('a'), cell().get('b')]));
    });
    assert.deepEqual(seen, [], 'no callback runs before the outermost commit');
  });

  assert.deepEqual(seen, [
    ['outer', 1, 2],
    ['inner', 1, 2],
  ]);
});

test('afterCommit runs immediately outside a unit', () => {
  const { cell, unit } = makeCell();
  let ran = false;

  unit.afterCommit(() => {
    ran = true;
    cell().set('a', 1);
  });

  assert.equal(ran, true);
  assert.equal(cell().get('a'), 1);
});

test('callbacks of a rolled-back level never run', () => {
  const { unit } = makeCell();
  let ran = false;

  assert.throws(
    () =>
      unit.atomic(() => {
        unit.afterCommit(() => {
          ran = true;
        });
        throw new Error('nope');
      }),
    /nope/,
  );

  assert.equal(ran, false);
});

test('after-commit errors are reported, do not abort the rest, and do not fail the unit', () => {
  const events = [];
  const { cell, unit } = makeCell((event) => events.push(event));

  const value = unit.atomic(() => {
    cell().set('a', 1);
    unit.afterCommit(() => {
      throw new Error('callback failed');
    });
    unit.afterCommit(() => cell().set('c', 3));
    return 'committed';
  });

  assert.equal(value, 'committed');
  assert.equal(cell().get('a'), 1);
  assert.equal(cell().get('c'), 3, 'a later callback still ran');
  const errors = events.filter((event) => event.kind === 'afterCommitError');
  assert.equal(errors.length, 1);
  assert.match(String(errors[0].error), /callback failed/);
  assert.equal(events.filter((event) => event.kind === 'commit').length, 1);
});

test('runPass stops at the first failure and keeps committed units', () => {
  const { cell, unit } = makeCell();

  const result = runPass(unit, [
    () => cell().set('u1', 1),
    () => {
      cell().set('u2', 2);
      throw new Error('unit 2 failed');
    },
    () => cell().set('u3', 3),
  ]);

  assert.equal(result.committed, 1);
  assert.match(String(result.error), /unit 2 failed/);
  assert.equal(cell().get('u1'), 1, 'the committed unit survives');
  assert.equal(cell().has('u2'), false, 'the failed unit left nothing behind');
  assert.equal(cell().has('u3'), false, 'the pass did not continue');
});

test('runPass reports the committed count when every unit succeeds', () => {
  const { cell, unit } = makeCell();

  const result = runPass(unit, [() => cell().set('u1', 1), () => cell().set('u2', 2)]);

  assert.deepEqual(result, { committed: 2 });
});

test('rejects malformed arguments', () => {
  assert.throws(() => createUnit({}), /savepoint/);
  assert.throws(() => createUnit({ savepoint() {}, release() {}, rollbackTo() {} }, 'nope'), /report/);

  const { unit } = makeCell();
  assert.throws(() => unit.atomic('not a function'), /function/);
  assert.throws(() => unit.afterCommit('not a function'), /function/);
  assert.throws(() => runPass(null, []), /unit/);
  assert.throws(() => runPass(unit, null), /iterable/);
  assert.throws(() => runPass(unit, [null]), /functions/);
});
