// What makes a recording seekable: the one byte range a player asks dev-api for.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { byteRange } from '../dev-api/ranges.mjs';

test('a player\'s first ask, from the start to the end', () => {
  assert.deepEqual(byteRange('bytes=0-', 1000), { start: 0, end: 999 });
});

test('a seek: from somewhere to the end, or a bounded piece', () => {
  assert.deepEqual(byteRange('bytes=400-', 1000), { start: 400, end: 999 });
  assert.deepEqual(byteRange('bytes=400-499', 1000), { start: 400, end: 499 });
  assert.deepEqual(byteRange('bytes=400-5000', 1000), { start: 400, end: 999 });
});

test('the last n bytes, which is where an mp4 keeps its index', () => {
  assert.deepEqual(byteRange('bytes=-100', 1000), { start: 900, end: 999 });
  assert.deepEqual(byteRange('bytes=-5000', 1000), { start: 0, end: 999 });
});

test('past the end is refused rather than sent empty', () => {
  assert.equal(byteRange('bytes=1000-', 1000), 'unsatisfiable');
  assert.equal(byteRange('bytes=500-400', 1000), 'unsatisfiable');
});

test('no range, a malformed one, several, or an empty body: the whole', () => {
  assert.equal(byteRange(undefined, 1000), null);
  assert.equal(byteRange('bytes=-', 1000), null);
  assert.equal(byteRange('items=0-5', 1000), null);
  assert.equal(byteRange('bytes=0-1,5-6', 1000), null);
  assert.equal(byteRange('bytes=0-', 0), null);
});
