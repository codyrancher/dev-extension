// Where an action's prompt goes. Every case here is one that has gone wrong in the product.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { pickConversation, isDiscussion } from '../conversation-pick.mjs';

const REVIEW = { id: 'p-w_pr-19729-review-1', title: 'Review #19729' };
const FORK = { id: 'p-w_fork-8', title: 'Fork of Review #19729' };
const PLAIN = { id: 'p-w-2', title: 'Conversation 2' };

test('the tab on show wins, because it is the one you can see', () => {
  const got = pickConversation([REVIEW, PLAIN], { focused: PLAIN.id, pr: 19729 });

  assert.equal(got.id, PLAIN.id);
});

test('with nothing on show it goes to the conversation the action is about', () => {
  assert.equal(pickConversation([PLAIN, REVIEW], { pr: 19729 }).id, REVIEW.id);
  assert.equal(pickConversation([REVIEW, PLAIN], { pr: 19729 }).id, REVIEW.id);
});

test('a title carrying the PR number counts as being about it', () => {
  const named = { id: 'p-w-3', title: 'Thoughts on #19729' };

  // `named` is not last, so picking it can only be the "about" rule and not the fallback.
  assert.equal(pickConversation([named, PLAIN], { pr: 19729 }).id, named.id);
  // A different PR's number is not this PR's business, so the fallback takes the newest.
  assert.equal(pickConversation([named, PLAIN], { pr: 19630 }).id, PLAIN.id);
});

test('the newest is the last resort, not the first', () => {
  assert.equal(pickConversation([REVIEW, PLAIN], {}).id, REVIEW.id, 'about beats newest');
  assert.equal(pickConversation([PLAIN, { id: 'p-w-4', title: 'Notes' }], {}).id, 'p-w-4');
});

test('a focus that is no longer there falls through rather than returning nothing', () => {
  const got = pickConversation([REVIEW, PLAIN], { focused: 'p-w-gone', pr: 19729 });

  assert.equal(got.id, REVIEW.id);
});

test('`current` is honoured, but only after `focused`', () => {
  assert.equal(pickConversation([REVIEW, PLAIN], { current: PLAIN.id }).id, PLAIN.id);
  assert.equal(pickConversation([REVIEW, PLAIN, FORK], { focused: FORK.id, current: PLAIN.id }).id, FORK.id);
});

test('an empty list is nowhere to send, not a crash', () => {
  assert.equal(pickConversation([], { focused: 'x' }), null);
  assert.equal(pickConversation(null, {}), null);
  assert.equal(pickConversation([null, undefined], {}), null);
});

test('a discussion is recognised whatever has been done to the rest of the title', () => {
  assert.ok(isDiscussion('Discuss comment #18'));
  assert.ok(isDiscussion('Discuss ScriptsE2e.ts:104'));
  assert.ok(!isDiscussion('Discussion of the approach'), 'the word boundary matters');
  assert.ok(!isDiscussion('Review #19729'));
  assert.ok(!isDiscussion(''));
  assert.ok(!isDiscussion(null));
});

test('the measured regression: six discussions never become the target', () => {
  // PR 19729, as it stood: one review and six threads opened under findings, the threads newer.
  // The caller filters them out with isDiscussion; this asserts the pair does the job together.
  const raw = [
    REVIEW,
    { id: 'p-w_scripts-l26-2', title: 'Discuss scripts/e2e-stall-watchdog.ts:26' },
    { id: 'p-w_scripts-l68-3', title: 'Discuss scripts/e2e-stall-watchdog.ts:68' },
    { id: 'p-w_scripts-l104-4', title: 'Discuss scripts/e2e-stall-watchdog.ts:104' },
    { id: 'p-w_scripts-l135-5', title: 'Discuss scripts/e2e-stall-watchdog.ts:135' },
    { id: 'p-w_scripts-l148-6', title: 'Discuss scripts/e2e-stall-watchdog.ts:148' },
    { id: 'p-w_scripts-l158-7', title: 'Discuss scripts/e2e-stall-watchdog.ts:158' },
  ];
  const own = raw.filter((c) => !isDiscussion(c.title));

  // Even with the page pointing at a discussion, which is exactly what it was doing.
  const got = pickConversation(own, { focused: 'p-w_scripts-l104-4', current: 'p-w_scripts-l158-7', pr: 19729 });

  assert.equal(got.id, REVIEW.id);
});
