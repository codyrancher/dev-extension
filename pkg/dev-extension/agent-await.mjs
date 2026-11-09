/**
 * Whether a card handed to an agent is still the agent's: the Focus deck's "put aside until the
 * agent stops", as a pure function of what was recorded at the hand-off and the latest snapshot.
 * focus.ts gives it its types (`awaitingAgent`); it lives here so the node tests can reach it.
 */

/** The states that mean it has stopped and the work is yours again. `gone` counts: it is news. */
export const SETTLED_STATES = new Set(['input', 'idle', 'finished', 'gone']);

/**
 * How long a card stays aside before the snapshot has to justify it.
 *
 * Between pressing the button and the agent actually picking the prompt up there are seconds -
 * sometimes a minute, if the workspace pod is still coming up - in which the snapshot still says
 * what was true before the press: a conversation that was stopped reads as stopped, and one that
 * has just been started is not in it at all. Inside the window neither of those releases the card;
 * only something that has moved since the hand-off does. After it, the conversation has to be
 * seen working.
 */
export const HANDOVER_GRACE_MS = 45_000;

/**
 * Whether the card is waiting on an agent rather than on a person.
 *
 * Pressing the button records the conversation and its counters, and the card is held back until
 * one of those counters moves - which is exactly "the agent finished or has a question", because
 * entering idle/finished is the only thing that moves `stops` and entering input is the only thing
 * that moves `asks`. The counters and not a revision: a revision moves when the agent *starts*,
 * which would bring the card back five seconds after the agent picked the work up.
 *
 * The ways back out, every one of them erring towards showing the card:
 *
 *   - either counter moved;
 *   - the loop has stopped (`stale`), because a watcher that has quietly died must not be able to
 *     hide work for a week. Note: NOT on a failed exec - that is a busy cluster, which is when the
 *     cards should stay hidden;
 *   - the epoch is not the one the counters came from, so a document somebody deleted releases
 *     every card instead of stranding them;
 *   - `bornAt` differs, because `sessions.sh new` reuses the lowest free ordinal and the id you
 *     handed work to may now be somebody else's conversation;
 *   - once the grace window is over: the conversation has settled whatever the counters say (a
 *     prompt that was queued and never started never moves one, and a card held on that would be
 *     held for ever), or the snapshot has still never heard of it.
 *
 * The grace window used to be checked last, after "settled", so it never covered the case it was
 * written for: a stopped conversation, typed into and started again, read as settled until the next
 * snapshot - and the card came back on top for those seconds, under a notice saying it had gone.
 * Moving on in that gap meant that when it did go, the deck dealt one card more than was pressed.
 *
 * What it cannot tell is which way the news went. Two transitions inside one tick are one change,
 * and a conversation that finished and was asked again looks like one that was only asked unless
 * the counters happen to disagree. It is paid where it is cheapest: the card comes back either way,
 * and what it is about is read off the conversation when the card is drawn.
 *
 * @param {{ conversation: string, epoch?: string, bornAt?: string, stops: number, asks: number, at: string } | null | undefined} held
 *   what was recorded when the card was handed over
 * @param {{ stale?: boolean, epoch?: string, conversations: Record<string, { state: string, stops: number, asks: number, bornAt?: string }> } | null | undefined} agents
 *   the latest conversation snapshot
 * @param {number} [now] the time to judge at, for the tests
 * @returns {boolean}
 */
export function stillWithAgent(held, agents, now = Date.now()) {
  if (!held) {
    return false;
  }
  if (!agents || agents.stale || (held.epoch && agents.epoch && held.epoch !== agents.epoch)) {
    return false;
  }

  const fresh = now - Date.parse(held.at) < HANDOVER_GRACE_MS;
  const seen = agents.conversations?.[held.conversation];

  if (!seen) {
    return fresh;
  }
  if (held.bornAt && seen.bornAt && held.bornAt !== seen.bornAt) {
    return false;
  }
  if (seen.stops !== held.stops || seen.asks !== held.asks) {
    return false;
  }

  return fresh || seen.state === 'working';
}
