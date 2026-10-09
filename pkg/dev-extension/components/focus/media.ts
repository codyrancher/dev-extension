/**
 * A recording's still, in two steps, because one of them is not enough.
 *
 * Shared by everything that draws a recording small: the tiles in MediaViewer and the thumbnails
 * on a card's facts row (MediaStrip).
 *
 * **The fragment paints something.** `preload="metadata"` fetches the header and nothing else,
 * which is what keeps a grid of five recordings the cost of five headers rather than five
 * videos; `#t=0.1` on top of it sets the element's initial seek position, so the browser decodes
 * and paints that frame instead of leaving a tile the colour of its own background. Measured in
 * Chrome 131 against a real 18.4s agent recording: the tile paints a decoded frame, and the
 * fragment is honoured as a seek - `#t=3` and `#t=8` of the same file paint visibly different
 * pictures.
 *
 * Left alone if the caller's URL already carries a fragment: `workspaceMediaFileUrl` builds a
 * query, not a hash, but a GitHub asset URL is somebody else's string and may hold anything.
 */
export function firstFrame(src: string): string {
  return src.includes('#') ? src : `${ src }#t=0.1`;
}

/**
 * **And the nudge makes it a picture of something.** The frame a tenth of a second in is very
 * often blank: a recording of a dashboard flow opens on the page before it has painted. On the
 * same 18.4s recording, every frame up to about 2.2s was plain white - three recordings of three
 * different fixes would have been three identical white tiles, which is the grid failing at the
 * one thing it is for.
 *
 * So once the metadata is in and the duration is known, the still moves to a quarter of the way
 * in, capped at three seconds. A quarter because it has to be inside the clip whatever its
 * length, and a cap because the seek is the one thing here that costs more than a header - three
 * seconds of video, once, per recording on screen.
 *
 * It runs after the fragment has already put a frame up, so a seek that never lands leaves the
 * tile with the opening frame rather than with nothing. For a `<video>`'s `loadedmetadata`.
 */
export function still(event: Event): void {
  const video = event.target as HTMLVideoElement;
  const { duration } = video;

  if (Number.isFinite(duration) && duration > 0) {
    video.currentTime = Math.min(3, duration / 4);
  }
}
