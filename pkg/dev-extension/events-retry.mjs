/**
 * How long to wait before trying the event socket again, and when to stop believing it is up.
 *
 * Its own module so `node --test` can get at it. A reconnect delay is exactly the kind of
 * arithmetic that looks right and turns into a hot loop against the cluster the first time a
 * proxy refuses an upgrade.
 */

/** The first wait, and the longest. Doubling in between. */
export const FIRST_MS = 1_000;
export const LONGEST_MS = 30_000;

/**
 * The wait before attempt `attempt` (counting from 1), with jitter.
 *
 * Doubling, capped, and then spread across the range rather than landing on the number: every
 * page in the building reconnects when the dev-api pod rolls, and without jitter they all come
 * back at the same instant and roll it again. Full jitter - a uniform pick from zero to the
 * backoff - is the variant that spreads a herd best.
 *
 * @param {number} attempt - how many times in a row the socket has failed
 * @param {number} random - a number in [0, 1); passed in so this is testable
 */
export function backoffMs(attempt, random = Math.random()) {
  const ceiling = Math.min(LONGEST_MS, FIRST_MS * 2 ** Math.max(0, attempt - 1));

  // Never zero: a "reconnect" that happens in the same tick is a loop, not a retry.
  return Math.max(250, Math.round(ceiling * random));
}

/**
 * Whether a connection counts as having worked.
 *
 * A socket that opens and dies two seconds later has not worked - it is a proxy accepting the
 * upgrade and then dropping it - and treating it as success resets the backoff and turns the
 * reconnect into a tight loop. So the attempt counter only resets once a socket has been up
 * long enough to have been useful.
 */
export const STABLE_MS = 10_000;

export function wasStable(openedAt, now) {
  return openedAt > 0 && now - openedAt >= STABLE_MS;
}

/**
 * What to send, and whether to bother sending it.
 *
 * The subscription is always the full set, so a reconnect is one frame and no bookkeeping. This
 * only answers whether the set has actually changed since the last frame, because a page that
 * mounts six components would otherwise send six frames saying almost the same thing.
 *
 * @param {Iterable<string>} wanted
 * @param {string} sentBefore - what `subscription` returned last time, or ''
 * @returns {{ changed: boolean, frame: string, sent: string }}
 */
export function subscription(wanted, sentBefore) {
  const paths = [...new Set(wanted)].sort();
  const sent = paths.join('\n');

  return { changed: sent !== sentBefore, frame: JSON.stringify({ sub: paths }), sent };
}
