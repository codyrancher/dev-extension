/**
 * A finger on the phone deck: scrolling stays scrolling, and only a clear swipe turns a card.
 *
 * `node --test pkg/dev-extension/tests/*.test.mjs`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  FLICK_MIN, NOT_A_SWIPE, SLOP, hasRoom, nearestDelta, ownedByStrip, readDirection, swipeDistance, swipeEvent, swipeStep,
} from '../deck-gesture.mjs';

test('a press that has not gone anywhere has no direction, which is what keeps a tap a tap', () => {
  assert.equal(readDirection(0, 0), null);
  assert.equal(readDirection(SLOP - 1, 0), null);
  assert.equal(readDirection(-(SLOP - 1), SLOP - 1), null);
});

test('clearly sideways is horizontal, either way', () => {
  assert.equal(readDirection(SLOP, 0), 'x');
  assert.equal(readDirection(-40, 10), 'x');
  assert.equal(readDirection(32, 20), 'x');
});

test('vertical is final, and that is the scroll', () => {
  assert.equal(readDirection(0, SLOP), 'y');
  assert.equal(readDirection(4, -80), 'y');
  assert.equal(readDirection(20, 20), 'y');
});

test('a diagonal is not captured until it makes up its mind', () => {
  assert.equal(readDirection(20, 15), null);
  assert.equal(readDirection(-30, 25), null);
  assert.equal(readDirection(60, 15), 'x');
});

test('a strip has room towards its far end when the finger goes left', () => {
  const strip = { scrollLeft: 0, scrollWidth: 800, clientWidth: 300 };

  assert.equal(hasRoom(strip, -30), true);
  assert.equal(hasRoom(strip, 30), false);
});

test('and towards its start when the finger goes right', () => {
  const strip = { scrollLeft: 120, scrollWidth: 800, clientWidth: 300 };

  assert.equal(hasRoom(strip, 30), true);
  assert.equal(hasRoom(strip, -30), true);
  assert.equal(hasRoom({ ...strip, scrollLeft: 500 }, -30), false);
});

test('a box with nothing to scroll has no room either way', () => {
  const fits = { scrollLeft: 0, scrollWidth: 300, clientWidth: 300 };

  assert.equal(hasRoom(fits, -30), false);
  assert.equal(hasRoom(fits, 30), false);
});

test('a scrollable strip with room keeps the gesture; one out of room does not', () => {
  const strip = { overflowX: 'auto', scrollWidth: 800, clientWidth: 300 };

  assert.equal(ownedByStrip([{ ...strip, scrollLeft: 0 }], -30), true);
  assert.equal(ownedByStrip([{ ...strip, scrollLeft: 0 }], 30), false);
  assert.equal(ownedByStrip([], -30), false);
});

test('anywhere in the chain counts, and a box a finger cannot scroll does not', () => {
  const hidden = { overflowX: 'hidden', scrollLeft: 0, scrollWidth: 800, clientWidth: 300 };
  const plain = { overflowX: 'visible', scrollLeft: 0, scrollWidth: 300, clientWidth: 300 };
  const scroller = { overflowX: 'scroll', scrollLeft: 0, scrollWidth: 800, clientWidth: 300 };

  assert.equal(ownedByStrip([hidden, plain], -30), false);
  assert.equal(ownedByStrip([plain, scroller], -30), true);
});

test('the distance to turn scales with the screen, within limits', () => {
  assert.equal(swipeDistance(100), 64);
  assert.equal(swipeDistance(390), 85.8);
  assert.equal(swipeDistance(2000), 120);
});

test('left is the next card and right is the previous one', () => {
  assert.equal(swipeStep(-90, 400, 390), 1);
  assert.equal(swipeStep(90, 400, 390), -1);
});

test('short of the distance and slow springs back', () => {
  assert.equal(swipeStep(-80, 400, 390), 0);
  assert.equal(swipeStep(30, 400, 390), 0);
  assert.equal(swipeStep(0, 0, 390), 0);
});

test('a real flick turns, and a fast twitch does not', () => {
  assert.equal(swipeStep(-40, 60, 390), 1);
  assert.equal(swipeStep(40, 60, 390), -1);
  assert.equal(swipeStep(-20, 10, 390), 0);
});

test('an item already in the box does not move it', () => {
  assert.equal(nearestDelta(0, 100, 10, 50), 0);
  assert.equal(nearestDelta(0, 100, 0, 100), 0);
});

test('an item past either end is brought to that end and no further', () => {
  assert.equal(nearestDelta(0, 100, 90, 130), 30);
  assert.equal(nearestDelta(0, 100, -20, 20), -20);
  assert.equal(nearestDelta(50, 150, 300, 344), 194);
});

test('an item bigger than the box follows the rule scrollIntoView does', () => {
  assert.equal(nearestDelta(0, 100, -10, 150), 0);
  assert.equal(nearestDelta(0, 100, 20, 180), 20);
  assert.equal(nearestDelta(0, 100, -80, 40), -60);
});

test('a flick has to be long enough, however fast', () => {
  assert.equal(swipeStep(-FLICK_MIN, 10, 390), 1);
  assert.equal(swipeStep(-(FLICK_MIN - 1), 10, 390), 0);
});

test('only what a sideways drag means something to refuses a swipe; buttons and links do not', () => {
  assert.deepEqual(NOT_A_SWIPE.split(', '), ['input', 'textarea', 'select', 'video', 'audio', '[contenteditable]']);
});

/* ── The press, from down to release ──────────────────────────────────────── */
const down = (over = {}) => ({
  type: 'down', id: 1, primary: true, button: 0, x: 200, y: 300, t: 0, blocked: false, ...over,
});
const move = (x, y, over = {}) => ({
  type: 'move', id: 1, x, y, buttons: 1, ...over,
});
const up = (over = {}) => ({
  type: 'up', id: 1, t: 400, width: 390, canTurn: true, ...over,
});

