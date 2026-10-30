// A counted section title, and the one rule that matters: the pieces and the string agree.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { threadsTitle, titleOf } from '../rail-titles.mjs';

test('the pieces spell the title exactly', () => {
  for (const [answered, waiting] of [[5, 0], [0, 3], [0, 0], [12, 7]]) {
    const counted = threadsTitle(answered, waiting);

    assert.equal(titleOf(counted.parts), counted.title);
    assert.equal(counted.title, `Your threads (${ answered } answered, ${ waiting } waiting on the developer)`);
  }
});

test('each count carries its own tone and nothing else does', () => {
  const { parts } = threadsTitle(5, 3);

  assert.deepEqual(parts.filter((p) => p.tone), [{ text: '5', tone: 'good' }, { text: '3', tone: 'warn' }]);
});

test('a nought is drawn plain, because a colour there would say the opposite of what is true', () => {
  assert.deepEqual(threadsTitle(5, 0).parts.filter((p) => p.tone), [{ text: '5', tone: 'good' }]);
  assert.deepEqual(threadsTitle(0, 3).parts.filter((p) => p.tone), [{ text: '3', tone: 'warn' }]);
  assert.deepEqual(threadsTitle(0, 0).parts.filter((p) => p.tone), []);
});
