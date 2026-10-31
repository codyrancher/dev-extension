import { test } from 'node:test';
import assert from 'node:assert/strict';

import { newsOf, NOT_NEWS } from '../dev-api/news.mjs';

test('an age that moves is not news, which is the bug this is for', () => {
  const before = { conversations: [{ id: 'a' }], ageMs: 1200, watchedAt: '2026-10-31T00:00:00.000Z' };
  const after = { conversations: [{ id: 'a' }], ageMs: 6200, watchedAt: '2026-10-31T00:00:05.000Z' };

  assert.notEqual(JSON.stringify(before), JSON.stringify(after), 'the whole answer differs, which is why a plain compare pushed every tick');
  assert.equal(newsOf(before), newsOf(after));
});

test('a real change is still news, age or no age', () => {
  const before = { conversations: [{ id: 'a' }], ageMs: 1200 };
  const after = { conversations: [{ id: 'a' }, { id: 'b' }], ageMs: 1200 };

  assert.notEqual(newsOf(before), newsOf(after));
});

test('a change hidden behind a moving age is still news', () => {
  const before = { conversations: [{ id: 'a', state: 'running' }], ageMs: 10 };
  const after = { conversations: [{ id: 'a', state: 'waiting' }], ageMs: 9000 };

  assert.notEqual(newsOf(before), newsOf(after));
});

test('every field it drops is one it is allowed to drop', () => {
  const full = { keep: 1, ageMs: 5, watchedAt: 'x' };

  assert.equal(newsOf(full), JSON.stringify({ keep: 1 }));
  assert.deepEqual(NOT_NEWS, ['ageMs', 'watchedAt']);
});

test('an array answer is compared whole, because freshness has nowhere to hide in one', () => {
  assert.equal(newsOf([{ ageMs: 1 }]), JSON.stringify([{ ageMs: 1 }]));
  assert.notEqual(newsOf([{ ageMs: 1 }]), newsOf([{ ageMs: 2 }]));
});

test('a scalar or missing answer compares as itself rather than throwing', () => {
  assert.equal(newsOf(null), 'null');
  assert.equal(newsOf(undefined), 'null');
  assert.equal(newsOf(7), '7');
  assert.equal(newsOf('hi'), '"hi"');
  assert.equal(newsOf(null), newsOf(undefined), 'a failed read and an empty one must not look like news against each other');
});

test('the answer itself is not modified, since it is what gets sent', () => {
  const answer = { conversations: [], ageMs: 42 };

  newsOf(answer);
  assert.equal(answer.ageMs, 42);
});
