// Which triage step a bug is waiting on.
//
// One rule, and it decides what the only button on a row does: get it wrong and a bug in To
// Prioritize is offered "Review", which files a review of a bug somebody already reviewed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TRIAGE_ACTIONS, TRIAGE_MOVES, actionForStatus, actionForBug, jiraWorkspaceName, jiraStageOf, roleForStep
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

test('triaging a bug is one part to play, whichever step it is on', () => {
  // It was two, reviewer and reproducer, and a ticket crossed between them as a side effect of
  // a step being run - which split one person's queue into two piles. The step is the stage.
  assert.equal(roleForStep('review'), 'jira');
  assert.equal(roleForStep('unstick'), 'jira');
  assert.equal(roleForStep('reproduce'), 'jira');
  // Fixing a bug is ordinary development and groups with it, not with Jira.
  assert.equal(roleForStep('fix'), 'developer');
});

test('every step maps to a role the nav has a group for', () => {
  const groups = ['developer', 'reviewer', 'jira', 'other'];

  for (const action of Object.keys(TRIAGE_ACTIONS)) {
    assert.ok(groups.includes(roleForStep(action)), `${ action } -> ${ roleForStep(action) }`);
  }
});

test('every move has an id, both labels, and edits that are a function', () => {
  const ids = new Set();

  for (const move of TRIAGE_MOVES) {
    assert.ok(move.id, 'has an id');
    assert.equal(ids.has(move.id), false, `${ move.id } is declared twice`);
    ids.add(move.id);
    assert.ok(move.label, `${ move.id } has a label`);
    // The Actions row has one word of room; the panel has a sentence. Both, or the row shows
    // "Reviewed - move to In Triage" as a button.
    assert.ok(move.short, `${ move.id } has a short label`);
    assert.ok(move.about, `${ move.id } says what it does`);
    assert.equal(typeof move.edits, 'function', `${ move.id } builds its edits`);
    assert.ok(move.when.length, `${ move.id } says which statuses it is offered at`);
  }
});

test('a move is only offered at a status the process reaches it from', () => {
  // Every `when` has to be a status this team's own queues hold, or the button never appears -
  // which is the failure that cannot be seen by looking at the panel.
  const known = new Set(Object.values(TRIAGE_ACTIONS).flatMap((a) => a.states));

  for (const move of TRIAGE_MOVES) {
    for (const status of move.when) {
      assert.ok(known.has(status), `${ move.id } is offered at "${ status }", which no step covers`);
    }
  }
});

test("each move's edits are something to send", () => {
  const options = { defaults: { team: 'UI', assignee: 'gak', assigneeLabel: 'gary korhonen' } };

  for (const move of TRIAGE_MOVES) {
    const edits = move.edits(options);
    const something = edits.toStatus || edits.comment || edits.assignee || edits.resolution
      || edits.links?.length || 'team' in edits;

    assert.ok(something, `${ move.id } fills nothing in`);
  }
});

test('reviewing a new bug is the four edits the document asks for together', () => {
  // The one the document is explicit about, and the reason the panel composes an apply rather
  // than offering four buttons: doing them separately is how three of four get done.
  const edits = TRIAGE_MOVES.find((m) => m.id === 'to-triage')
    .edits({ defaults: { team: 'UI', assignee: 'gak' } });

  assert.equal(edits.toStatus, 'In Triage');
  assert.equal(edits.team, 'UI');
  assert.equal(edits.assignee, 'gak');
  assert.match(edits.comment, /In Triage/);
});
