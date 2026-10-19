/**
 * The frame between the pod and the chat view.
 *
 * The case that matters is the first one: a transcript is a record of a conversation, and a
 * conversation held while working on the chat view quotes the markers. The old fixed markers
 * made that transcript cut its own history short, silently, and only for the people most likely
 * to be looking at it.
 *
 * `node --test pkg/dev-extension/tests/*.test.mjs`; chat-frames.mjs is plain JavaScript with no
 * imports, so there is nothing to build or stub.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  frameNonce, markers, readFrames, spliceEarlier
} from '../chat-frames.mjs';

/** What the script writes, with the markers it would write them with. */
function wire(nonce, {
  file = '/p/x.jsonl', size = 0, data = null, pane = null, alive = false, hook = null, tails = [], ssize = 0, sdata = null,
} = {}) {
  const m = markers(nonce);
  const out = [`${ m.file } ${ file }`];

  if (size) {
    out.push(`${ m.size } ${ size }`);
  }
  if (data !== null) {
    out.push(m.data, data, m.endData);
  }
  if (sdata !== null) {
    out.push(`${ m.ssize } ${ ssize }`, m.sdata, sdata, m.endSData);
  }
  if (tails.length) {
    for (const { id, at, raw } of tails) {
      out.push(`${ m.tail } ${ id } ${ at }`, raw);
    }
    out.push(m.endTails);
  }
  if (hook !== null) {
    out.push(m.hook, hook, m.endHook);
  }
  if (alive) {
    out.push(m.alive);
  }
  out.push(m.pane, pane === null ? m.noPane : pane);

  return out.join('\n');
}

test('a transcript that quotes the markers does not cut its own history short', () => {
  const nonce = 'a1b2c3d4';
  // What this very file does to a transcript: the words are in it.
  const data = [
    '{"type":"user","message":{"content":"why is @@ENDDATA in the output"}}',
    '{"type":"assistant","message":{"content":[{"type":"text","text":"@@DATA frames the block"}]}}',
    '{"type":"user","message":{"content":"the last line, which used to be lost"}}',
  ].join('\n');

  const frame = readFrames(wire(nonce, { size: 400, data }), nonce);

  assert.equal(frame.data, data);
  assert.equal(frame.data.split('\n').length, 3);
});

test('an older read\'s nonce, quoted in the transcript, is inert', () => {
  const nonce = 'ffff0000';
  const stale = markers('deadbeef');
  const data = `{"text":"it printed ${ stale.data } and then ${ stale.endData }"}`;
  const frame = readFrames(wire(nonce, { size: 90, data }), nonce);

  assert.equal(frame.data, data);
});

test('absent blocks are absent, not empty', () => {
  const nonce = frameNonce();
  const frame = readFrames(wire(nonce, { pane: 'a prompt' }), nonce);

  // Nothing new in the transcript: null, so the caller leaves its offset where it is. An empty
  // string would be a block that arrived carrying nothing, which means the file was truncated.
  assert.equal(frame.data, null);
  assert.equal(frame.sdata, null);
  assert.equal(frame.size, 0);
  assert.deepEqual(frame.tails, []);
  assert.equal(frame.hook, undefined);
});

test('a pane that is not there has no text', () => {
  const nonce = frameNonce();
  const frame = readFrames(wire(nonce, { pane: null, alive: true }), nonce);

  assert.equal(frame.attached, false);
  assert.equal(frame.pane, '');
  // And nothing is alive in a pane that does not exist, whatever else the read said.
  assert.equal(frame.alive, false);
});

test('the pane cannot claim claude is running by printing the word', () => {
  const nonce = 'cafe1234';
  const m = markers(nonce);
  const frame = readFrames(wire(nonce, { pane: `a transcript line mentioning ${ m.alive }` }), nonce);

  assert.equal(frame.attached, true);
  assert.equal(frame.alive, false);
  assert.equal(readFrames(wire(nonce, { pane: 'idle', alive: true }), nonce).alive, true);
});

