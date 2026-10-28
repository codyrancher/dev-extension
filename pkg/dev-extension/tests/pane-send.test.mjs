/**
 * The send script's shape, at the two points the bug lived.
 *
 * `node --test pkg/dev-extension/tests/*.test.mjs`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { paneSendScript, PANE_SEND_RESULTS } from '../pane-send.mjs';

const script = (over = {}) => paneSendScript({
  pane: 'mc-p-x-1', file: '/tmp/f', frag: '/tmp/f.frag', events: '/w/sessions/p-x-1.events.jsonl', ...over,
}).join('\n');

test('nothing is called sent on the strength of an empty composer alone', () => {
  /*
   * The bug, exactly: the old script asked "is the probe in the composer" and read a no as a
   * yes. A no also means it was never there - which is what happened on pr-19714, where the
   * pane had auto-compacted while idle and took nothing. So every SENT the composer check can
   * reach is now behind `seen`, and the word "no" on its own reaches nothing.
   */
  const lines = script().split('\n');
  const sent = lines.map((line, i) => ({ line, i })).filter(({ line }) => /done_ SENT/.test(line));

  assert.equal(sent.length, 2, 'two ways to be sent: the hook recorded it, or it left the composer');
  for (const { line, i } of sent) {
    // The condition is on the line or the one above it, which is where the `elif` sits.
    const where = `${ lines[i - 1] }\n${ line }`;

    assert.match(where, /UserPromptSubmit|seen" = yes/, `${ line.trim() } is guarded`);
  }
});

test('the composer is read before the paste as well as after', () => {
  // The other arrival signal, and the only one a folded paste has: `[Pasted text #1 +40 lines]`
  // never shows the text's own first line, but it does change the bottom of the pane.
  const lines = script().split('\n');
  const before = lines.findIndex((l) => l.startsWith('start='));
  const paste = lines.findIndex((l) => l.includes('paste-buffer'));

  assert.ok(before >= 0, 'the pane is captured before anything is pasted');
  assert.ok(before < paste, 'and before, not after');
});

test('a pane that took nothing says so, and is not confused with one holding it unsent', () => {
  const s = script();

  assert.match(s, /\[ "\$seen" = yes \] \|\| \[ "\$moved" = yes \] && done_ STUCK/);
  assert.match(s, /done_ NOTTYPED$/);
  assert.ok(PANE_SEND_RESULTS.includes('NOTTYPED'));
});

test('without a log to read it rests on the composer, rather than faking the check', () => {
  const s = script({ events: '' });

  assert.equal(/UserPromptSubmit/.test(s), false);
  assert.match(s, /done_ SENT/);
});

test('tmux runs as the pane\'s user when the host says how', () => {
  const s = script({ as: 'as_user ' });

  for (const line of s.split('\n').filter((l) => l.includes('tmux '))) {
    assert.match(line, /as_user tmux /, line.trim());
  }
});
