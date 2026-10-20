/**
 * How far along a piece of work is, decided once.
 *
 * Two places show stages and they were deciding differently. The workspace column asks the
 * workspace's own status, which is the careful answer: `stages.ts` keeps a stored stage per
 * workspace and lets a hard GitHub fact move it, a soft signal only fill it in, and a person's
 * choice hold against everything but ground truth. The Issue tracker did none of that - it
 * looked the issue up in the stored stages directly, so an issue whose workspace had been
 * deleted, or that never had one, showed no stage at all even when its pull request was merged.
 *
 * So the order is written down here, once, and both call it:
 *
 *   1. the workspace's status, when the issue has a workspace and that workspace's stage is
 *      known. This is the column's answer, and it already carries the store's reconciliation.
 *   2. the stored record, by workspace name and then by `issue-<n>`. Covers a workspace that
 *      has gone and a stage somebody set by hand before one existed.
 *   3. the issue's own GitHub facts, which are all that is left when nothing here has ever
 *      worked on it: a merged pull request is merged, an open one is in review, a closed issue
 *      with no pull request is merged-or-abandoned and reads as merged, and anything else has
 *      not started.
 *
 * Step 3 is the weak one and is meant to be. It cannot see a branch that exists with no pull
 * request, work in progress in somebody else's checkout, or a pull request that was opened and
 * closed without merging; it says "not started" for all three. What it must never do is
 * contradict steps 1 and 2, which know more - hence the order rather than a vote.
 *
 * Plain JavaScript and no imports, so `node --test` loads it directly - see
 * tests/issue-stage.test.mjs.
 */

/** The fix pipeline, in order. The same keys stages.ts stores and StageSteps draws. */
export const FIX_STAGES = ['assess', 'code', 'draft', 'review', 'feedback', 'merged'];

/** Where a stage sits in the pipeline, or -1 for one this does not know. */
export function stageIndex(stage, steps = FIX_STAGES) {
  return steps.indexOf(String(stage || ''));
}

/**
 * The stage of one issue, with where the answer came from.
 *
 * `source` is part of the answer rather than a debugging aid: a stage taken from a workspace's
 * status is one somebody can act on in that workspace, and a stage guessed from GitHub is not,
 * so a page may want to draw them differently. Returns `{ stage: '', index: -1 }` for work that
 * has not started.
 */
export function issueStage(issue, {
  workspace = '', statuses = {}, stages = {}, steps = FIX_STAGES,
} = {}) {
  const number = Number(issue?.number) || 0;
  const answer = (stage, round, source) => ({
    stage: stage || '', index: stageIndex(stage, steps), round: Number(round) || 1, source,
  });

  // 1. What the workspace column says, which is the reconciled answer.
  const status = workspace ? statuses[workspace] : null;

  if (status?.stage) {
    return answer(status.stage, status.round, 'workspace');
  }

  // 2. What was stored for it, under either name.
  const record = (workspace && stages[workspace]) || (number && stages[`issue-${ number }`]) || null;

  if (record?.stage) {
    return answer(record.stage, record.round, 'stored');
  }

  // 3. The issue itself. Last, because it knows least.
  return answer(...fromGithub(issue));
}

/**
 * What the issue's own fields imply, as `[stage, round, source]`.
 *
 * Deliberately conservative: everything it is not sure about is "not started", because the
 * cost of being wrong differs by direction. A stage shown too early tells somebody work is in
 * hand that is not, and they leave it alone; a stage left blank tells them nothing, which is
 * what they already had.
 */
function fromGithub(issue) {
  const pr = issue?.pr || issue?.pullRequest || null;
  const merged = !!(pr?.merged || pr?.mergedAt || issue?.mergedAt);

  if (merged) {
    return ['merged', 1, 'github'];
  }
  if (pr?.number) {
    // Open, and in front of somebody: `draft` is the pull request that exists but is not asking
    // for anything yet, which is the distinction the column draws too.
    return [pr.draft ? 'draft' : 'review', 1, 'github'];
  }
  // A closed issue with no pull request this product can see: it was dealt with somewhere else,
  // and saying "not started" about finished work is the more misleading of the two.
  if (String(issue?.state || '').toLowerCase() === 'closed') {
    return ['merged', 1, 'github'];
  }

  return ['', 1, 'none'];
}
