// Where the reader is after the Focus deck changed under them. The first case is the double drop:
// a card handed to an agent went after its reader had already moved on to the next one.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { holdPlace } from '../deck-place.mjs';

const deck = (...keys) => keys.map((key) => ({ key }));

test('a card leaving above the reader does not move them off theirs', () => {
  // On 16356, pressed, moved on to 16671 before it went.
  const before = deck('14904', '16356', '16671', '19512');
  const now = deck('14904', '16671', '19512');

  assert.deepEqual(holdPlace(before, now, 2), { index: 1, left: false });
});

test('a card arriving above the reader does not step them back', () => {
  // The agent stopped and its card came back on top.
  const before = deck('14904', '16671', '19512');
  const now = deck('16356', '14904', '16671', '19512');

  assert.deepEqual(holdPlace(before, now, 1), { index: 2, left: false });
});

test('the reader\'s own card going brings up the one after it', () => {
  const before = deck('14904', '16356', '16671', '19512');

  assert.deepEqual(holdPlace(before, deck('14904', '16671', '19512'), 1), { index: 1, left: true });
  // ...or the first of the ones after it that is still there.
  assert.deepEqual(holdPlace(before, deck('14904', '19512'), 1), { index: 1, left: true });
});

test('the last card going leaves the reader on the new last one', () => {
  assert.deepEqual(holdPlace(deck('a', 'b', 'c'), deck('a', 'b'), 2), { index: 1, left: true });
  assert.deepEqual(holdPlace(deck('a'), deck(), 0), { index: 0, left: true });
});

test('an index past the end is brought back onto the deck', () => {
  assert.deepEqual(holdPlace(deck('a', 'b'), deck('a'), 5), { index: 0, left: false });
});