test('each subagent is one tail, raw', () => {
  const nonce = frameNonce();
  const tails = [
    { id: 'a1', at: 1760000000, raw: '{"type":"assistant","message":{"content":[{"type":"text","text":"read the file"}]}}' },
    { id: 'b2', at: 1760000900, raw: '{"type":"assistant","message":{"content":[]}}' },
  ];
  const frame = readFrames(wire(nonce, { tails }), nonce);

  assert.equal(frame.tails.length, 2);
  assert.deepEqual(frame.tails.map(({ id, at }) => [id, at]), [['a1', 1760000000], ['b2', 1760000900]]);
  assert.equal(frame.tails[0].raw, tails[0].raw);
});

test('the hook has three answers: a state, no state, and keep what you had', () => {
  const nonce = frameNonce();

  assert.deepEqual(readFrames(wire(nonce, { hook: '{"event":"Stop"}' }), nonce).hook, { event: 'Stop' });
  // There, and empty: the conversation has no state, so the view should say so.
  assert.equal(readFrames(wire(nonce, { hook: '' }), nonce).hook, null);
  // Caught mid-write: undefined, so the view keeps the state it already had.
  assert.equal(readFrames(wire(nonce, { hook: '{"event":"Sto' }), nonce).hook, undefined);
});

test('the transcript\'s path and length come back whole', () => {
  const nonce = frameNonce();
  const frame = readFrames(wire(nonce, { file: '/agent-workspace/.claude/projects/-workspaces-x/9f.jsonl', size: 1048577 }), nonce);

  assert.equal(frame.file, '/agent-workspace/.claude/projects/-workspaces-x/9f.jsonl');
  assert.equal(frame.size, 1048577);
});

test('a nonce is fresh, and is a single shell word', () => {
  const seen = new Set();

  for (let i = 0; i < 50; i++) {
    const nonce = frameNonce();

    assert.match(nonce, /^[a-z0-9]{8,}$/);
    seen.add(nonce);
  }
  assert.equal(seen.size, 50);
});

test('paging back joins the seam rather than losing the line it fell on', () => {
  const whole = [
    '{"n":1,"text":"the first line of the conversation"}',
    '{"n":2,"text":"the line the first read was cut inside"}',
    '{"n":3,"text":"the first line the view held"}',
  ].join('\n');
  // The first read took the last 60 bytes: a line cut in the middle, then whole ones. That is
  // what the view holds, partial first line and all.
  const cut = whole.length - 60;
  const held = whole.slice(cut).split('\n');

  assert.throws(() => JSON.parse(held[0]), 'the held set starts mid-line');

  // Paging back reads everything before that byte.
  const joined = spliceEarlier(held, whole.slice(0, cut), 0);

  assert.deepEqual(joined, whole.split('\n'));
  // Every line parses now, including the one the cut fell on.
  assert.deepEqual(joined.map((l) => JSON.parse(l).n), [1, 2, 3]);
});

test('a page that is itself cut leaves its first line for the page before it', () => {
  const whole = ['{"n":1,"text":"aaaaaaaaaaaaaaaaaaaaaaa"}', '{"n":2,"text":"bbbbbbbbbbbbbb"}', '{"n":3,"text":"cc"}'].join('\n');
  const second = 48;
  const held = whole.slice(second).split('\n');
  // One page back, still not at the start: from > 0, so this page's own first line is a tail.
  const once = spliceEarlier(held, whole.slice(12, second), 12);

  assert.throws(() => JSON.parse(once[0]), 'still partial at the front');
  // And the page before it completes that line, so nothing was lost on the way.
  const twice = spliceEarlier(once, whole.slice(0, 12), 0);

  assert.deepEqual(twice, whole.split('\n'));
});

test('an earlier page is framed like any other read', () => {
  const nonce = 'b0b0b0b0';
  const m = markers(nonce);
  const out = `${ m.from } 0\n${ m.back }\n{"n":1}\n{"n":2}\n${ m.endBack }`;
  const frame = readFrames(out, nonce);

  assert.equal(frame.from, 0);
  assert.equal(frame.back, '{"n":1}\n{"n":2}');
  // And a read that carried no page says so, rather than looking like an empty one.
  assert.equal(readFrames(`${ m.from } 512`, nonce).back, null);
  assert.equal(readFrames(`${ m.from } 512`, nonce).from, 512);
});
