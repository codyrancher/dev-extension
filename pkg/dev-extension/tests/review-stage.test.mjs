import { test } from 'node:test';
import assert from 'node:assert/strict';

import { afterSubmission } from '../review-stage.mjs';

test('a push on its own does not take the review out of the developer\'s hands', () => {
  const out = afterSubmission({ pushed: true });

  assert.equal(out.stage, 'submitted', 'this is the bug: a commit is work, not an answer');
  assert.equal(out.label, 'waiting for the developer');
  assert.equal(out.pushedSince, true, 'but the rail still gets to offer a look at it');
});

test('nothing at all is still waiting', () => {
  assert.equal(afterSubmission({}).stage, 'submitted');
  assert.equal(afterSubmission().stage, 'submitted', 'and no argument must not throw');
});

test('a reply is a response', () => {
  const out = afterSubmission({ replied: true });

  assert.equal(out.stage, 'response');
  assert.equal(out.label, 'replied to your comments');
});

test('a re-review request is a response, because only the author can cause one', () => {
  const out = afterSubmission({ reRequested: true });

  assert.equal(out.stage, 'response');
  assert.equal(out.label, 'asked you to look again');
});

test('replied and pushed says both, because either half alone is less use', () => {
  assert.equal(afterSubmission({ replied: true, pushed: true }).label, 'replied and pushed new commits');
});

test('a push alongside a re-request does not change what happened', () => {
  const out = afterSubmission({ reRequested: true, pushed: true });

  assert.equal(out.stage, 'response');
  assert.equal(out.label, 'asked you to look again');
});

test('a reply outranks a re-request in the label, since it is the more specific thing', () => {
  assert.equal(afterSubmission({ replied: true, reRequested: true }).label, 'replied to your comments');
});

test('pushedSince travels on every answer, so the rail never has to guess', () => {
  for (const since of [{ pushed: true }, { replied: true, pushed: true }, { reRequested: true, pushed: true }]) {
    assert.equal(afterSubmission(since).pushedSince, true);
  }
  assert.equal(afterSubmission({ replied: true }).pushedSince, false);
});
