/**
 * One answer to "how far along is this", for both places that ask.
 *
 * `node --test pkg/dev-extension/tests/*.test.mjs`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { issueStage, stageIndex, FIX_STAGES } from '../issue-stage.mjs';

const ISSUE = { number: 19524, state: 'open' };

test('the workspace\'s own status wins, because it is the reconciled answer', () => {
  const got = issueStage(ISSUE, {
    workspace: 'lte-issue-19524',
    statuses:  { 'lte-issue-19524': { stage: 'feedback', round: 2 } },
    stages:    { 'lte-issue-19524': { stage: 'code', round: 1 } },
  });

  assert.deepEqual(got, {
    stage: 'feedback', index: 4, round: 2, source: 'workspace',
  });
});

test('the stored stage answers when the workspace is gone', () => {
  // The case the tracker got wrong: a workspace deleted after the work was done.
  const got = issueStage(ISSUE, { stages: { 'issue-19524': { stage: 'merged', round: 3 } } });

  assert.equal(got.stage, 'merged');
  assert.equal(got.index, 5);
  assert.equal(got.round, 3);
  assert.equal(got.source, 'stored');
});

test('a stored stage is found under the workspace name too', () => {
  const got = issueStage(ISSUE, { workspace: 'lte-issue-19524', stages: { 'lte-issue-19524': { stage: 'draft' } } });

  assert.equal(got.stage, 'draft');
  assert.equal(got.source, 'stored');
});

test('with nothing stored, the issue\'s own pull request decides', () => {
  assert.equal(issueStage({ ...ISSUE, pr: { number: 1, merged: true } }).stage, 'merged');
  assert.equal(issueStage({ ...ISSUE, pr: { number: 1 } }).stage, 'review');
  assert.equal(issueStage({ ...ISSUE, pr: { number: 1, draft: true } }).stage, 'draft');
  // mergedAt is the other spelling GitHub answers with.
  assert.equal(issueStage({ ...ISSUE, pullRequest: { number: 1, mergedAt: '2026-10-01T00:00:00Z' } }).stage, 'merged');
});

test('a closed issue with no pull request reads as done rather than as untouched', () => {
  const got = issueStage({ number: 1, state: 'closed' });

  assert.equal(got.stage, 'merged');
  assert.equal(got.source, 'github');
});

test('an open issue nothing has touched has no stage at all', () => {
  const got = issueStage(ISSUE);

  assert.deepEqual(got, {
    stage: '', index: -1, round: 1, source: 'none',
  });
  // And the drawing can tell that apart from a stage it does not recognise.
  assert.equal(stageIndex(''), -1);
  assert.equal(stageIndex('nonsense'), -1);
});

test('a status with no stage falls through rather than blanking the answer', () => {
  // A workspace that exists but whose status has not been read yet: the stored stage is still
  // the better answer, and the column used to show nothing in this window.
  const got = issueStage(ISSUE, {
    workspace: 'lte-issue-19524',
    statuses:  { 'lte-issue-19524': { stage: '' } },
    stages:    { 'lte-issue-19524': { stage: 'code' } },
  });

  assert.equal(got.stage, 'code');
  assert.equal(got.source, 'stored');
});

test('the pipeline is the one the stepper draws', () => {
  assert.deepEqual(FIX_STAGES, ['assess', 'code', 'draft', 'review', 'feedback', 'merged']);
  assert.equal(stageIndex('assess'), 0);
  assert.equal(stageIndex('merged'), 5);
});

test('nothing at all is not a crash', () => {
  assert.equal(issueStage(null).index, -1);
  assert.equal(issueStage(undefined, {}).index, -1);
});
