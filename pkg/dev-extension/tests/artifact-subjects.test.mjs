/**
 * Which issue or pull request a workspace name is about.
 *
 * `node --test pkg/dev-extension/tests/*.test.mjs`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { numbersIn } from '../artifact-subjects.mjs';

test('a workspace name says what it is about', () => {
  assert.deepEqual(numbersIn('lte-issue-14904'), { issue: 14904, pr: 0 });
  assert.deepEqual(numbersIn('issue-19351'), { issue: 19351, pr: 0 });
  assert.deepEqual(numbersIn('lte-pr-19152'), { issue: 0, pr: 19152 });
  // Not a number that merely appears in the name.
  assert.deepEqual(numbersIn('lte-standardize-drawers-2'), { issue: 0, pr: 0 });
  assert.deepEqual(numbersIn(''), { issue: 0, pr: 0 });
  assert.deepEqual(numbersIn(undefined), { issue: 0, pr: 0 });
});
