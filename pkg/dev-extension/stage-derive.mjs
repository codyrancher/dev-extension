/**
 * Where a workspace's work is: its stage, derived from the pull request and the agent, and the
 * rules that decide whether a derived stage may replace the one already stored.
 *
 * One copy, imported by both halves. The dashboard derives a workspace's stage when it reads its
 * status (workspace-status.ts) and so does dev-api, on a clock of its own, for every workspace -
 * so a stage moves, and the Automations log hears `stage.changed`, whether or not anybody has a
 * page open. Two writers of one store is safe because they are the same rules over the same
 * inputs: dev-api's own pull request detail, the agent states its watcher keeps, and the stored
 * record (stages.ts holds the store's reading and writing; the trust rules are here).
 *
 * Pure: the inputs are passed in. tests/stage-derive.test.mjs.
 */
import { afterSubmission } from './review-stage.mjs';
import { passRunning } from './review-pass.mjs';
import { readFrom } from './workspace-repos.mjs';

/** The latest of some timestamps, as milliseconds; 0 when there are none. */
export const latestOf = (dates) => Math.max(0, ...dates.map((d) => Date.parse(d || '') || 0));

const latest = latestOf;

/** Whether a login is a bot's, whose comments and approvals are not a person's word. */
export const isBot = (login) => /\[bot\]$/i.test(login || '') || /^(github-actions|dependabot|codecov|renovate)/i.test(login || '');

/**
 * A question outranks work in progress. A workspace's state is the busiest of its conversations',
 * and with `working` on top a question went invisible behind a sibling that happened to be busy.
 */
export const AGENT_RANK = {
  none: 0, finished: 1, idle: 2, working: 3, input: 4,
};

/**
 * What a workspace's name says it is for: a pull request (`pr-123`, `lte-pr-123`), an issue, or
 * a SURE bug - and SURE alone, since `pr-19711` has exactly the shape of a Jira key.
 */
export function workspaceNumbers(name) {
  return {
    pr:    Number(/(?:^|-)pr-(\d+)(?:-|$)/.exec(name)?.[1]) || 0,
    issue: Number(/(?:^|-)issue-(\d+)(?:-|$)/.exec(name)?.[1]) || 0,
    bug:   (/(?:^|-)(sure-\d+)(?:-|$)/.exec(name)?.[1] || '').toUpperCase(),
  };
}

/** Whether a workspace is its owner's own work: named for an issue, or labelled a developer's. */
export function isFixWorkspace(name, role = '') {
  const { pr, issue } = workspaceNumbers(name);

  return !pr && (issue > 0 || role === 'developer');
}

/**
 * A review workspace (`pr-<n>`): the person reviews someone else's PR with an agent's help.
 *
 * Read from the PR and the review's own comments (which ride in prDetail): the agent's
 * findings not yet submitted are the person's to go through; a submitted review is waiting
 * on the developer until they push or answer; an approval, theirs or anyone's, is done.
 */
