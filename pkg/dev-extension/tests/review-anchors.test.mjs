// Anchoring a review's comments to the diff. The first case is the one that lost a five-finding
// review on PR 19730 to a `422 Line could not be resolved` and named nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  patchLines, diffAnchors, describeLines, resolveAnchor, resolveAnchors, lostMessage, movedNote
} from '../review-anchors.mjs';

// Two hunks: new-file lines 963-971 and 183-187, which is what PR 19730's workload.js looks like.
const PATCH = [
  '@@ -960,6 +963,9 @@ export default class Workload {',
  ' const a = 1;',
  '+const b = 2;',
  '+const c = 3;',
  ' const d = 4;',
  '-const gone = 5;',
  ' const e = 6;',
  '@@ -180,3 +183,4 @@ methods: {',
  ' one();',
  '+two();',
  ' three();',
].join('\n');

const FILES = [{ filename: 'shell/models/workload.js', patch: PATCH }];

test('the right side counts added and context lines, the left counts removed and context', () => {
  const { right, left } = patchLines(PATCH);

  assert.deepEqual([...right].sort((a, b) => a - b), [183, 184, 185, 963, 964, 965, 966, 967]);
  // 960 ' ', 961 '-' (the removed one lands at 964 on the old side), and the old second hunk.
  assert.ok(left.has(960));
  assert.ok(left.has(963));
  assert.ok(!left.has(965));
});

test('a range that starts one line above the hunk is pulled in, not refused', () => {
  const got = resolveAnchor({
    path: 'shell/models/workload.js', start_line: 962, line: 964, side: 'RIGHT',
  }, patchLines(PATCH));

  assert.equal(got.ok, true);
  assert.equal(got.line, 964);
  assert.equal(got.start_line, 963);
  assert.match(got.moved, /962-964 starts outside the diff; narrowed to 963-964/);
});

test('a range pulled all the way in becomes a single-line comment', () => {
  // 964 is the first line of the hunk's right side... 963 is. Anchor on 963 so there is no
  // in-diff line left between the start and the end: GitHub rejects start_line === line.
  const got = resolveAnchor({
    path: 'shell/models/workload.js', start_line: 900, line: 963, side: 'RIGHT',
  }, patchLines(PATCH));

  assert.equal(got.ok, true);
  assert.equal(got.start_line, null);
  assert.match(got.moved, /narrowed to line 963/);
});

test('a line the diff does not contain is reported, with the lines that are open', () => {
  const got = resolveAnchor({ path: 'shell/models/workload.js', line: 500 }, patchLines(PATCH));

  assert.equal(got.ok, false);
  assert.match(got.why, /line 500 is not in this pull request's diff/);
  assert.match(got.why, /183-185, 963-967/);
});

test('a range that does not run forwards is narrowed rather than sent as-is', () => {
  const got = resolveAnchor({
    path: 'shell/models/workload.js', start_line: 966, line: 964,
  }, patchLines(PATCH));

  assert.equal(got.ok, true);
  assert.equal(got.start_line, null);
  assert.match(got.moved, /does not run forwards/);
});

test('a file with no patch is passed through, because unknown is not the same as empty', () => {
  const byPath = diffAnchors([{ filename: 'big.bin' }, ...FILES]);

  assert.equal(byPath.has('big.bin'), false);

  const got = resolveAnchor({ path: 'big.bin', line: 10 }, byPath.get('big.bin'));

  assert.equal(got.ok, true);
  assert.equal(got.line, 10);
});

test('a comment on the pull request rather than a line is left alone', () => {
  assert.equal(resolveAnchor({ path: null, line: null }, undefined).ok, true);
});

test('the LEFT side is checked against the old file, not the new one', () => {
  const lines = patchLines(PATCH);

  // The old file runs 960-963 through this hunk; the new one runs 963-967.
  assert.equal(resolveAnchor({ path: 'x', line: 962, side: 'LEFT' }, lines).ok, true);
  assert.equal(resolveAnchor({ path: 'x', line: 967, side: 'LEFT' }, lines).ok, false);
  // And the same number answers differently on each side, which is the whole point of keeping
  // two sets: 962 is a line on the left and the gap above the hunk on the right.
  assert.equal(resolveAnchor({ path: 'x', line: 962, side: 'RIGHT' }, lines).ok, false);
});

test('a review is settled in one pass, with every lost comment named', () => {
  const { resolved, moved, lost } = resolveAnchors([
    { id: 2, path: 'shell/models/workload.js', line: 964 },
    {
      id: 4, path: 'shell/models/workload.js', start_line: 962, line: 964,
    },
    { id: 9, path: 'shell/models/workload.js', line: 500 },
  ], diffAnchors(FILES));

  assert.equal(resolved.length, 2);
  assert.equal(moved.length, 1);
  assert.deepEqual(lost.length, 1);
  assert.match(lost[0], /^Comment 9: /);
  assert.match(lostMessage(lost), /refuses the whole review over one/);
});

test('describeLines runs numbers together', () => {
  assert.equal(describeLines([3, 1, 2, 7]), '1-3, 7');
  assert.equal(describeLines([]), '');
});

test('nothing moved says nothing', () => {
  assert.equal(movedNote([]), '');
  assert.match(movedNote(['a', 'b']), /2 ranges were narrowed/);
});
