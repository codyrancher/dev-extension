import { test } from 'node:test';
import assert from 'node:assert/strict';

import { chatReadScript } from '../chat-read.mjs';

const at = (over = {}) => chatReadScript({
  id: 'p-demo-1', off: 0, sub: '', soff: 0, nonce: 'n0nce123', projKey: '-workspaces-demo', cli: 'claude', ...over,
});

test('every value it is given reaches the script', () => {
  const s = at();

  assert.match(s, /ID="p-demo-1"/);
  assert.match(s, /N="n0nce123"/);
  assert.match(s, /OFF=0/);
  assert.ok(s.includes('-workspaces-demo'), 'the project directory');
});

test('the offsets are what make a read a delta rather than the whole file', () => {
  assert.match(at({ off: 4096 }), /OFF=4096/);
  assert.match(at({ soff: 77 }), /SOFF=77/);
});

test('a subagent is followed by id, and an empty one means the main conversation', () => {
  assert.match(at({ sub: 'agent-7' }), /SUB="agent-7"/);
  assert.match(at(), /SUB=""/);
});

test('the markers carry the nonce, which is the whole reason there is one', () => {
  // A transcript is a record of a conversation, and a conversation about this code quotes the
  // markers. Every marker has to carry the token, or a quoted one closes a block early.
  const s = at({ nonce: 'zz99' });
  const markers = s.match(/@@[A-Z]+-?\$?N?/g) || [];

  assert.ok(markers.length > 0, 'there are markers at all');
  assert.ok(s.includes('N="zz99"'), 'and the script is told the token');
  assert.ok(!/@@DATA\b(?!-)/.test(s.replace(/@@DATA-/g, '')), 'no bare marker without the nonce');
});

test('the two CLIs read different places, which is the only reason the branch exists', () => {
  const claude = at({ cli: 'claude' });
  const agy = at({ cli: 'agy' });

  assert.notEqual(claude, agy);
  assert.ok(claude.includes('-x claude'), 'liveness is the CLI\'s own process');
  assert.ok(agy.includes('-x agy'));
});

test('it is a string, not an array: both callers run it as one script', () => {
  assert.equal(typeof at(), 'string');
  assert.ok(at().includes('\n'), 'and it is many lines');
});

test('two reads with different nonces differ only by the nonce', () => {
  const a = at({ nonce: 'aaaa' });
  const b = at({ nonce: 'bbbb' });

  assert.equal(a.split('aaaa').join('X'), b.split('bbbb').join('X'));
});
