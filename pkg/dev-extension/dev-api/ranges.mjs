/**
 * The byte range a request asks for: what lets a video player seek.
 *
 * A browser plays a recording by asking for pieces of it, and decides whether it can seek at all
 * from whether the server answers those requests with `206` and `Accept-Ranges`. A route that sent
 * the whole file every time - GitHub attachments, an agent's own attachments - gave a player whose
 * scrub bar did nothing. One range, which is all a browser asks for; anything else gets the whole.
 *
 * Pure, for the tests: tests/ranges.test.mjs. server.mjs's `sendBytes` does the writing.
 */

/**
 * @param {string|undefined} header the request's `Range`
 * @param {number} size the body's length
 * @returns {{ start: number, end: number } | 'unsatisfiable' | null} null when the whole is wanted
 */
export function byteRange(header, size) {
  const asked = /^bytes=(\d*)-(\d*)$/.exec(String(header || '').trim());

  if (!asked || (!asked[1] && !asked[2]) || !(size > 0)) {
    return null;
  }
  // `bytes=-500` is the last 500; `bytes=100-` is from 100 to the end.
  const start = asked[1] ? parseInt(asked[1], 10) : Math.max(0, size - parseInt(asked[2], 10));
  const end = asked[1] && asked[2] ? Math.min(size - 1, parseInt(asked[2], 10)) : size - 1;

  return start > end || start >= size ? 'unsatisfiable' : { start, end };
}
