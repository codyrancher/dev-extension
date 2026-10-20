/**
 * A teleported menu stays on screen, wherever its button is.
 *
 * `node --test pkg/dev-extension/tests/*.test.mjs`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { placeMenu, EDGE, GAP } from '../menu-place.mjs';

const view = { width: 1200, height: 800 };
/** A 22px caret, as the drawer's tab row draws it, at (x, y). */
const caret = (x, y) => ({
  top: y, bottom: y + 24, left: x, right: x + 22, width: 22, height: 24,
});
const menu = (width, height) => ({ width, height });

test('below the control and right-aligned with it, when there is room', () => {
  const at = placeMenu(caret(500, 100), menu(160, 60), view);

  assert.deepEqual(at, {
    top: 128, left: 362, maxHeight: 0, above: false,
  });
  // 100 + 24 + GAP below it, and its right edge on the caret's.
  assert.equal(at.top, 100 + 24 + GAP);
  assert.equal(at.left + 160, 522);
});

test('above the control when below would run off the bottom', () => {
  // The case in the screenshot: a caret near the foot of the drawer, and a menu that does not
  // fit under it - 740 + 24 + 4 + 60 = 828, past the 792 an 800-tall window leaves.
  const at = placeMenu(caret(500, 740), menu(160, 60), view);

  assert.equal(at.above, true);
  assert.equal(at.top, 740 - GAP - 60);
  assert.equal(at.maxHeight, 0, 'it fits above, so it is not capped');
});

test('and it stays below while below still fits, to the last pixel', () => {
  // The boundary, stated so a later change to the edges has to admit it is changing this: a
  // 60-tall menu under a caret at 700 ends at 788, inside the 792 the edge leaves.
  const snug = placeMenu(caret(500, 700), menu(160, 60), view);

  assert.equal(snug.above, false);
  assert.equal(snug.top + 60, 788);
  // One pixel more and it flips.
  assert.equal(placeMenu(caret(500, 705), menu(160, 60), view).above, true);
});

test('clamped to the left edge rather than right-aligned off it', () => {
  // A caret 40px from the left with a 220px menu: right-aligning puts it at -158.
  const at = placeMenu(caret(40, 100), menu(220, 60), view);

  assert.equal(at.left, EDGE);
});

test('clamped to the right edge too', () => {
  const at = placeMenu(caret(1190, 100), menu(220, 60), view);

  assert.equal(at.left, view.width - 220 - EDGE);
  assert.ok(at.left + 220 <= view.width - EDGE);
});

test('a menu wider than the window keeps its left edge', () => {
  const at = placeMenu(caret(100, 100), menu(1400, 60), { width: 320, height: 800 });

  assert.equal(at.left, EDGE);
});

test('capped and scrolling when it fits neither above nor below', () => {
  // A tall menu in a short window: more room below than above here.
  const at = placeMenu(caret(500, 200), menu(160, 600), { width: 1200, height: 500 });

  assert.equal(at.above, false);
  assert.equal(at.top, 228);
  assert.equal(at.maxHeight, 500 - EDGE - 228);
  assert.ok(at.maxHeight > 0);
});

test('capped upward when that is the roomier side', () => {
  const at = placeMenu(caret(500, 420), menu(160, 600), { width: 1200, height: 500 });

  assert.equal(at.above, true);
  assert.equal(at.top, EDGE);
  assert.equal(at.maxHeight, 420 - GAP - EDGE);
});

test('nothing measured yet is not a crash', () => {
  // The first open measures the menu after it renders, so a caller can ask with zeroes.
  const at = placeMenu(caret(500, 100), menu(0, 0), view);

  assert.equal(at.top, 128);
  assert.equal(at.above, false);
  assert.deepEqual(placeMenu(null, null, null), {
    top: GAP, left: EDGE, maxHeight: 0, above: false,
  });
});
