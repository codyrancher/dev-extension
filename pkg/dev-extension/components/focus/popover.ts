// Where a popover goes when the control it opens from is inside the card.
//
// Every box between a card's facts line and the page clips: `.ev` is `overflow: hidden` so the
// fact line can ellipsise, `.card__facts` is `overflow: hidden` so the band is 37px on every card,
// `.card__body` is `overflow: hidden` so it cannot scroll the surface away, and `.card` is
// `overflow: hidden` so the hue closes it. A `position: absolute` popover inside that chain is
// clipped by the first of them, and the card is transformed by the deck besides - so `fixed` is
// fixed to the transform rather than to the window.
//
// The answer the rest of this view already uses is `Teleport to="body"` inside a `.dev-focus`
// wrapper (MediaViewer, TextModal, FocusModal all do it). What a teleported popover still needs is
// somewhere to be, because it has left the element it belongs to: this reads the control's own box
// and hands back the coordinates, kept on screen at both edges.
//
// Shared because there are two of them now - the failing checks and the facts line's own overflow
// - and two copies of "measure the button, clamp to the window" is two chances for them to stop
// agreeing about which edge they open from.

/** Viewport coordinates for a popover opening under `el`, as inline styles. */
export function under(el: HTMLElement | null | undefined, width = 320): Record<string, string> {
  const box = el?.getBoundingClientRect();

  if (!box) {
    // Nothing to anchor to: off screen rather than in the top-left corner, which reads as a bug.
    return { top: '-999px', left: '-999px' };
  }
  const room = Math.max(8, window.innerWidth - width - 8);

  return {
    position: 'fixed',
    top:      `${ Math.round(box.bottom + 6) }px`,
    left:     `${ Math.round(Math.min(Math.max(8, box.left), room)) }px`,
  };
}