/** Runs events in order from nothing held, and gives the last result. */
function run(...events) {
  let out = { press: null };

  for (const event of events) {
    out = swipeEvent(out.press, event);
  }

  return out;
}

test('a tap captures nothing and turns nothing', () => {
  const pressed = run(down());

  assert.equal(pressed.press.swiping, false);
  const moved = swipeEvent(pressed.press, move(203, 302));

  assert.equal(moved.capture, false);
  assert.deepEqual(swipeEvent(moved.press, up()), {
    press: null, capture: false, turn: 0, dx: 0,
  });
});

test('the pointer is captured once, when the press goes clearly sideways', () => {
  const started = run(down(), move(180, 301));

  assert.equal(started.capture, true);
  assert.equal(started.press.swiping, true);
  assert.equal(swipeEvent(started.press, move(150, 340)).capture, false);
});

test('a swipe past the distance turns, from where the finger is', () => {
  const out = run(down(), move(180, 300), move(100, 300), up());

  assert.deepEqual(out, {
    press: null, capture: false, turn: 1, dx: -100,
  });
});

test('a vertical start belongs to the scroll, and sideways afterwards does not take it back', () => {
  const scrolled = run(down(), move(201, 330));

  assert.equal(scrolled.press, null);
  assert.equal(swipeEvent(scrolled.press, move(50, 330)).capture, false);
});

test('a cancel ends the swipe and never turns the deck', () => {
  const out = run(down(), move(100, 300), { type: 'cancel', id: 1 });

  assert.deepEqual(out, {
    press: null, capture: false, turn: 0, dx: 0,
  });
});

test('another finger neither ends nor turns the first one', () => {
  const held = run(down(), move(100, 300));

  for (const type of ['up', 'cancel', 'lostpointercapture']) {
    const out = swipeEvent(held.press, up({ type, id: 2 }));

    assert.equal(out.press, held.press, type);
    assert.equal(out.turn, 0, type);
  }
  assert.equal(swipeEvent(held.press, move(0, 0, { id: 2 })).press, held.press);
  assert.equal(swipeEvent(held.press, down({ id: 2, primary: false })).press, held.press);
  assert.equal(swipeEvent(held.press, up()).turn, 1);
});

test('a second finger landing before the capture does not drop the press', () => {
  const held = run(down());

  assert.equal(swipeEvent(held.press, down({ id: 2, primary: false })).press, held.press);
});

test('only the main button starts one, and a blocked target does not', () => {
  assert.equal(run(down({ button: 2 })).press, null);
  assert.equal(run(down({ blocked: true })).press, null);
  assert.equal(run(down({ primary: false })).press, null);
});

test('a move with nothing held ends the press, so a hovering mouse cannot start a swipe', () => {
  const held = run(down());
  const out = swipeEvent(held.press, move(100, 300, { buttons: 0 }));

  assert.equal(out.press, null);
  assert.equal(out.capture, false);
});

