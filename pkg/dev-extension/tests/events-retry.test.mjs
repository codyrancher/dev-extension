// The reconnect arithmetic behind the event socket.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  backoffMs, wasStable, subscription, FIRST_MS, LONGEST_MS, STABLE_MS
} from '../events-retry.mjs';

test('the wait doubles and then stops doubling', () => {
  // random = 1 is the top of each range, which is the backoff itself.
  assert.equal(backoffMs(1, 0.999999), FIRST_MS);
  assert.equal(backoffMs(2, 0.999999), 2 * FIRST_MS);
  assert.equal(backoffMs(5, 0.999999), 16 * FIRST_MS);
  // 32s would be next, so the cap bites here and never lets go.
  assert.equal(backoffMs(6, 0.999999), LONGEST_MS);
  assert.equal(backoffMs(40, 0.999999), LONGEST_MS);
});

test('jitter spreads the herd without ever reconnecting in the same tick', () => {
  assert.equal(backoffMs(1, 0), 250);
  assert.equal(backoffMs(9, 0), 250);
  assert.ok(backoffMs(3, 0.5) < backoffMs(3, 0.9));
});

test('a first attempt is not treated as a zeroth', () => {
  assert.equal(backoffMs(0, 0.999999), FIRST_MS);
});

test('a socket that died young did not work, whatever it looked like', () => {
  assert.equal(wasStable(1000, 1000 + STABLE_MS - 1), false);
  assert.equal(wasStable(1000, 1000 + STABLE_MS), true);
  // Never opened at all.
  assert.equal(wasStable(0, 999999), false);
});

test('the subscription is the whole set, sorted, and sent only when it moves', () => {
  const first = subscription(['/b', '/a'], '');

  assert.equal(first.changed, true);
  assert.equal(first.frame, '{"sub":["/a","/b"]}');

  // The same set in another order is the same set.
  assert.equal(subscription(['/a', '/b'], first.sent).changed, false);
  assert.equal(subscription(['/b', '/a', '/a'], first.sent).changed, false);
  assert.equal(subscription(['/a'], first.sent).changed, true);
});
