/**
 * What a review is waiting on once it has been submitted.
 *
 * Split out of `stageOf` in workspace-status.ts because it is a rule rather than a lookup, it
 * got decided wrongly, and a rule that got decided wrongly should be the kind of thing a test
 * can hold still. Pure and importless so `node --test` loads it directly, like issue-stage.mjs.
 *
 * The rule, in one line: a push is work, not an answer.
 *
 * Two things and only two take a review out of the developer's hands. They replied to your
 * comments, or they asked you to look again. A commit is neither. It can be a rebase, a merge
 * of main, or a change to something nobody raised, and nothing about its timestamp can tell
 * those apart from an answer - so counting it moved the stage off the person actually being
 * waited on. The pull request that prompted this read "Developer responded, round 3" beside its
 * own count of "0 answered, 13 waiting on the developer".
 *
 * `reRequested` is a real signal rather than an inferred one, which is why it is trusted where
 * a push is not: GitHub takes you off `requested_reviewers` the moment you submit a review, and
 * the only way back onto that list is the author asking for you by name.
 */

/**
 * @typedef {object} Since
 * @property {boolean} replied     They have written in a thread or the discussion since your review.
 * @property {boolean} reRequested You are back on the requested-reviewer list, having already reviewed.
 * @property {boolean} pushed      Commits landed since your review. Never on its own enough.
 */

/**
 * @param {Since} since
 * @returns {{ stage: 'response' | 'submitted', label: string, pushedSince: boolean }}
 */
export function afterSubmission({ replied = false, reRequested = false, pushed = false } = {}) {
  if (replied) {
    return {
      stage: 'response',
      // Both, when both: "replied and pushed" is more use than either half of it.
      label: pushed ? 'replied and pushed new commits' : 'replied to your comments',
      pushedSince: pushed,
    };
  }
  if (reRequested) {
    return { stage: 'response', label: 'asked you to look again', pushedSince: pushed };
  }

  return { stage: 'submitted', label: 'waiting for the developer', pushedSince: pushed };
}
