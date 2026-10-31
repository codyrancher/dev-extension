/**
 * What counts as news about a watched path, as against what is merely in its answer.
 *
 * A subscription is only worth having if it is quiet when nothing has changed, and both halves of
 * the hub decide that the same way: by comparing the answer they just read against the one before
 * it. Which means a single field that moves on every read defeats the whole thing.
 *
 * `/conversations` has one. It carries `ageMs` - how long ago the listing that produced it ran -
 * so two reads of a completely idle cluster differ, every tick, forever. dev-api pushed a full
 * snapshot to every subscribed tab every five seconds, and the page re-ranked its deck on every
 * one of them. It read as working, too: three revisions in fifteen seconds looks exactly like a
 * busy cluster rather than like broken change detection.
 *
 * So the comparison drops these fields and the frame keeps them. `watchedAt` goes with `ageMs`
 * because it is the same instant written as an ISO string; a reader who wants to know how fresh a
 * snapshot is wants the value sitting in it, not a push telling them a second has gone by.
 *
 * Shared rather than written twice: dev-api decides what to send and the browser decides what to
 * hand a listener, and the two disagreeing is its own bug. `scripts/gen-dev-api.mjs` inlines this
 * into the packed server; `events.ts` imports it directly.
 *
 * Pure: a value in, a string out.
 */

/** Fields present in an answer that are never the reason it changed. */
export const NOT_NEWS = ['ageMs', 'watchedAt'];

/**
 * The comparable text of an answer: everything about it except what always moves.
 *
 * Only top-level fields are dropped, and only on a plain object - an array or a scalar answer is
 * compared whole, because there is nowhere for freshness to hide in one.
 *
 * @param {unknown} value The answer a watched path just returned.
 * @returns {string} Text equal to the text of any answer that is not news against this one.
 */
export function newsOf(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return JSON.stringify(value ?? null);
  }

  const keep = { ...value };

  for (const key of NOT_NEWS) {
    delete keep[key];
  }

  return JSON.stringify(keep);
}
