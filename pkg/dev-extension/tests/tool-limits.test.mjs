// The ceiling on dev servers: three workspaces at once, and what the fourth is told.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toolLimit, toolSlotRefusal, leaseLeft } from '../tool-limits.mjs';

const NOW = Date.parse('2026-11-12T12:00:00Z');
const at = (min) => new Date(NOW + min * 60000).toISOString();
const three = [
  { workspace: 'lte-pr-1233', expires: at(80) },
  { workspace: 'lte-issue-16671', expires: at(12) },
  { workspace: 'lte-issue-7468', expires: at(65) },
];

test('dev servers have a ceiling of three; other tools none', () => {
  assert.equal(toolLimit('dev-server'), 3);
  assert.equal(toolLimit('storybook'), 0);
  assert.equal(toolSlotRefusal('storybook', 'x', [...three, { workspace: 'y' }], NOW), '');
});

test('under the ceiling, a start goes ahead', () => {
  assert.equal(toolSlotRefusal('dev-server', 'lte-new', three.slice(0, 2), NOW), '');
  assert.equal(toolSlotRefusal('dev-server', 'lte-new', [], NOW), '');
});

test('a workspace that already holds one may ask again: that renews it and takes no new place', () => {
  assert.equal(toolSlotRefusal('dev-server', 'lte-issue-7468', three, NOW), '');
});

test('the fourth is refused, with who holds them, soonest lease first', () => {
  const r = toolSlotRefusal('dev-server', 'lte-new', three, NOW);

  assert.match(r, /^All 3 dev servers are in use: /);
  assert.ok(r.indexOf('lte-issue-16671 (lease ends in 12 min)') < r.indexOf('lte-issue-7468 (lease ends in 1 h 5 min)'));
  assert.ok(r.indexOf('lte-issue-7468') < r.indexOf('lte-pr-1233 (lease ends in 1 h 20 min)'));
  assert.match(r, /tools stop dev-server/);
});

test('leaseLeft reads like a person would say it', () => {
  assert.equal(leaseLeft(at(42), NOW), 'in 42 min');
  assert.equal(leaseLeft(at(60), NOW), 'in 1 h');
  assert.equal(leaseLeft(at(-5), NOW), 'now');
  assert.equal(leaseLeft('', NOW), 'with no lease');
});
