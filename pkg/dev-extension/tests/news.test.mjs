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

test('freshness inside an array is found too — it had somewhere to hide, and that was the bug', () => {
  // This test used to assert the opposite, on the theory that an array answer could be compared
  // whole. `/conversations` disproved it: the clocks that mattered were on the objects *inside*
  // the array, so half the pushes went away with the top-level strip and half carried on.
  assert.equal(newsOf([{ ageMs: 1 }]), newsOf([{ ageMs: 2 }]));
  assert.notEqual(newsOf([{ ageMs: 1, id: 'a' }]), newsOf([{ ageMs: 1, id: 'b' }]));
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

/* ── Nested clocks: the half of the bug the first fix could not reach ───────────────────── */

test('an idle conversation whose wroteAgo climbs is not news', () => {
  const at = (n) => ({ conversations: [{ id: 'a', state: 'idle', wroteAgo: n }], ageMs: 10 });

  assert.equal(newsOf(at(300)), newsOf(at(9000)), 'both are "long ago" to everything that reads it');
});

test('fifty-five idle conversations ticking together are still not news', () => {
  const at = (base) => ({
    ageMs:         1,
    conversations: Array.from({ length: 55 }, (_, i) => ({ id: `c${ i }`, wroteAgo: base + i })),
  });

  assert.equal(newsOf(at(600)), newsOf(at(900)));
});

test('but crossing the working window IS news, because the dot changes', () => {
  const at = (n) => ({ conversations: [{ id: 'a', wroteAgo: n }] });

  assert.notEqual(newsOf(at(80)), newsOf(at(200)), '80 is working, 200 is not');
  assert.notEqual(newsOf(at(89)), newsOf(at(91)), 'the boundary itself');
});

test('inside the window every second is news, because that is a live agent', () => {
  const at = (n) => ({ conversations: [{ id: 'a', wroteAgo: n }] });

  assert.notEqual(newsOf(at(10)), newsOf(at(11)));
});

test('never opened stays distinct from long ago', () => {
  const at = (n) => ({ conversations: [{ id: 'a', wroteAgo: n }] });

  assert.notEqual(newsOf(at(-1)), newsOf(at(5000)), '-1 means no transcript at all');
});

test('subAgo settles the same way, since it is read against the same window', () => {
  const at = (n) => ({ conversations: [{ id: 'a', subAgo: n }] });

  assert.equal(newsOf(at(400)), newsOf(at(4000)));
  assert.notEqual(newsOf(at(30)), newsOf(at(400)));
});

test('a real change under a settled clock is still news', () => {
  const a = { conversations: [{ id: 'a', state: 'running', wroteAgo: 500 }] };
  const b = { conversations: [{ id: 'a', state: 'waiting', wroteAgo: 900 }] };

  assert.notEqual(newsOf(a), newsOf(b));
});

test('a dropped field nested in an array is dropped there too', () => {
  const a = { items: [{ id: 1, ageMs: 5 }] };
  const b = { items: [{ id: 1, ageMs: 70000 }] };

  assert.equal(newsOf(a), newsOf(b));
});

test('the answer is not modified, however deep the walk goes', () => {
  const answer = { ageMs: 42, conversations: [{ id: 'a', wroteAgo: 9000, ageMs: 7 }] };

  newsOf(answer);
  assert.equal(answer.ageMs, 42);
  assert.equal(answer.conversations[0].wroteAgo, 9000);
  assert.equal(answer.conversations[0].ageMs, 7);
});
