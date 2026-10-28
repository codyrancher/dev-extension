/**
 * When the agent's pass over a pull request is over, and when it only looks it.
 *
 * `node --test pkg/dev-extension/tests/*.test.mjs`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { passRunning, RUNNING_RUN_STATES } from '../review-pass.mjs';

test('a running pass whose work is in subagents is still running, however quiet the main agent', () => {
  // The case this exists for: eleven subagents, two working, the main transcript quiet past the
  // ninety-second window, so the bucket says idle - and the rail said Your pass.
  assert.equal(passRunning({ state: 'running' }, 'idle'), true);
});

test('a pass the agent reports complete is over', () => {
  assert.equal(passRunning({ state: 'complete' }, 'working'), false);
});

test('a pass that failed or was cancelled is over', () => {
  assert.equal(passRunning({ state: 'failed' }, 'idle'), false);
  assert.equal(passRunning({ state: 'cancelled' }, 'working'), false);
});

test('`idle` is the skill saying it stopped, which is not a pass in progress', () => {
  assert.equal(passRunning({ state: 'idle' }, 'working'), false);
});

test('starting up counts, sidecars and all', () => {
  for (const state of RUNNING_RUN_STATES) {
    assert.equal(passRunning({ state }, 'working'), true, state);
  }
});

test('a question mid-pass does not end it', () => {
  assert.equal(passRunning({ state: 'running' }, 'input'), true);
});

test('a record left running by an agent that is gone does not pin the stage', () => {
  // Nothing posts `complete` for an agent that was killed, so the conversation has to be able to
  // end the pass on its own - otherwise the step never reaches the person who has to move next.
  assert.equal(passRunning({ state: 'running' }, 'finished'), false);
  assert.equal(passRunning({ state: 'running' }, 'none'), false);
});

test('no run record at all leaves the older reading alone', () => {
  assert.equal(passRunning(null, 'working'), false);
  assert.equal(passRunning(undefined, 'idle'), false);
  assert.equal(passRunning({}, 'working'), false);
});
