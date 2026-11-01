/**
 * What a finger on the Focus deck meant, at phone width.
 *
 * A vertical drag there is the card's own scroll, which the browser runs (`touch-action: pan-y`,
 * design/mobile.css), so all that is left to decide here is whether a press became a deliberate
 * sideways swipe. Numbers in and numbers out, so it can be tested without a browser. FocusDeck
 * owns the events.
 */

/** How far a press has to go before it has a direction at all. A tap never gets this far. */
export const SLOP = 12;

/** How many times its sideways travel has to beat its vertical travel to count as horizontal. */
export const DOMINANCE = 1.6;

/** A short swipe still turns when it is this fast (px/ms) and at least this long (px). */
export const FLICK_SPEED = 0.5;
export const FLICK_MIN = 36;

/**
 * A press on one of these is that control's, never the start of a swipe: a sideways drag means
 * something to it. A button or a link does not need to be here. Nothing is captured until a press
 * has gone clearly sideways, a tap never gets that far, and past that there is no click left to
 * protect, because a captured pointer sends its click to the deck.
 */
export const NOT_A_SWIPE = 'input, textarea, select, video, audio, [contenteditable]';

/**
 * 'x', 'y', or null for "not clear yet".
 *
 * Mostly-vertical is final as soon as it is seen. A diagonal stays undecided rather than being
 * called either way, so nothing is captured until the hand has clearly gone sideways.
 */
export function readDirection(dx, dy) {
  const across = Math.abs(dx);
  const down = Math.abs(dy);

  if (Math.max(across, down) < SLOP) {
    return null;
  }
  if (across >= down * DOMINANCE) {
    return 'x';
  }

  return down >= across ? 'y' : null;
}

/** Can this box still scroll the way a finger moving by `dx` would push it? */
export function hasRoom({ scrollLeft, scrollWidth, clientWidth }, dx) {
  const room = scrollWidth - clientWidth;

  if (room <= 1) {
    return false;
  }

  // A finger going left pulls the content left, which is towards the strip's far end.
  return dx < 0 ? scrollLeft < room - 1 : scrollLeft > 1;
}

/**
 * Does the gesture belong to a horizontal strip somewhere between the finger and the card?
 *
 * `chain` is those boxes: `{ overflowX, scrollLeft, scrollWidth, clientWidth }`. `hidden` does not
 * count, because a finger cannot scroll it.
 *
 * "No room" can only give a swipe back if the browser did not take the pan first. Chromium allows
 * `pan-x` on any `overflow-x: auto` box whether or not it overflows, which is every `pre` and
 * `table` on a phone, so a swipe that starts on one is likely to end in a pointercancel and no
 * turn. Read in its source and not measured. The rest of the card and the rail still turn.
 */
export function ownedByStrip(chain, dx) {
  return chain.some((box) => /auto|scroll/.test(box.overflowX) && hasRoom(box, dx));
}

/** How far a swipe has to travel to turn, for a screen this wide. */
export const swipeDistance = (width) => Math.min(120, Math.max(64, width * 0.22));

/** What letting go means: 1 next, -1 previous, 0 spring back. Left is forward, as in a pager. */
export function swipeStep(dx, ms, width) {
  const across = Math.abs(dx);
  const flicked = across >= FLICK_MIN && across / Math.max(ms, 1) >= FLICK_SPEED;

  if (across < swipeDistance(width) && !flicked) {
    return 0;
  }

  return dx < 0 ? 1 : -1;
}

/**
 * One pointer event on the deck, as a transition: what is held now and what to do about it.
 *
 * `press` is null or `{ id, x, y, at, swiping, dx }`. `event.type` is `down`, `move`, `up` or
 * anything else for a gesture that ended without a release; the fields it needs are read below.
 * `owned(dx)` is `ownedByStrip` for this press, asked only once it has gone sideways because that
 * has to measure. Back comes `{ press, capture, turn, dx }`: take the pointer if `capture`, and
 * turn the deck by `turn`, starting from `dx`.
 */
export function swipeEvent(press, event, owned = () => false) {
  const hold = (next) => ({
    press: next, capture: false, turn: 0, dx: 0,
  });

  if (event.type === 'down') {
    // A second finger is not a gesture, and does not end the first. A new first finger does end
    // whatever a release that never arrived left behind.
    if (!event.primary) {
      return hold(press);
    }
    if (event.button !== 0 || event.blocked) {
      return hold(null);
    }

    return hold({
      id: event.id, x: event.x, y: event.y, at: event.t, swiping: false, dx: 0,
    });
  }
  if (!press || event.id !== press.id) {
    return hold(press);
  }
  if (event.type === 'up') {
    return {
      press:   null,
      capture: false,
      turn:    press.swiping && event.canTurn ? swipeStep(press.dx, event.t - press.at, event.width) : 0,
      dx:      press.dx,
    };
  }
  // Nothing is held any more: a mouse let go somewhere this could not hear it.
  if (event.type !== 'move' || event.buttons === 0) {
    return hold(null);
  }
  const dx = event.x - press.x;

  if (press.swiping) {
    return hold({ ...press, dx });
  }
  const way = readDirection(dx, event.y - press.y);

  if (way === null) {
    return hold(press);
  }
  if (way === 'y' || owned(dx)) {
    return hold(null);
  }

  return {
    press: { ...press, swiping: true, dx }, capture: true, turn: 0, dx,
  };
}

/**
 * How far a scroller has to move to show an item, along one axis, by the rule
 * `scrollIntoView({ block: 'nearest' })` follows. Edges are in the same coordinates.
 *
 * Here because the deck's dots used that call, which also moves every scrollable ancestor,
 * `overflow: hidden` ones included. This moves only the box it is asked about.
 */
export function nearestDelta(boxStart, boxEnd, itemStart, itemEnd) {
  const before = itemStart < boxStart;
  const after = itemEnd > boxEnd;

  if (before === after) {
    return 0;
  }
  const fits = itemEnd - itemStart <= boxEnd - boxStart;

  return before === fits ? itemStart - boxStart : itemEnd - boxEnd;
}
