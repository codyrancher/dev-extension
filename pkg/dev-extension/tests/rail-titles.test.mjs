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

test('a round that came back is counted first, and the three still add up', () => {
  const counted = threadsTitle(13, 0, 1);

  assert.equal(titleOf(counted.parts), counted.title);
  assert.equal(counted.title, 'Your threads (1 replied since your review, 13 answered earlier, 0 waiting on the developer)');
  assert.deepEqual(counted.parts.filter((p) => p.tone), [{ text: '1', tone: 'new' }, { text: '13', tone: 'good' }]);
  assert.equal(threadsTitle(5, 2, 0).title, 'Your threads (5 answered, 2 waiting on the developer)');
});
