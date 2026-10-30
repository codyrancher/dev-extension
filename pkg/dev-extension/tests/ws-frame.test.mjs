// The framing dev-api's event socket is built on. Hand-rolled, so every case here is one a
// browser would otherwise hit as a silent hang.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  encodeFrame, closeFrame, decodeFrames, joinFrames, OP_TEXT, OP_CONT, OP_PING, OP_CLOSE
} from '../dev-api/ws-frame.mjs';

/** A client frame: masked, as a client's must be. */
function clientFrame(opcode, text, fin = true) {
  const payload = Buffer.from(text, 'utf8');
  const len = payload.length;
  const head = len < 126 ? 2 : (len < 65536 ? 4 : 10);
  const key = Buffer.from([1, 2, 3, 4]);
  const frame = Buffer.allocUnsafe(head + 4 + len);

  frame[0] = (fin ? 0x80 : 0) | opcode;
  if (len < 126) {
    frame[1] = 0x80 | len;
  } else if (len < 65536) {
    frame[1] = 0x80 | 126;
    frame.writeUInt16BE(len, 2);
  } else {
    frame[1] = 0x80 | 127;
    frame.writeUInt32BE(0, 2);
    frame.writeUInt32BE(len, 6);
  }
  key.copy(frame, head);
  for (let i = 0; i < len; i++) {
    frame[head + 4 + i] = payload[i] ^ key[i % 4];
  }

  return frame;
}

test('a short frame takes the two-byte header and no mask', () => {
  const frame = encodeFrame(OP_TEXT, 'hi');

  assert.equal(frame.length, 4);
  assert.equal(frame[0], 0x81);
  assert.equal(frame[1], 2);
});

test('the length takes the smallest encoding that fits, at every boundary', () => {
  assert.equal(encodeFrame(OP_TEXT, 'x'.repeat(125)).length, 2 + 125);
  assert.equal(encodeFrame(OP_TEXT, 'x'.repeat(126)).length, 4 + 126);
  assert.equal(encodeFrame(OP_TEXT, 'x'.repeat(65535)).length, 4 + 65535);
  assert.equal(encodeFrame(OP_TEXT, 'x'.repeat(65536)).length, 10 + 65536);
});

test('a frame we wrote reads back as the message we wrote', () => {
  const big = JSON.stringify({ d: 'y'.repeat(100000) });
  const { frames, rest } = decodeFrames(encodeFrame(OP_TEXT, big));

  assert.equal(rest.length, 0);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].payload.toString('utf8'), big);
});

test('a masked client frame is unmasked', () => {
  const { frames } = decodeFrames(clientFrame(OP_TEXT, '{"sub":["/workspaces"]}'));

  assert.equal(frames[0].payload.toString('utf8'), '{"sub":["/workspaces"]}');
});

test('three frames in one read come out as three', () => {
  const buffer = Buffer.concat([clientFrame(OP_TEXT, 'a'), clientFrame(OP_PING, ''), clientFrame(OP_TEXT, 'b')]);
  const { frames, rest } = decodeFrames(buffer);

  assert.deepEqual(frames.map((f) => f.opcode), [OP_TEXT, OP_PING, OP_TEXT]);
  assert.equal(rest.length, 0);
});

test('half a frame is kept for the next read, which is what TCP makes this for', () => {
  const whole = clientFrame(OP_TEXT, 'hello there');
  const first = decodeFrames(whole.subarray(0, 6));

  assert.equal(first.frames.length, 0);
  assert.equal(first.rest.length, 6);

  const second = decodeFrames(Buffer.concat([first.rest, whole.subarray(6)]));

  assert.equal(second.frames.length, 1);
  assert.equal(second.frames[0].payload.toString('utf8'), 'hello there');
  assert.equal(second.rest.length, 0);
});

test('a header split across reads is not mistaken for a frame', () => {
  const whole = clientFrame(OP_TEXT, 'x'.repeat(300));

  // Two bytes in, the extended length has not arrived yet.
  assert.equal(decodeFrames(whole.subarray(0, 2)).frames.length, 0);
  assert.equal(decodeFrames(whole.subarray(0, 3)).frames.length, 0);
  assert.equal(decodeFrames(whole).frames[0].payload.length, 300);
});

test('a 64-bit length beyond what a number holds is refused rather than truncated', () => {
  const frame = Buffer.alloc(10 + 4);

  frame[0] = 0x81;
  frame[1] = 127;
  frame.writeUInt32BE(1, 2);

  assert.throws(() => decodeFrames(frame), /too long/);
});

test('continuations are joined, and a ping between them is not swallowed', () => {
  const state = { opcode: 0, parts: [] };
  const { frames } = decodeFrames(Buffer.concat([
    clientFrame(OP_TEXT, '{"su', false),
    clientFrame(OP_PING, ''),
    clientFrame(OP_CONT, 'b":[]}'),
  ]));
  const { messages, control } = joinFrames(frames, state);

  assert.equal(messages.length, 1);
  assert.equal(messages[0].payload.toString('utf8'), '{"sub":[]}');
  assert.deepEqual(control.map((f) => f.opcode), [OP_PING]);
});

test('an unfinished message waits for the read that finishes it', () => {
  const state = { opcode: 0, parts: [] };

  assert.equal(joinFrames(decodeFrames(clientFrame(OP_TEXT, 'one ', false)).frames, state).messages.length, 0);

  const { messages } = joinFrames(decodeFrames(clientFrame(OP_CONT, 'two')).frames, state);

  assert.equal(messages[0].payload.toString('utf8'), 'one two');
});

test('a close frame carries its code and reason', () => {
  const { frames } = decodeFrames(closeFrame(1011, 'gone'));

  assert.equal(frames[0].opcode, OP_CLOSE);
  assert.equal(frames[0].payload.readUInt16BE(0), 1011);
  assert.equal(frames[0].payload.subarray(2).toString('utf8'), 'gone');
});
