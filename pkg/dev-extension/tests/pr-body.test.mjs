/**
 * Ticking a box in a pull request's description.
 *
 * The whole risk is counting: the box somebody pressed is the Nth the renderer drew, and the
 * character to rewrite is the Nth bracket the source has. Everything below is a way those two
 * counts can come apart.
 *
 * `node --test pkg/dev-extension/tests/*.test.mjs`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  taskPositions, toggleTask, numberTaskBoxes, setTask, taskDone
} from '../pr-body.mjs';

const BODY = [
  '## Summary',
  '',
  'Fixes #19517',
  '',
  '- [x] Tests written',
  '- [ ] Docs updated',
  '* [X] Screenshot attached',
  '  - [ ] and a sub-item',
  '',
  'Some prose with [ ] a bracket in it, and a [link](https://example.com).',
  '',
  '```sh',
  '- [ ] not a box: this is a shell block',
  '```',
  '',
  '1. [ ] a numbered task',
].join('\n');

test('every task box is found, and nothing else is', () => {
  const boxes = taskPositions(BODY);

  assert.equal(boxes.length, 5, 'four list items, one numbered - not the prose and not the fence');
  assert.deepEqual(boxes.map((b) => b.done), [true, false, true, false, false]);
});

test('a box inside a fenced block is not a box', () => {
  // The renderer draws it as code, so counting it would shift every box after it.
  const fenced = ['- [ ] real', '```', '- [ ] code', '```', '- [ ] also real'].join('\n');

  assert.equal(taskPositions(fenced).length, 2);
  // And toggling the second one reaches the one after the fence, not the one inside it.
  assert.match(toggleTask(fenced, 1), /```\n- \[ \] code\n```\n- \[x\] also real/);
});

test('a longer fence closes only on one at least as long', () => {
  const body = ['````', '```', '- [ ] still inside', '````', '- [ ] out here'].join('\n');

  assert.equal(taskPositions(body).length, 1);
});

test('toggling changes one character and nothing else', () => {
  const after = toggleTask(BODY, 1);

  assert.equal(after.length, BODY.length);
  assert.match(after, /- \[x\] Docs updated/);
  // Everything around it is byte-identical: no reflow, no re-rendered markdown.
  assert.equal(after.replace('- [x] Docs updated', '- [ ] Docs updated'), BODY);
});

test('a ticked box unticks, whatever case it was written in', () => {
  assert.match(toggleTask(BODY, 2), /\* \[ \] Screenshot attached/);
  assert.match(toggleTask(BODY, 0), /- \[ \] Tests written/);
});

test('a box that is not there changes nothing', () => {
  assert.equal(toggleTask(BODY, 99), BODY);
  assert.equal(toggleTask(BODY, -1), BODY);
  assert.equal(toggleTask('', 0), '');
  assert.equal(toggleTask(undefined, 0), '');
});

test('the rendered boxes are numbered in the same order, and live', () => {
  const html = numberTaskBoxes('<ul><li><input checked="" disabled="" type="checkbox"> a</li><li><input disabled="" type="checkbox"> b</li></ul>');

  assert.match(html, /data-task="0"/);
  assert.match(html, /data-task="1"/);
  assert.doesNotMatch(html, /disabled/, 'a box you cannot press is the bug being fixed');
  // The rest of the input is left alone, so `checked` still draws the tick.
  assert.match(html, /checked=""/);
});

test('numbering leaves other inputs and other html alone', () => {
  const html = numberTaskBoxes('<p>text</p><input type="text"><input type="checkbox" disabled>');

  assert.match(html, /<input type="text">/);
  assert.equal((html.match(/data-task=/g) || []).length, 1);
});

test('a press is written as a state, so a box ticked elsewhere in between stays ticked', () => {
  // Box 1 is "Docs updated", unticked here; somebody else ticks it before this press is written.
  const elsewhere = toggleTask(BODY, 1);

  assert.equal(taskDone(BODY, 1), false);
  assert.equal(taskDone(elsewhere, 1), true);
  // Flipping would have unticked it; setting it leaves it as both of them meant.
  assert.equal(taskDone(toggleTask(elsewhere, 1), 1), false);
  assert.equal(setTask(elsewhere, 1, true), elsewhere);
  assert.equal(taskDone(setTask(BODY, 1, true), 1), true);
  assert.equal(taskDone(setTask(BODY, 0, false), 0), false);
});

test('setting a box that is not there changes nothing', () => {
  assert.equal(setTask(BODY, 99, true), BODY);
  assert.equal(taskDone(BODY, 99), null);
});
