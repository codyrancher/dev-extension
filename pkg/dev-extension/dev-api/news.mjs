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

/** Fields present in an answer that are never the reason it changed, at any depth. */
export const NOT_NEWS = ['ageMs', 'watchedAt'];

/**
 * Clocks that matter up to a threshold and are all the same above it.
 *
 * `wroteAgo` is how many seconds ago a conversation's transcript last moved, and it is read in
 * exactly two ways: below zero means nobody has ever opened it, and at or under
 * `WORKING_WINDOW_SECONDS` (90, in chat-state.mjs) means an agent is working. Above ninety, two
 * values are indistinguishable to everything that reads them - so a pod with fifty-five idle
 * conversations was pushing a full snapshot every tick to report fifty-five numbers going up by
 * one, none of which anything could tell apart.
 *
 * Clamped rather than dropped, which is the difference between this and NOT_NEWS. Inside the
 * window the number really is news - that is a live agent - and a push is wanted. The clamp
 * keeps the one boundary the UI can see and flattens everything beyond it, so the comparison
 * ends up being over what a person could actually notice.
 */
export const SETTLED_CLOCKS = { wroteAgo: 90, subAgo: 90 };

/** How far down to look. Deep enough for an answer's own collections, shallow enough to be cheap. */
const MAX_DEPTH = 4;

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
  return JSON.stringify(settle(value, 0) ?? null);
}

/**
 * The value with its clocks taken out, all the way down.
 *
 * Top level only was not enough, and the way that was found is worth keeping: `/conversations`
 * carries `ageMs` at the top, which the first version of this stripped - and `wroteAgo` on every
 * one of the conversations inside it, which it could not reach. Half the pushes went away and
 * the other half carried on, which looked like a partial success and was actually the same bug
 * one level down.
 *
 * Returns a copy. The answer itself is what gets sent and must not be touched.
 */
function settle(value, depth) {
  if (!value || typeof value !== 'object' || depth > MAX_DEPTH) {
    return value ?? null;
  }
  if (Array.isArray(value)) {
    return value.map((item) => settle(item, depth + 1));
  }

  const keep = {};

  for (const [key, held] of Object.entries(value)) {
    if (NOT_NEWS.includes(key)) {
      continue;
    }
    if (key in SETTLED_CLOCKS && typeof held === 'number') {
      const ceiling = SETTLED_CLOCKS[key];

      keep[key] = held > ceiling ? ceiling + 1 : held;
      continue;
    }
    keep[key] = settle(held, depth + 1);
  }

  return keep;
}
