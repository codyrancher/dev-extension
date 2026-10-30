// The framing against a real client, because a codec that passes its own tests and not a
// browser's is a codec that passes no tests. Node's WebSocket is the same RFC 6455 client
// Chrome is, so a handshake and a round trip here is the one Chrome will do.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';

import {
  encodeFrame, decodeFrames, joinFrames, handshakeResponse, OP_TEXT, OP_PING, OP_PONG
} from '../dev-api/ws-frame.mjs';

const sha1 = (input) => crypto.createHash('sha1').update(input).digest('base64');

/** An echo server built the way dev-api builds its own: no library, just the codec. */
function echoServer() {
  const seen = [];
  const live = new Set();
  const server = http.createServer((req, res) => res.end('no'));

  server.on('upgrade', (req, socket, head) => {
    live.add(socket);
    socket.on('close', () => live.delete(socket));
    socket.write(handshakeResponse(String(req.headers['sec-websocket-key']), sha1));
    socket.setNoDelay(true);

    let buffer = head?.length ? Buffer.from(head) : Buffer.alloc(0);
    const joining = { opcode: 0, parts: [] };

    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);

      let frames;

      ({ frames, rest: buffer } = decodeFrames(buffer));

      const { messages, control } = joinFrames(frames, joining);

      for (const frame of control) {
        if (frame.opcode === OP_PING) {
          socket.write(encodeFrame(OP_PONG, frame.payload));
        }
      }
      for (const message of messages) {
        const text = message.payload.toString('utf8');

        seen.push(text);
        socket.write(encodeFrame(OP_TEXT, JSON.stringify({ echo: JSON.parse(text) })));
      }
    });
    socket.on('error', () => {});
  });

  return { server, seen, live };
}

function listening(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

/**
 * Shut it all down, the upgraded sockets included.
 *
 * An upgraded socket is no longer the HTTP server's: `close()` waits for connections that are
 * never coming back, `closeAllConnections()` does not reach it, and the test file hangs with
 * every assertion already passed. So the ones we accepted are destroyed by hand.
 */
async function shutdown(socket, { server, live }) {
  socket.close();
  for (const open of live) {
    open.destroy();
  }

  await new Promise((resolve) => server.close(resolve));
}

test('a real client completes the handshake and gets its message back', async() => {
  const echo = echoServer();
  const { server, seen } = echo;
  const port = await listening(server);
  const socket = new WebSocket(`ws://127.0.0.1:${ port }/events`);
  const back = await new Promise((resolve, reject) => {
    socket.onerror = () => reject(new Error('the handshake was refused'));
    socket.onopen = () => socket.send(JSON.stringify({ sub: ['/workspaces', '/conversations'] }));
    socket.onmessage = (event) => resolve(event.data);
  });

  assert.deepEqual(JSON.parse(back), { echo: { sub: ['/workspaces', '/conversations'] } });
  assert.deepEqual(JSON.parse(seen[0]).sub, ['/workspaces', '/conversations']);
  await shutdown(socket, echo);
});

test('a payload past both length boundaries survives the round trip', async() => {
  const echo = echoServer();
  const port = await listening(echo.server);
  const socket = new WebSocket(`ws://127.0.0.1:${ port }/events`);
  const big = 'w'.repeat(200_000);
  const back = await new Promise((resolve, reject) => {
    socket.onerror = () => reject(new Error('the handshake was refused'));
    socket.onopen = () => socket.send(JSON.stringify({ sub: [big] }));
    socket.onmessage = (event) => resolve(event.data);
  });

  assert.equal(JSON.parse(back).echo.sub[0].length, big.length);
  await shutdown(socket, echo);
});
