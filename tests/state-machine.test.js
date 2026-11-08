import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  IllegalTransition,
  canTransition,
  commandsFrom,
  createMachine,
  nextState,
} from '../src/state-machine.js';

const TABLE = {
  idle: { start: 'running' },
  running: { pause: 'idle', finish: 'done' },
  done: {},
};

test('resolves a legal transition', () => {
  assert.equal(nextState(TABLE, 'idle', 'start'), 'running');
});

test('rejects a command with no rule, naming the state and command', () => {
  assert.throws(
    () => nextState(TABLE, 'done', 'start'),
    (error) => {
      assert.ok(error instanceof IllegalTransition);
      assert.ok(error instanceof Error);
      assert.equal(error.name, 'IllegalTransition');
      assert.equal(error.from, 'done');
      assert.equal(error.command, 'start');
      assert.match(error.message, /no rule for "start" in state "done"/);
      return true;
    },
  );
});

test('a missing rule is never an implicit self-loop', () => {
  assert.throws(() => nextState(TABLE, 'running', 'explode'), IllegalTransition);
  assert.equal(nextState({ paused: { resume: 'paused' } }, 'paused', 'resume'), 'paused');
});

test('canTransition agrees with nextState', () => {
  assert.equal(canTransition(TABLE, 'idle', 'start'), true);
  assert.equal(canTransition(TABLE, 'done', 'start'), false);
  assert.equal(canTransition(TABLE, 'unknown', 'start'), false);
  assert.equal(canTransition(null, 'idle', 'start'), false);
  assert.equal(canTransition({ idle: { start: 42 } }, 'idle', 'start'), false, 'non-string targets are invalid');
});

test('commandsFrom is sorted and empty for terminal states', () => {
  assert.deepEqual(commandsFrom(TABLE, 'running'), ['finish', 'pause']);
  assert.deepEqual(commandsFrom(TABLE, 'done'), []);
  assert.deepEqual(commandsFrom(TABLE, 'missing'), []);
});

test('machine keeps its state when a transition is rejected', () => {
  const machine = createMachine(TABLE, 'idle');
  assert.equal(machine.state, 'idle');
  assert.equal(machine.can('start'), true);

  assert.equal(machine.send('start'), 'running');
  assert.equal(machine.state, 'running');

  assert.throws(() => machine.send('start'), IllegalTransition);
  assert.equal(machine.state, 'running', 'a rejected command is not applied');

  assert.equal(machine.send('finish'), 'done');
  assert.equal(machine.state, 'done');
  assert.equal(machine.can('pause'), false);
});
