// Whether the agent's own pass over a pull request is still being made.
//
// Pure, and in a module of its own, because the stage derivation got this wrong twice and the
// reasoning is worth a test: `reviewWork` (workspace-status.ts) read "there are findings" as
// "the agent has finished finding things", which it never meant. A review pass writes its
// findings one at a time over an hour or more, so the first one landed, the rail moved to Your
// pass, and the step stayed there for the rest of the run - with the agent's own conversation
// directly underneath it saying eleven subagents, two still working.
//
// The signal is the agent's own report, not a guess about it. The review skills post their
// progress to `POST /my-work/pr/<n>/review-run` as they go (RUN_STATES in dev-api/server.mjs),
// so the run record says "running" while the pass is being made and "complete" when it is done.
// That is a fact rather than an inference from transcript mtimes - which is what the busy/idle
// bucket is, and why it cannot carry this on its own: a pass spent inside subagents writes
// nothing to the main transcript for minutes at a time and reads `idle` while it does.

/**
 * The run states that mean the pass has not finished.
 *
 * `idle` is deliberately not among them: it is the skill saying it has stopped, which is the
 * one thing a running pass is not. `failed` and `cancelled` are over, and `complete` is the
 * report this whole thing is waiting for.
 */
export const RUNNING_RUN_STATES = ['starting', 'waiting-for-sidecars', 'running'];

/**
 * Whether the agent is still making its pass, from the run record and the conversation's state.
 *
 * The run record alone would be enough if every run ended with a report, and most do - but an
 * agent that is killed, or whose pod goes away mid-pass, leaves `running` standing for ever, and
 * a stage pinned on it would never reach the person who has to make the next move. So the
 * conversation has to still be there: `none` (no pane ever) and `finished` (the pane is gone)
 * both end the pass whatever the record says.
 *
 * `idle` does NOT end it, and that is the point of asking the record at all. A pass whose work
 * is in subagents leaves the main transcript quiet past the working window, so `idle` is the
 * normal reading halfway through a long one; it is only the record that can tell that from a
 * pass that is genuinely over.
 *
 * @param {{ state?: string } | null | undefined} run The review's run record, if it has one.
 * @param {'working' | 'input' | 'idle' | 'finished' | 'none'} agent The conversation's state.
 * @returns {boolean}
 */
export function passRunning(run, agent) {
  if (!RUNNING_RUN_STATES.includes(String(run?.state || ''))) {
    return false;
  }

  return agent !== 'none' && agent !== 'finished';
}
