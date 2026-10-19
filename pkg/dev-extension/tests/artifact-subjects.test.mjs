/**
 * What a set of artifacts is evidence about, and what belongs on one card.
 *
 * The bug these pin: the page listed directories, so evidence about one issue was split across
 * every workspace that had worked on it, and a workspace still running was not on the page at all
 * because nothing had been kept from it yet.
 *
 * `node --test pkg/dev-extension/tests/*.test.mjs`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  numbersIn, subjectOf, subjectKey, groupSubjects
} from '../artifact-subjects.mjs';

test('a workspace name says what it is about', () => {
  assert.deepEqual(numbersIn('lte-issue-14904'), { issue: 14904, pr: 0 });
  assert.deepEqual(numbersIn('issue-19351'), { issue: 19351, pr: 0 });
  assert.deepEqual(numbersIn('lte-pr-19152'), { issue: 0, pr: 19152 });
  // Not a number that merely appears in the name.
  assert.deepEqual(numbersIn('lte-standardize-drawers-2'), { issue: 0, pr: 0 });
  assert.deepEqual(numbersIn(''), { issue: 0, pr: 0 });
  assert.deepEqual(numbersIn(undefined), { issue: 0, pr: 0 });
});

test('the tag outranks the name, because it can say what no name could', () => {
  // A workspace called `scratch` that was pointed at an issue by hand.
  assert.deepEqual(subjectOf({ workspace: 'scratch', issue: 19517, pr: 0 }), { issue: 19517, pr: 0 });
  // A tag that says nothing is not an answer: the sets written before tags existed carry a
  // marker file with no numbers in it, and their names are all there is to go on.
  assert.deepEqual(subjectOf({ workspace: 'lte-issue-7468', issue: 0, pr: 0 }), { issue: 7468, pr: 0 });
  assert.deepEqual(subjectOf({ workspace: 'lte-issue-7468' }), { issue: 7468, pr: 0 });
});

test('an issue outranks a pull request raised for it', () => {
  assert.equal(subjectKey({ workspace: 'lte-issue-19517' }), 'issue-19517');
  assert.equal(subjectKey({ workspace: 'w', issue: 19517, pr: 19600 }), 'issue-19517');
  assert.equal(subjectKey({ workspace: 'lte-pr-19152' }), 'pr-19152');
  // About neither: the workspace is its own subject rather than going into a bucket.
  assert.equal(subjectKey({ workspace: 'lte-standardize-drawers' }), 'ws-lte-standardize-drawers');
});

test('a live workspace and a kept set about one issue are one card', () => {
  const [subject, ...rest] = groupSubjects([
    {
      workspace: 'lte-issue-19517', live: true, issue: 0, pr: 0, at: '2026-10-19T16:50:00Z', files: 9
    },
    {
      workspace: 'issue-19517', live: false, issue: 19517, pr: 0, at: '2026-10-11T09:00:00Z', files: 4
    },
  ]);

  assert.equal(rest.length, 0, 'one subject, not two directories');
  assert.equal(subject.key, 'issue-19517');
  assert.equal(subject.issue, 19517);
  assert.equal(subject.files, 13, 'the count is the subject\'s, across its sources');
  // Work still arriving reads before a record of work that is over.
  assert.deepEqual(subject.sources.map((s) => s.live), [true, false]);
});

test('subjects are ordered by the most recent thing that happened in them', () => {
  const subjects = groupSubjects([
    {
      workspace: 'lte-issue-100', live: false, at: '2026-10-01T00:00:00Z', files: 1
    },
    {
      workspace: 'lte-issue-200', live: true, at: '2026-10-19T12:00:00Z', files: 1
    },
    {
      workspace: 'lte-pr-300', live: false, at: '2026-10-10T00:00:00Z', files: 1
    },
  ]);

  assert.deepEqual(subjects.map((s) => s.key), ['issue-200', 'pr-300', 'issue-100']);
  assert.deepEqual(subjects.map((s) => s.kind), ['issue', 'pr', 'issue']);
});

test('a source with no workspace is not a source', () => {
  assert.deepEqual(groupSubjects([{ live: true, files: 3 }]), []);
  assert.deepEqual(groupSubjects(null), []);
  assert.deepEqual(groupSubjects(undefined), []);
});

test('a source that never said when is still listed', () => {
  const subjects = groupSubjects([{ workspace: 'lte-issue-1', live: true, files: 2 }]);

  assert.equal(subjects.length, 1);
  assert.equal(subjects[0].at, 0);
  assert.equal(subjects[0].files, 2);
});