test('the capture being lost part-way is an end without a turn', () => {
  const held = run(down(), move(100, 300));
  const out = swipeEvent(held.press, { type: 'lostpointercapture', id: 1 });

  assert.equal(out.press, null);
  assert.equal(out.turn, 0);
});

test('a strip with room keeps the press, and is only asked once it has gone sideways', () => {
  let asked = 0;
  const owned = () => {
    asked += 1;

    return true;
  };
  const held = run(down());

  assert.equal(swipeEvent(held.press, move(203, 301), owned).press, held.press);
  assert.equal(asked, 0);
  const out = swipeEvent(held.press, move(150, 301), owned);

  assert.equal(asked, 1);
  assert.equal(out.press, null);
  assert.equal(out.capture, false);
});

test('one card has nowhere to go: it springs back and leaves nothing to carry', () => {
  const held = run(down(), move(100, 300));

  assert.equal(swipeEvent(held.press, up({ canTurn: false })).turn, 0);
});

test('a new first finger clears a press whose release never arrived', () => {
  const stale = run(down(), move(100, 300));
  const out = swipeEvent(stale.press, down({ id: 7, x: 10 }));

  assert.equal(out.press.id, 7);
  assert.equal(out.press.swiping, false);
});

/* ── The wiring, which a browser would otherwise be the only check on ─────── */
const source = (file) => readFileSync(new URL(`../${ file }`, import.meta.url), 'utf8');
const code = (text) => text.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');

test('the deck follows a held press rather than asking the width again part-way through it', () => {
  const deck = code(source('components/focus/FocusDeck.vue'));

  assert.match(deck, /function onDown[^}]*isNarrow\(\)[^}]*swipeDown/);
  assert.match(deck, /function onMove\(event: PointerEvent\) \{\s*if \(press\)/);
  assert.match(deck, /function onUp\(event: PointerEvent\) \{\s*if \(press\)/);
  assert.match(deck, /@lostpointercapture="onLostCapture"/);
});

test('crossing the breakpoint lets go of both gestures', () => {
  const deck = code(source('components/focus/FocusDeck.vue'));
  const body = deck.slice(deck.indexOf('onNarrowChange((now)'), deck.indexOf('onBeforeUnmount(() => stopNarrow'));

  for (const part of ['endSwipe()', 'pressed = false', 'dragging.value = false', 'dragY.value = 0', 'clearCarry()']) {
    assert.ok(body.includes(part), part);
  }
});

test('a single-card deck is told it cannot turn', () => {
  assert.match(source('components/focus/FocusDeck.vue'), /canTurn: props\.cards\.length > 1/);
});

test('the rail moves only itself', () => {
  assert.doesNotMatch(code(source('components/focus/FocusDeck.vue')), /scrollIntoView\(/);
});

test('the phone diff limit follows the width instead of caching one reading of it', () => {
  const set = code(source('components/focus/ChangeSet.vue'));
  const body = set.slice(set.indexOf('const shownHunks'), set.indexOf('const linesNotShown'));

  assert.match(body, /narrow\.value/);
  assert.doesNotMatch(body, /isNarrow\(\)/);
  assert.match(set, /onNarrowChange/);
});

test('a chat only moves the card when somebody asked it to', () => {
  const turns = code(source('components/chat/ChatTurns.vue'));
  const end = turns.slice(turns.indexOf('function scrollToEnd'), turns.indexOf('function toNewest'));

  assert.match(turns, /@click="toNewest"/);
  assert.match(end, /if \(outer\)[^}]*return;/);
  assert.doesNotMatch(end, /outer\.scrollTop/);
});

test('the phone sheet has no height:auto on the deck, and no nested scroller left in a chat', () => {
  const sheet = code(source('design/mobile.css'));

  assert.doesNotMatch(sheet, /\.dev-root \.(dev-focus|focus__deck) \{[^}]*height:\s*auto/);
  for (const box of ['.turn__pre', '.turn__body pre', '.tool__pre', '.ask__prompt']) {
    assert.ok(sheet.includes(`.dev-root .dev-focus .card ${ box }`), box);
  }
  assert.doesNotMatch(sheet, /-webkit-line-clamp: 2/);
});

test('a touch losing its implicit capture does not end the swipe', () => {
  const deck = readFileSync(new URL('../components/focus/FocusDeck.vue', import.meta.url), 'utf8');

  assert.match(deck, /function onLostCapture[\s\S]{0,300}event\.target === event\.currentTarget/);
});
