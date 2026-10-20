/**
 * Where a menu teleported to the body goes, given what it is attached to.
 *
 * A menu drawn next to its button is clipped by the first ancestor with an overflow - the
 * drawer's tab row scrolls horizontally, and an overflow on one axis clips the other - so these
 * menus are teleported to the body and positioned by hand. That trade is the reason this file
 * exists: nothing lays them out any more, so nothing keeps them on screen either. The first
 * version put the menu at `bottom + 4` and right-aligned it with the button, and both halves
 * fall off an edge - under a button near the foot of the window it runs past the bottom, and
 * right-aligned to a button near the left it runs past the left.
 *
 * So: below if it fits, above if below does not, the roomier side when neither does, and never
 * closer than `EDGE` to any edge. The answer carries a `maxHeight` because the last case is a
 * menu that does not fit either way - it is then as tall as the room it has and scrolls inside,
 * which is the one outcome that is always reachable.
 *
 * Pure arithmetic over four rectangles, so `node --test` checks every case - see
 * tests/menu-place.test.mjs. The DOM parts (measuring, re-placing on scroll) stay in the
 * component.
 */

/** How far a menu stays from the window's edges, and from the control it belongs to. */
export const EDGE = 8;
export const GAP = 4;

/**
 * `{ top, left, maxHeight, above }` in viewport coordinates, for `position: fixed`.
 *
 * `anchor` and `menu` are DOMRect-shaped (`{ top, bottom, left, right, width, height }`);
 * `view` is `{ width, height }`. `above` is part of the answer so a caller can draw the menu
 * differently when it has flipped - a shadow that lifts the other way, say - rather than
 * working it out again from the numbers.
 */
export function placeMenu(anchor, menu, view, { edge = EDGE, gap = GAP } = {}) {
  const width = Math.max(0, Number(menu?.width) || 0);
  const height = Math.max(0, Number(menu?.height) || 0);
  const viewW = Math.max(0, Number(view?.width) || 0);
  const viewH = Math.max(0, Number(view?.height) || 0);

  // Right-aligned with the control, which is where a caret's menu belongs: the button is at the
  // menu's corner, so the eye does not travel. Clamped into the window afterwards, and the
  // clamp wins - a menu aligned perfectly and half off the screen is not aligned.
  const wanted = (Number(anchor?.right) || 0) - width;
  const rightmost = viewW - width - edge;
  // A menu wider than the window has no placement that satisfies both edges; the left edge is
  // the one to keep, because that is where its text starts.
  const left = rightmost < edge ? edge : Math.min(Math.max(wanted, edge), rightmost);

  const below = (Number(anchor?.bottom) || 0) + gap;
  const above = (Number(anchor?.top) || 0) - gap - height;
  const roomBelow = viewH - edge - below;
  const roomAbove = (Number(anchor?.top) || 0) - gap - edge;

  if (height <= roomBelow) {
    return {
      top: below, left, maxHeight: 0, above: false,
    };
  }

  if (height <= roomAbove) {
    return {
      top: Math.max(above, edge), left, maxHeight: 0, above: true,
    };
  }

  // Neither side fits. Take the roomier one and cap the menu to it: `maxHeight` is non-zero
  // only here, so a caller can leave the menu its natural height in the common case and let it
  // scroll only when it has to.
  if (roomBelow >= roomAbove) {
    return {
      top: below, left, maxHeight: Math.max(0, roomBelow), above: false,
    };
  }

  return {
    top: edge, left, maxHeight: Math.max(0, roomAbove), above: true,
  };
}
