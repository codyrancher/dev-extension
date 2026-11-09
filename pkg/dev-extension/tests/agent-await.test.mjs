// When a card handed to an agent is still the agent's. The first case is the one that went wrong:
// "Put it up for review" on a card whose conversation had stopped.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { stillWithAgent, HANDOVER_GRACE_MS } from '../agent-await.mjs';

const AT = Date.parse('2026-11-09T01:23:19.244Z');
const HELD = {
  conversation: 'p-lte-issue-16356-1', epoch: 'e1', bornAt: '2026-11-07T00:00:14.908Z', stops: 11, asks: 0, at: new Date(AT).toISOString(),
};
const snapshot = (now = {}) => ({
  epoch:         'e1',
  stale:         false,
  conversations: {
    'p-lte-issue-16356-1': {
      state: 'gone', stops: 11, asks: 0, bornAt: '2026-11-07T00:00:14.908Z', ...now,
    },
  },
});
const soon = AT + 2_000;
const later = AT + HANDOVER_GRACE_MS + 1_000;

test('just handed over, a snapshot from before the press still says stopped: the card stays aside', () => {
  assert.equal(stillWithAgent(HELD, snapshot({ state: 'gone' }), soon), true);
  assert.equal(stillWithAgent(HELD, snapshot({ state: 'idle' }), soon), true);
});

test('just handed over to a conversation the snapshot has not seen yet: the card stays aside', () => {
  assert.equal(stillWithAgent({ ...HELD, conversation: 'p-lte-issue-16356-2', stops: 0, bornAt: '' }, snapshot(), soon), true);
});

test('working with the counters where they were: aside, inside the window and after it', () => {
  assert.equal(stillWithAgent(HELD, snapshot({ state: 'working' }), soon), true);
  assert.equal(stillWithAgent(HELD, snapshot({ state: 'working' }), later), true);
});

test('a counter that moved brings the card back, however soon', () => {
  assert.equal(stillWithAgent(HELD, snapshot({ state: 'idle', stops: 12 }), soon), false);
  assert.equal(stillWithAgent(HELD, snapshot({ state: 'input', asks: 1 }), soon), false);
  assert.equal(stillWithAgent(HELD, snapshot({ state: 'working', stops: 12 }), later), false);
});

test('a different conversation under the same id brings the card back', () => {
  assert.equal(stillWithAgent(HELD, snapshot({ state: 'working', bornAt: '2026-11-09T01:00:00.000Z' }), soon), false);
});

test('after the window, settled or never seen means the prompt was not picked up: the card comes back', () => {
  assert.equal(stillWithAgent(HELD, snapshot({ state: 'idle' }), later), false);
  assert.equal(stillWithAgent({ ...HELD, conversation: 'p-lte-issue-16356-2' }, snapshot(), later), false);
});

test('no snapshot, a stopped watcher or another epoch: show the card', () => {
  assert.equal(stillWithAgent(HELD, null, soon), false);
  assert.equal(stillWithAgent(HELD, { ...snapshot({ state: 'working' }), stale: true }, soon), false);
  assert.equal(stillWithAgent(HELD, { ...snapshot({ state: 'working' }), epoch: 'e2' }, soon), false);
});

test('nothing recorded is nothing held', () => {
  assert.equal(stillWithAgent(undefined, snapshot({ state: 'working' }), soon), false);
});
