// Which triage step a bug is waiting on.
//
// One rule, and it decides what the only button on a row does: get it wrong and a bug in To
// Prioritize is offered "Review", which files a review of a bug somebody already reviewed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TRIAGE_ACTIONS, actionForStatus, actionForBug, jiraWorkspaceName, jiraStageOf, roleForStep
} from '../jira-steps.mjs';

test('each step names a skill, and no status belongs to two of them', () => {
  const seen = new Map();

  for (const [id, step] of Object.entries(TRIAGE_ACTIONS)) {
    assert.match(step.skill, /^my-jira-bug-[a-z]+$/, `${ id } names a skill`);
    assert.ok(step.label, `${ id } has a label`);
    for (const status of step.states) {
      assert.equal(seen.get(status), undefined, `"${ status }" is claimed by ${ seen.get(status) } and ${ id }`);
      seen.set(status, id);
    }
  }
});

test('the step is the one the status asks for', () => {
  assert.equal(actionForStatus('New'), 'review');
  assert.equal(actionForStatus('In Triage'), 'reproduce');
  assert.equal(actionForStatus('Waiting for Reporter'), 'unstick');
  assert.equal(actionForStatus('Prioritized'), 'fix');
});

test('a status no step of this process covers gets none', () => {
  // Downstream of the team's triage: QA has it, or it is parked. Offering a step here would
  // start the wrong one.
  for (const status of ['To Test', 'QA Working', 'Blocked', 'Closed', '']) {
    assert.equal(actionForStatus(status), '', status || '(empty)');
  }
});

test("a mixed queue's row follows its own status, not the queue's", () => {
  // "All Team Bugs" carries `action: null` and holds every unresolved state at once.
  const all = { action: null };

  assert.equal(actionForBug({ status: 'In Triage' }, all), 'reproduce');
  assert.equal(actionForBug({ status: 'To Test' }, all), '');
  // And a queue that IS one status still answers from the status, which is the same answer.
  assert.equal(actionForBug({ status: 'New' }, { action: 'review' }), 'review');
});

test("the queue's step is the fallback, for a status the table does not know", () => {
  // A status renamed in Jira should not silently lose the button the filter already implies.
  assert.equal(actionForBug({ status: 'In Triage (new name)' }, { action: 'reproduce' }), 'reproduce');
});

test('the workspace is named for the bug, in the shape dev-api looks for', () => {
  assert.equal(jiraWorkspaceName('SURE-12345'), 'sure-12345');
  // dev-api matches `(^|-)<key>$`, so a prefixed workspace is found too.
  assert.match(`lte-${ jiraWorkspaceName('SURE-1') }`, new RegExp(`(^|-)${ jiraWorkspaceName('SURE-1') }$`));
});

test('a bug sits where its own status puts it', () => {
  assert.equal(jiraStageOf('New'), 'bug-new');
  assert.equal(jiraStageOf('In Triage'), 'bug-triage');
  assert.equal(jiraStageOf('Waiting for Reporter'), 'bug-waiting');
  // Everything past the team's own triage is one position: it has been reproduced and handed on.
  for (const status of ['To Prioritize', 'Prioritized', 'Needs Sign Off', 'In Development', 'Eng PR Review', 'To Test', 'QA Working', 'Blocked', 'Something New']) {
    assert.equal(jiraStageOf(status), 'bug-prioritized', status);
  }
});

test('a resolution is what finishes a bug, whatever the column says', () => {
  // The case that mattered: a duplicate is rejected and left in New. Reading the status alone
  // would put it back at the top of the queue with "Review it" on the button.
  assert.equal(jiraStageOf('New', 'Duplicate'), 'bug-done');
  assert.equal(jiraStageOf('In Triage', 'Fixed'), 'bug-done');
  assert.equal(jiraStageOf('Closed'), 'bug-done');
  assert.equal(jiraStageOf('Rejected'), 'bug-done');
  // And an empty resolution is not a resolution.
  assert.equal(jiraStageOf('New', ''), 'bug-new');
  assert.equal(jiraStageOf('New', null), 'bug-new');
});

test('the part you play is the step you are taking', () => {
  assert.equal(roleForStep('review'), 'jira-reviewer');
  assert.equal(roleForStep('unstick'), 'jira-reviewer');
  assert.equal(roleForStep('reproduce'), 'jira-reproducer');
  // Fixing a bug is ordinary development and groups with it, not with the two Jira roles.
  assert.equal(roleForStep('fix'), 'developer');
});

test('every step maps to a role the nav has a group for', () => {
  const groups = ['developer', 'reviewer', 'jira-reviewer', 'jira-reproducer', 'other'];

  for (const action of Object.keys(TRIAGE_ACTIONS)) {
    assert.ok(groups.includes(roleForStep(action)), `${ action } -> ${ roleForStep(action) }`);
  }
});
