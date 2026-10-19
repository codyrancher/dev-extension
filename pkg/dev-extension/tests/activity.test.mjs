// The coarse bucket every conversation's dot is coloured from.
//
// Pinned because the extension had its own copy of this and it was wrong three ways, each of
// which shows up as a dot that lies: a fresh tab with a dot it should not have, every
// conversation reading `finished` for two minutes after a release, and a session that had
// exited reading as idle. The cases below are those three, stated as behaviour.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activityBucket, POD_SETTLE_MS } from '../chat-state.mjs';

const NOW = Date.parse('2026-10-19T12:00:00Z');
const agoSeconds = (n) => new Date(NOW - (n * 1000)).toISOString();

test('a conversation nobody has opened is none, not finished', () => {
  // No hook file and no transcript. The old copy answered `finished` here, because it tested
  // `alive` first - which is what put a dot on a fresh tab.
  assert.equal(activityBucket({ alive: false, event: '', notification: '', at: '', wroteAgo: -1 }, NOW - 600_000, NOW), 'none');
});

test('an absent pane is not believed while the pod is still settling', () => {
  const signals = {
    alive: false, event: 'Stop', notification: '', at: agoSeconds(30), wroteAgo: 30,
  };

  // Pod came up ten seconds ago: there is no tmux server yet, so "the pane is gone" says
  // nothing. '' is no news rather than a state.
  assert.equal(activityBucket(signals, NOW - 10_000, NOW), '');
  // And once it has settled, the same signals are news.
  assert.equal(activityBucket(signals, NOW - (POD_SETTLE_MS + 60_000), NOW), 'finished');
});

test('an absent pane is not believed when its hook predates the pod', () => {
  // Written by a claude that no longer exists, so its pane being absent was already true. This
  // holds however long ago the pod came up - which is what stops a conversation last touched a
  // week ago becoming `finished` news the moment the settle window passes.
  const podStarted = NOW - (24 * 3600 * 1000);
  const signals = {
    alive: false, event: 'Stop', notification: '', at: new Date(podStarted - 60_000).toISOString(), wroteAgo: 90_000,
  };

  assert.equal(activityBucket(signals, podStarted, NOW), '');
});

test('pod start unknown is treated as doubt, not as finished', () => {
  assert.equal(activityBucket({
    alive: false, event: 'Stop', notification: '', at: agoSeconds(30), wroteAgo: 30,
  }, 0, NOW), '');
});

test('SessionEnd is finished even with the pane still there', () => {
  // The loop that owns the pane restarts claude in a moment, but nothing is running in it now.
  // The old copy had no case for this and answered idle.
  assert.equal(activityBucket({
    alive: true, event: 'SessionEnd', notification: '', at: agoSeconds(200), wroteAgo: 200,
  }, NOW - 600_000, NOW), 'finished');
});

test('a transcript that moved recently is working', () => {
  assert.equal(activityBucket({
    alive: true, event: 'PreToolUse', notification: '', at: agoSeconds(5), wroteAgo: 5,
  }, NOW - 600_000, NOW), 'working');
});

test('a hook that speaks last overrules a transcript still settling', () => {
  // Stop fired after the last write, so the turn is over even though the transcript moved a
  // moment ago - which is the few seconds of writing that lands as a turn ends.
  assert.equal(activityBucket({
    alive: true, event: 'Stop', notification: '', at: agoSeconds(2), wroteAgo: 3,
  }, NOW - 600_000, NOW), 'idle');
});

test('a notification that is not the idle prompt is waiting on a person', () => {
  assert.equal(activityBucket({
    alive: true, event: 'Notification', notification: 'permission', at: agoSeconds(300), wroteAgo: 300,
  }, NOW - 600_000, NOW), 'input');
  assert.equal(activityBucket({
    alive: true, event: 'Notification', notification: 'idle_prompt', at: agoSeconds(300), wroteAgo: 300,
  }, NOW - 600_000, NOW), 'idle');
});
