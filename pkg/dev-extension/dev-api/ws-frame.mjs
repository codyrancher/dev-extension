/**
 * RFC 6455 framing, by hand.
 *
 * dev-api runs from a ConfigMap as a single file with no node_modules - there is nowhere to
 * `npm i ws` to - so the few hundred bytes of bit-shifting a WebSocket server needs live here
 * rather than in a dependency. `scripts/gen-dev-api.mjs` inlines this into the packed server;
 * keeping it a module of its own is what lets `node --test` get at it, which hand-rolled
 * framing very much wants.
 *
 * Pure: buffers in, buffers out, no sockets and no state beyond what a caller hands back.
 *
 * @typedef {{ opcode: number, payload: Buffer, fin: boolean }} Frame
 */

export const OP_CONT = 0x0;
export const OP_TEXT = 0x1;
export const OP_BINARY = 0x2;
export const OP_CLOSE = 0x8;
export const OP_PING = 0x9;
export const OP_PONG = 0xa;

/** The magic the handshake's accept key is made with. The caller brings the SHA-1. */
export const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/**
 * One frame, ready for the wire.
 *
 * Never masked: a server does not mask, and a client that receives a masked frame is entitled
 * to hang up. The length takes the smallest of the three encodings, which is the one rule a
 * strict client will check.
 *
 * @param {number} opcode
 * @param {Buffer|string} data
 * @returns {Buffer}
 */
export function encodeFrame(opcode, data = Buffer.alloc(0)) {
  const payload = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
  const len = payload.length;
  const head = len < 126 ? 2 : (len < 65536 ? 4 : 10);
  const frame = Buffer.allocUnsafe(head + len);

  frame[0] = 0x80 | (opcode & 0x0f);

  if (len < 126) {
    frame[1] = len;
  } else if (len < 65536) {
    frame[1] = 126;
    frame.writeUInt16BE(len, 2);
  } else {
    frame[1] = 127;
    // A length over 2^53 cannot arise here and cannot be written with writeUIntBE either, so
    // the high word is zeroed rather than computed.
    frame.writeUInt32BE(0, 2);
    frame.writeUInt32BE(len, 6);
  }
  payload.copy(frame, head);

  return frame;
}

/** A close frame carrying a code and a reason, which is what a client logs when it hangs up. */
export function closeFrame(code = 1000, reason = '') {
  const text = Buffer.from(String(reason), 'utf8');
  const payload = Buffer.allocUnsafe(2 + text.length);

  payload.writeUInt16BE(code, 0);
  text.copy(payload, 2);

  return encodeFrame(OP_CLOSE, payload);
}

/**
 * Every whole frame at the front of `buffer`, and whatever is left over.
 *
 * TCP does not deliver frames, it delivers bytes: one read can hold three frames and half of a
 * fourth, and the half has to be kept for the next one. So the leftover comes back rather than
 * being dropped, and the caller hands it in again with the next chunk.
 *
 * Client frames are masked - a client that sends an unmasked one is in the wrong, but unmasking
 * is the same code either way, so this just does what the MASK bit says.
 *
 * @param {Buffer} buffer
 * @returns {{ frames: Frame[], rest: Buffer }}
 */
export function decodeFrames(buffer) {
  const frames = [];
  let at = 0;

  for (;;) {
    if (buffer.length - at < 2) {
      break;
    }

    const first = buffer[at];
    const second = buffer[at + 1];
    const masked = (second & 0x80) !== 0;
    let len = second & 0x7f;
    let head = at + 2;

    if (len === 126) {
      if (buffer.length - head < 2) {
        break;
      }
      len = buffer.readUInt16BE(head);
      head += 2;
    } else if (len === 127) {
      if (buffer.length - head < 8) {
        break;
      }
      // The high word of a 64-bit length is a frame no one on this socket will ever send, and
      // reading it as a JS number would lose precision anyway.
      if (buffer.readUInt32BE(head) !== 0) {
        throw new Error('WebSocket frame too long');
      }
      len = buffer.readUInt32BE(head + 4);
      head += 8;
    }

    const key = masked ? head : -1;

    if (masked) {
      head += 4;
    }
    if (buffer.length - head < len) {
      break;
    }

    const payload = Buffer.allocUnsafe(len);

    buffer.copy(payload, 0, head, head + len);
    if (masked) {
      for (let i = 0; i < len; i++) {
        payload[i] ^= buffer[key + (i % 4)];
      }
    }

    frames.push({ opcode: first & 0x0f, payload, fin: (first & 0x80) !== 0 });
    at = head + len;
  }

  return { frames, rest: at ? buffer.subarray(at) : buffer };
}

/**
 * Join the frames of a message back together.
 *
 * A message may arrive as a text or binary frame followed by continuations, and a control frame
 * - ping, pong, close - may be interleaved between them. So control frames come straight back
 * out and the data frames accumulate until one says it is the last.
 *
 * `state` is the caller's, carried between calls: `{ opcode, parts }`.
 *
 * @param {Frame[]} frames
 * @param {{ opcode: number, parts: Buffer[] }} state
 * @returns {{ messages: Array<{ opcode: number, payload: Buffer }>, control: Frame[] }}
 */
export function joinFrames(frames, state) {
  const messages = [];
  const control = [];

  for (const frame of frames) {
    if (frame.opcode >= 0x8) {
      control.push(frame);
      continue;
    }

    if (frame.opcode !== OP_CONT) {
      state.opcode = frame.opcode;
      state.parts = [];
    }
    state.parts.push(frame.payload);

    if (frame.fin) {
      messages.push({ opcode: state.opcode, payload: Buffer.concat(state.parts) });
      state.opcode = 0;
      state.parts = [];
    }
  }

  return { messages, control };
}

/**
 * The 101 a client needs back before it will believe this is a WebSocket.
 *
 * RFC 6455 section 4.2.2 and nothing else: the key the client sent, concatenated with the
 * protocol's magic, SHA-1'd and base64'd. The hashing is the caller's, so this stays free of
 * `node:crypto` and testable as the string-shuffling it is.
 *
 * @param {string} key - the client's `Sec-WebSocket-Key`
 * @param {(input: string) => string} sha1Base64
 * @returns {string} the whole response, headers and the blank line that ends them
 */
export function handshakeResponse(key, sha1Base64) {
  return [
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${ sha1Base64(key + WS_GUID) }`,
    '', '',
  ].join('\r\n');
}
