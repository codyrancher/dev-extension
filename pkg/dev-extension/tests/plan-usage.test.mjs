// What the sidebar's usage bar is drawn from: Anthropic's /api/oauth/usage answer, cut down.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { usageFrom } from '../seed/agent/plan-usage.mjs';

// The shape measured on 2026-11-09, trimmed: most keys are null on a Max plan.
const ANSWER = {
  five_hour:        null,
  seven_day:        { utilization: 7, resets_at: '2026-11-15T22:00:00.166288+00:00' },
  seven_day_opus:   null,
  seven_day_sonnet: { utilization: 41.6, resets_at: '2026-11-15T22:00:00+00:00' },
  extra_usage:      null,
  limits:           {},
};

test('the week is the bar, rounded, with when it starts again', () => {
  const got = usageFrom(ANSWER, 'max');

  assert.deepEqual(got.week, { percent: 7, resetsAt: '2026-11-15T22:00:00.166288+00:00' });
  assert.equal(got.plan, 'max');
  assert.deepEqual(got.sonnet, { percent: 42, resetsAt: '2026-11-15T22:00:00+00:00' });
});

test('a window the plan does not have is null, not zero', () => {
  const got = usageFrom(ANSWER);

  assert.equal(got.session, null);
  assert.equal(got.opus, null);
});

test('an answer of nothing is no numbers at all', () => {
  assert.deepEqual(usageFrom(null), {
    plan: '', week: null, session: null, opus: null, sonnet: null,
  });
  assert.equal(usageFrom({ seven_day: { utilization: 'lots' } }).week, null);
});