export function reviewWork(d, agent) {
  const m = d.meta || {};
  const local = d.localComments || [];
  const submitted = local.filter((c) => c.submitted_at);
  const pending = local.filter((c) => !c.submitted_at);
  // A review YOU left on GitHub itself counts as submitted too - but only yours. Counting
  // anyone's put the stage back to "waiting for the developer" the moment a bot approved the
  // PR, days after the developer had answered.
  const viewer = d.viewer || '';
  const reviews = (d.reviews || []).filter((r) => r.submittedAt && (viewer ? r.author === viewer : r.author && r.author !== m.author && !isBot(r.author)));
  // Your own latest opinionated review. GitHub's PR-wide `approved` (m.approved) is true only when
  // every required reviewer has approved and none is requesting changes - so another reviewer's
  // "changes requested" from rounds ago keeps it false even after you approve today. This is your
  // reviewer workspace and the stage is about your review: if the last opinion you left is an
  // approval, your review is done, whatever the rest of the PR is still waiting on.
  const myLatestOpinion = (d.reviews || [])
    .filter((r) => r.author === viewer && ['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(r.state))
    .sort((a, b) => (Date.parse(a.submittedAt || '') || 0) - (Date.parse(b.submittedAt || '') || 0))
    .pop();
  const iApproved = !!viewer && myLatestOpinion?.state === 'APPROVED';
  // How many times you have already sent this PR a review. The same review is often recorded
  // twice - once as the comments submitted here, once as GitHub's own review - so they are
  // counted by the minute they went out rather than one by one.
  const rounds = new Set([...submitted.map((c) => c.submitted_at), ...reviews.map((r) => r.submittedAt)]
    .map((at) => String(at || '').slice(0, 16))
    .filter(Boolean)).size;

  if (m.merged) {
    return {
      label: '', tone: 'green', stage: 'approved', stageLabel: 'Merged',
    };
  }
  if (m.approved || iApproved) {
    return { label: '', tone: 'green', stage: 'approved' };
  }
  /*
   * The agent is still making its pass.
   *
   * Above the findings, and that is the whole of the fix: a pass writes its findings one at a
   * time over an hour, so the first one used to move the rail to Your pass and the step stayed
   * there for the rest of the run - with the conversation directly beneath it saying eleven
   * subagents, two still working. "There are findings" never meant "the agent has finished
   * finding things".
   *
   * What says so is the agent's own report rather than a guess about it - see review-pass.mjs,
   * which has the reasoning and the one thing the busy/idle bucket cannot carry alone.
   *
   * Hard, not soft: a stage already latched on the first finding is exactly what has to be
   * corrected, and a soft signal by definition cannot undo a stored one.
   */
  if (passRunning(d.run, agent)) {
    return {
      label:    pending.length ? `${ pending.length } finding${ pending.length === 1 ? '' : 's' } so far` : '',
      tone:     'working',
      stage:    'agent',
      reviewed: rounds > 0,
      round:    rounds + 1,
    };
  }
  if (submitted.length || reviews.length) {
    const submittedAt = Math.max(latest(submitted.map((c) => c.submitted_at)), latest(reviews.map((r) => r.submittedAt)));
    const pushed = latest((d.commits || []).map((c) => c.date)) > submittedAt;
    const replied = latest([...(d.discussion || []), ...(d.reviewComments || [])].filter((c) => c.author === m.author).map((c) => c.createdAt)) > submittedAt;

    // Findings of the agent's that have not gone anywhere are a pass waiting to be made,
    // whichever round this is: the rail goes back to Your pass and carries the round with it.
    // A review is a loop, not a line, and the step that says what you have to do is this one.
    if (pending.length) {
      return {
        label: 'go through the new findings', tone: 'attention', stage: 'findings', reviewed: true, round: rounds + 1,
      };
    }

    // Whether this is a reply or still waiting turns on who you are (your review, your comments). If
    // the viewer's identity came back blank - a degraded read - that distinction is not trustworthy,
    // so it is marked soft and the store keeps whatever it already had rather than dropping, say, a
    // stored Approved to Submitted for one bad read.
    /*
     * Only two things end your wait: they answered you, or they asked you to look again.
     *
     * A push is neither, and used to be treated as one whenever a change request of yours was
     * still standing. That is how a pull request with thirteen threads waiting on the developer
     * and none of them answered came to read "Developer responded, round 3": the developer had
     * pushed, and nothing else. A commit is work, not a reply - it can be a rebase, a merge of
     * main, or a change to something nobody asked about - and a timestamp cannot tell those
     * apart from an answer. Treating it as one moves the stage off the person who is actually
     * being waited on, and the review's own count sitting beside it said so.
     *
     * `reRequested` is the second thing, and it is a real signal rather than an inferred one:
     * GitHub drops you from `requested_reviewers` the moment you submit a review, and the only
     * way back onto that list is the author asking for you again. So your name being there,
     * after you have already reviewed, is the author saying "another look, please" in the one
     * place that cannot be confused with a push.
     *
     * `pushed` survives as a label: when they have answered AND pushed, "replied and pushed" is
     * more use than either half. A push on its own falls through to `submitted` below, which is
     * where it belongs - and `REVIEW_NEEDS` has no `submitted` key, so it makes no card, which
     * is the point.
     */
    const reRequested = !!viewer && (m.reviewers || []).some((login) => login === viewer);
    const since = afterSubmission({ replied, reRequested, pushed });

    return {
      label:       since.label,
      tone:        since.stage === 'response' ? 'attention' : 'waiting',
      stage:       since.stage,
      reviewed:    true,
      round:       rounds,
      soft:        !viewer,
      pushedSince: since.pushedSince,
    };
  }
  if (agent === 'working') {
    return { label: '', tone: 'working', stage: 'agent', soft: true };
  }
  if (pending.length) {
    return { label: 'read the agent\'s findings', tone: 'attention', stage: 'findings' };
  }
  // The agent's pass finished and what it found is gone - read and deleted, every one of them.
  // That is a pass made, not a review still to run: falling back to Agent review offered to
  // review the PR again, which is the opposite of what emptying the list said. The run record
  // is what remembers, because the findings themselves no longer exist to say so.
  // Soft, unlike the pending-findings case above where findings actually exist: this is inferred
  // from the run record with an empty list, which a degraded read can also produce. It still carries
  // a soft 'agent' stage forward to findings (higher rank), but must not knock back a stored Approved.
  if (d.run?.state === 'complete') {
    return { label: 'nothing left to go through', tone: 'muted', stage: 'findings', soft: true };
  }
  if (agent === 'input') {
    return { label: '', tone: 'attention', stage: 'agent', soft: true };
  }

  return { label: 'not started', tone: 'muted', stage: 'agent', soft: true };
}

/**
 * A fix workspace (`issue-<n>`): the agent writes the code and opens a PR the person owns.
 *
 * Without a PR the agent is the story. With one: a draft is the person's to read and mark
 * ready (the skills never do), a review from someone else after the last push is theirs to
 * answer, and otherwise the PR waits for a reviewer.
 */
export function fixWork(d, agent, coded = false) {
  if (!d) {
    // Before a PR the branch says which of the first two stages this is: commits on it mean the
    // code is being written (or is written); none, and the agent is still assessing.
    const stage = coded ? 'code' : 'assess';

    if (agent === 'working') {
      return { label: '', tone: 'working', stage, soft: true };
    }
    if (agent === 'input') {
      return { label: '', tone: 'attention', stage, soft: true };
    }

    return { label: 'no PR yet', tone: 'muted', stage, soft: true };
  }
  const m = d.meta || {};

  if (m.merged) {
    return { label: '', tone: 'green', stage: 'merged' };
  }
  if (m.approved) {
    return {
      label: 'ready to merge', tone: 'green', stage: 'merged', stageLabel: 'Approved',
    };
  }
  const comments = [...(d.discussion || []), ...(d.reviewComments || [])];
  const others = latest(comments.filter((c) => c.author && c.author !== m.author && !isBot(c.author)).map((c) => c.createdAt));
  const mine = Math.max(latest(comments.filter((c) => c.author === m.author).map((c) => c.createdAt)), latest((d.commits || []).map((c) => c.date)));

  if (others > mine) {
    return { label: 'respond to the review', tone: 'attention', stage: 'feedback' };
  }
  if (agent === 'working') {
    return { label: '', tone: 'working', stage: m.draft ? 'draft' : 'review' };
  }
  if (m.draft) {
    return { label: 'read it and mark it ready', tone: 'attention', stage: 'draft' };
  }
  if (m.state === 'CLOSED') {
    return {
      label: '', tone: 'muted', stage: 'merged', stageLabel: 'Closed',
    };
  }

  return { label: 'waiting for a reviewer', tone: 'waiting', stage: 'review' };
}

/** A derived work state, packaged for the store to reconcile against what it already holds. */
export function toDerived(kind, w, pr, repo) {
  return {
    kind, stage: w.stage || (kind === 'review' ? 'agent' : 'assess'), stageLabel: w.stageLabel, soft: !!w.soft, round: w.round || 1, reviewed: !!w.reviewed, pr, repo,
  };
}

/** What each stage is called: the rail's stepper, the page's headline and the sidebar's line. */
export const STAGE_LABELS = {
  assess:            'Assess',
  code:              'Code',
  draft:             'Draft PR',
  review:            'In review',
  feedback:          'Feedback',
  merged:            'Merged',
  agent:             'Agent review',
  findings:          'Your pass',
  submitted:         'Submitted',
  response:          'Developer responded',
  approved:          'Approved',
  'bug-new':         'New',
  'bug-triage':      'In Triage',
  'bug-waiting':     'Waiting for Reporter',
  'bug-prioritized': 'Reproduced',
  'bug-done':        'Done',
};

/** A stage's own tone, for when the stored stage is not the one just derived and has no note of its own. */
export const STAGE_TONE = {
  assess: 'muted', code: 'muted', draft: 'attention', review: 'waiting', feedback: 'attention', merged: 'green',
  agent: 'muted', findings: 'attention', submitted: 'waiting', response: 'attention', approved: 'green',
  'bug-new': 'attention', 'bug-triage': 'attention', 'bug-waiting': 'waiting', 'bug-prioritized': 'green', 'bug-done': 'green',
};

/**
 * The stored stage, as the row shows it. When it is the one just derived, the derived state's own
 * words and tone are used - they say the most; when they differ - a manual hold, or a soft guess
 * the store would not follow - the stage's name stands alone in the stage's own tone.
 */
export function displayOf(rec, w) {
  const match = rec.stage === w.stage;

  return {
    stage:      rec.stage,
    stageLabel: rec.stageLabel || STAGE_LABELS[rec.stage] || '',
    reviewed:   !!rec.reviewed,
    round:      rec.round || 1,
    label:      match ? (w.label || '') : '',
    tone:       match ? w.tone : (STAGE_TONE[rec.stage] || 'muted'),
  };
}

/**
 * When somebody else last did something on a pull request, and when you last spoke on it: what
 * "new" in the sidebar is, whatever stage the heuristics settle on. Bots do not count; an unsent
 * draft of yours is not you speaking, and a commit GitHub could not match to an account is left out.
 */
export function activityTimes(d) {
  const viewer = d?.viewer || '';

  if (!d || !viewer) {
    return { othersAt: 0, spokeAt: 0 };
  }
  const said = [
    ...(d.reviewComments || []).filter((c) => !c.pending).map((c) => ({ who: c.author, at: c.createdAt })),
    ...(d.discussion || []).map((c) => ({ who: c.author, at: c.createdAt })),
    ...(d.reviews || []).map((r) => ({ who: r.author, at: r.submittedAt })),
  ].filter((x) => x.who && !isBot(x.who));
  const theirCommits = (d.commits || []).filter((c) => c.login && c.login !== viewer && !isBot(c.login)).map((c) => c.date);

  return {
    othersAt: latest([...said.filter((x) => x.who !== viewer).map((x) => x.at), ...theirCommits]),
    spokeAt:  latest([...said.filter((x) => x.who === viewer).map((x) => x.at), ...(d.localComments || []).map((c) => c.submitted_at)]),
  };
}

/**
 * What of a pull request's detail the stage reads, and nothing else: no diff, no bodies. dev-api
 * keeps this per workspace between GitHub reads, so a stage can be re-derived when the agent or a
 * local comment moves without asking GitHub again.
 */
export function stageInputs(d) {
  if (!d) {
    return null;
  }
  const m = d.meta || {};

  return {
    meta: {
      number: m.number, title: m.title || '', url: m.url || '', author: m.author || '', state: m.state || '', merged: !!m.merged, approved: !!m.approved, draft: !!m.draft, reviewers: m.reviewers || [],
    },
    commits:        (d.commits || []).map((c) => ({ date: c.date, login: c.login || '' })),
    reviewComments: (d.reviewComments || []).map((c) => ({ author: c.author, createdAt: c.createdAt, pending: !!c.pending })),
    discussion:     (d.discussion || []).map((c) => ({ author: c.author, createdAt: c.createdAt })),
    reviews:        (d.reviews || []).map((r) => ({ author: r.author, state: r.state, submittedAt: r.submittedAt })),
    localComments:  (d.localComments || []).map((c) => ({ submitted_at: c.submitted_at || null })),
    run:            d.run || null,
    viewer:         d.viewer || '',
  };
}

// ── The store's trust rules ─────────────────────────────────────────────────────────────────
//
// How advanced each stage is within its kind, so a soft signal can carry a workspace forward but
// not back. A hard signal ignores this - a review dropping from Approved back to Your pass on a
// new round is real progress, not a regression - so ranking only ever gates soft moves.

const FIX_ORDER = ['assess', 'code', 'draft', 'review', 'feedback', 'merged'];
const REVIEW_ORDER = ['agent', 'findings', 'submitted', 'response', 'approved'];

function stageRank(kind, stage) {
  const i = (kind === 'review' ? REVIEW_ORDER : FIX_ORDER).indexOf(stage);

  return i < 0 ? 0 : i;
}

/** The record a derived stage would be stored as. */
export function recordOf(d, manual, hard, now, fallbackRepo) {
  return {
    stage: d.stage, stageLabel: d.stageLabel, manual, hard, round: d.round, reviewed: d.reviewed, pr: d.pr, repo: d.repo || fallbackRepo, at: now,
  };
}

/** Whether two records say the same thing - everything but when they were made. */
export function sameRecord(a, b, fallbackRepo) {
  return a.stage === b.stage && a.stageLabel === b.stageLabel && a.manual === b.manual && a.hard === b.hard && a.round === b.round && a.reviewed === b.reviewed &&
    readFrom(a, b.repo, fallbackRepo);
}

/**
 * The stored stage for a workspace, reconciled with what was just derived: `{ record, write }`,
 * where `write` says the store has to change. A hard fact wins (and releases a manual hold), a
 * soft guess never undoes a stored stage, a manual choice holds until a hard fact overtakes it.
 * A record read from another repository is not this workspace's, and is replaced as if absent.
 */
export function reconcileRecord(stored0, d, { now = new Date().toISOString(), fallbackRepo = '' } = {}) {
  const stored = stored0 && readFrom(stored0, d.repo, fallbackRepo) ? stored0 : undefined;
  const accept = (manual, hard) => {
    const record = recordOf(d, manual, hard, now, fallbackRepo);

    return { record, write: !stored || !sameRecord(stored, record, fallbackRepo) };
  };

  if (!stored) {
    return accept(false, !d.soft);
  }
  if (stored.manual) {
    return d.soft ? { record: stored, write: false } : accept(false, true);
  }
  if (!d.soft) {
    return accept(false, true);
  }
  if (!stored.hard && stageRank(d.kind, d.stage) > stageRank(d.kind, stored.stage)) {
    return accept(false, false);
  }

  return { record: stored, write: false };
}
