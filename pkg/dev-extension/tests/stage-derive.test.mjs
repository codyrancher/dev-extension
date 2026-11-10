// A workspace's stage, worked out once for the dashboard and dev-api alike.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  reviewWork, fixWork, toDerived, reconcileRecord, displayOf, activityTimes, stageInputs, workspaceNumbers, isFixWorkspace,
} from '../stage-derive.mjs';

const ME = 'cody';
const T0 = '2026-11-01T10:00:00Z';
const T1 = '2026-11-02T10:00:00Z';

const pr = (over = {}) => ({
  meta: {
    number: 9, title: 'A fix', url: 'u', author: 'dev', state: 'OPEN', merged: false, approved: false, draft: false, reviewers: [], ...(over.meta || {}),
  },
  commits:        over.commits || [{ date: T0, login: 'dev' }],
  reviewComments: over.reviewComments || [],
  discussion:     over.discussion || [],
  reviews:        over.reviews || [],
  localComments:  over.localComments || [],
  run:            over.run || null,
  viewer:         ME,
});

test('names: a pull request, an issue, a SURE bug - and a PR number is not a Jira key', () => {
  assert.deepEqual(workspaceNumbers('lte-pr-19711'), { pr: 19711, issue: 0, bug: '' });
  assert.deepEqual(workspaceNumbers('issue-42'), { pr: 0, issue: 42, bug: '' });
  assert.deepEqual(workspaceNumbers('sure-123'), { pr: 0, issue: 0, bug: 'SURE-123' });
  assert.equal(isFixWorkspace('issue-42'), true);
  assert.equal(isFixWorkspace('lte-pr-1'), false);
  assert.equal(isFixWorkspace('scratch', 'developer'), true);
});

test('a review: the agent at work, findings to go through, waiting, answered, approved', () => {
  assert.equal(reviewWork(pr({ run: { state: 'running' } }), 'working').stage, 'agent');
  assert.equal(reviewWork(pr({ localComments: [{ submitted_at: null }] }), 'idle').stage, 'findings');

  const reviewed = { reviews: [{ author: ME, state: 'COMMENTED', submittedAt: T0 }] };

  assert.equal(reviewWork(pr(reviewed), 'idle').stage, 'submitted');
  // A push is not an answer.
  assert.equal(reviewWork(pr({ ...reviewed, commits: [{ date: T1, login: 'dev' }] }), 'idle').stage, 'submitted');
  assert.equal(reviewWork(pr({ ...reviewed, discussion: [{ author: 'dev', createdAt: T1 }] }), 'idle').stage, 'response');
  assert.equal(reviewWork(pr({ ...reviewed, meta: { reviewers: [ME] } }), 'idle').label, 'asked you to look again');
  assert.equal(reviewWork(pr({ reviews: [{ author: ME, state: 'APPROVED', submittedAt: T0 }] }), 'idle').stage, 'approved');
  assert.equal(reviewWork(pr({ meta: { merged: true } }), 'idle').stageLabel, 'Merged');
});

test('a fix: assess and code before a PR, then draft, review, feedback, merged', () => {
  assert.equal(fixWork(null, 'working', false).stage, 'assess');
  assert.equal(fixWork(null, 'idle', true).stage, 'code');
  assert.equal(fixWork(null, 'idle', true).soft, true);
  assert.equal(fixWork(pr({ meta: { draft: true } }), 'idle').stage, 'draft');
  assert.equal(fixWork(pr(), 'idle').stage, 'review');
  assert.equal(fixWork(pr({ discussion: [{ author: 'reviewer', createdAt: T1 }] }), 'idle').stage, 'feedback');
  assert.equal(fixWork(pr({ meta: { merged: true } }), 'idle').stage, 'merged');
});

test('the store: hard facts win, soft guesses only move forward, a hand-set stage holds', () => {
  const opts = { now: T1, fallbackRepo: 'rancher/dashboard' };
  const soft = toDerived('fix', { stage: 'code', soft: true }, 0, 'rancher/dashboard');
  const hard = toDerived('fix', { stage: 'review' }, 9, 'rancher/dashboard');

  // Nothing stored: whatever was derived.
  assert.deepEqual(reconcileRecord(undefined, soft, opts).record.stage, 'code');
  // A soft guess forward from a soft stage, but never back from a hard one.
  assert.equal(reconcileRecord({ stage: 'assess', hard: false, repo: 'rancher/dashboard' }, soft, opts).record.stage, 'code');
  assert.equal(reconcileRecord({ stage: 'review', hard: true, repo: 'rancher/dashboard' }, soft, opts).write, false);
  // A hand-set stage holds against a soft guess and yields to a hard fact.
  const manual = {
    stage: 'draft', manual: true, hard: true, repo: 'rancher/dashboard'
  };

  assert.equal(reconcileRecord(manual, soft, opts).write, false);
  assert.equal(reconcileRecord(manual, hard, opts).record.manual, false);
  // The same stage again is no write.
  const stored = reconcileRecord(undefined, hard, opts).record;

  assert.equal(reconcileRecord(stored, hard, { ...opts, now: '2026-11-03T00:00:00Z' }).write, false);
  // Another repository's record is not this workspace's.
  assert.equal(reconcileRecord({ ...stored, repo: 'rancher/other' }, hard, opts).write, true);
});

test('what the row shows: the derived words when the stages agree, the stage\'s own tone when not', () => {
  const w = { stage: 'feedback', label: 'respond to the review', tone: 'attention' };

  assert.equal(displayOf({ stage: 'feedback', round: 1 }, w).label, 'respond to the review');
  assert.deepEqual(displayOf({ stage: 'draft', manual: true }, w), {
    stage: 'draft', stageLabel: 'Draft PR', reviewed: false, round: 1, label: '', tone: 'attention'
  });
});

test('activity: others and you, bots and unmatched commits left out', () => {
  const d = pr({
    discussion: [{ author: 'dev', createdAt: T1 }, { author: 'dependabot[bot]', createdAt: '2026-11-05T00:00:00Z' }],
    reviews:    [{ author: ME, submittedAt: T0 }],
    commits:    [{ date: '2026-11-04T00:00:00Z', login: '' }],
  });

  assert.deepEqual(activityTimes(d), { othersAt: Date.parse(T1), spokeAt: Date.parse(T0) });
});

test('the inputs kept between reads carry no diff and no bodies', () => {
  const kept = stageInputs({
    ...pr({ discussion: [{ author: 'dev', createdAt: T1, body: 'long' }] }), files: [{ patch: 'x'.repeat(1000) }],
  });

  assert.equal(kept.files, undefined);
  assert.equal(kept.discussion[0].body, undefined);
  assert.equal(reviewWork(kept, 'idle').stage, reviewWork(pr({ discussion: [{ author: 'dev', createdAt: T1 }] }), 'idle').stage);
});
