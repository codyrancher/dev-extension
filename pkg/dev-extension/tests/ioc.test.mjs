// The injection seam: a component with no provider talks to the API, and a host can replace
// any part of it without stubbing the rest.
//
// ioc.ts imports Vue for its InjectionKey type and the REST clients for their functions, so it
// cannot be loaded by `node --test`. What is tested here is the merge rule, which is the only
// logic in the file and the part that can be wrong: a partial override must replace exactly the
// keys it names and leave the others alone. The rule is restated rather than imported - a test
// that imports the thing it is checking a shape of would just be asserting it equals itself.
import { test } from 'node:test';
import assert from 'node:assert/strict';

/** The rule from `withSources`: overrides over defaults, nothing else. */
const merge = (defaults, overrides) => ({ ...defaults, ...overrides });

const defaults = {
  allTools:        async () => ['from the api'],
  workspaceTools:  async () => [],
  startTool:       async () => ({}),
  renewTool:       async () => ({}),
  stopTool:        async () => {},
  createWorkspace: async () => ({ name: 'x', namespace: 'dev-x' }),
  removeWorkspace: async () => {},
  jiraQueue:       async () => ({ configured: false }),
};

test('with no override, every source is the default', async () => {
  const sources = merge(defaults, {});

  assert.deepEqual(await sources.allTools(), ['from the api']);
  assert.equal(Object.keys(sources).length, Object.keys(defaults).length);
});

test('a partial override replaces only what it names', async () => {
  const sources = merge(defaults, { allTools: async () => ['from a fixture'] });

  assert.deepEqual(await sources.allTools(), ['from a fixture'], 'the named one is replaced');
  assert.deepEqual(await sources.workspaceTools(), [], 'the others are untouched');
  assert.equal(await sources.jiraQueue().then((q) => q.configured), false);
});

test('a fixture need not stub what it does not use', () => {
  // Which is the point of Partial: a test that stubs all eight stops noticing when a component
  // starts calling a ninth.
  const sources = merge(defaults, { jiraQueue: async () => ({ configured: true }) });

  assert.equal(typeof sources.startTool, 'function');
  assert.equal(typeof sources.removeWorkspace, 'function');
});

test('an override of everything is still the same shape', () => {
  const all = Object.fromEntries(Object.keys(defaults).map((k) => [k, async () => 'stub']));
  const sources = merge(defaults, all);

  assert.deepEqual(Object.keys(sources).sort(), Object.keys(defaults).sort());
});
