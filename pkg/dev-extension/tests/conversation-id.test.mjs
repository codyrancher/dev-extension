// The ids in here are real, or are the ones a real call site would make.
//
// `agent-5`, `p-lte-pr-19630-1` and `p-lte-issue-14904-2` are names that exist on the running
// pod right now, with tmux sessions and transcripts behind them; the long ones are what the
// Discuss button on shell/dialog/AddAuthProviderDialog.vue and the pull request review actually
// build, pasted back here. Half of what this file is for is the old names: they have to go on
// listing, resuming, renaming and ending, and nothing may be migrated or renamed to make that
// true.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LOCATION_MAX, locationSlug, conversationBase, buildConversationId, parseConversationId,
  isConversationId, isProjectConversationId, isDrawerConversationId, conversationProject,
  conversationOrdinal, conversationLocation, conversationLabel,
} from '../conversation-id.mjs';

// ── The old names, which are the ones that must not break ──

test('the ids on the running pod parse as what they have always been', () => {
  assert.deepEqual(parseConversationId('agent-5'), {
    id: 'agent-5', kind: 'drawer', base: 'agent', project: '', location: '', line: 0, ordinal: 5,
  });
  assert.deepEqual(parseConversationId('p-lte-pr-19630-1'), {
    id: 'p-lte-pr-19630-1', kind: 'project', base: 'p-lte-pr-19630', project: 'lte-pr-19630', location: '', line: 0, ordinal: 1,
  });
});

test('a workspace whose name ends in digits keeps the whole name', () => {
  // The ambiguity this format exists to avoid: the last dash is the ordinal's, so everything
  // before it is the workspace, dashes and the PR number included.
  assert.equal(conversationProject('p-lte-issue-14904-2'), 'lte-issue-14904');
  assert.equal(conversationOrdinal('p-lte-issue-14904-2'), 2);
});

test('one workspace does not own another workspace\'s conversations', () => {
  assert.equal(isProjectConversationId('lte', 'p-lte-pr-19630-1'), false);
  assert.equal(isProjectConversationId('lte-pr-19630', 'p-lte-pr-19630-1'), true);
  // A prefix match in the other direction: `p-foo-` is a prefix of `p-foo-bar-2`.
  assert.equal(isProjectConversationId('foo', 'p-foo-bar-2'), false);
  assert.equal(isProjectConversationId('foo-bar', 'p-foo-bar-2'), true);
});

test('the drawer and a project named agent are different things', () => {
  assert.equal(isDrawerConversationId('agent-7'), true);
  assert.equal(isDrawerConversationId('p-agent-7'), false);
  assert.equal(isProjectConversationId('agent', 'p-agent-7'), true);
  assert.equal(isProjectConversationId('agent', 'agent-7'), false);
});

// ── The new names ──

test('a file and a line become something a person recognises', () => {
  assert.equal(
    locationSlug({ path: 'shell/dialog/AddAuthProviderDialog.vue', line: 193 }),
    'shell-dialog-add-auth-provider-dialog-vue-l193',
  );
});

test('the id a Discuss on that line builds, taken apart again', () => {
  const id = buildConversationId('lte-pr-19630', { path: 'shell/dialog/AddAuthProviderDialog.vue', line: 193 }, 2);

  assert.equal(id, 'p-lte-pr-19630_shell-dialog-add-auth-provider-dialog-vue-l193-2');

  const parsed = parseConversationId(id);

  assert.equal(parsed.project, 'lte-pr-19630');
  assert.equal(parsed.location, 'shell-dialog-add-auth-provider-dialog-vue-l193');
  assert.equal(parsed.line, 193);
  assert.equal(parsed.ordinal, 2);
});

test('the ordinal is still the last thing in the id, location or not', () => {
  // Four readers take the ordinal off the end - sessions.sh's `title_of`, the sorts in agent.ts,
  // the title fallback in conversations.ts - and they go on reading it unchanged.
  for (const id of ['agent-7', 'p-lte-pr-19630-1', 'p-lte-pr-19630_review-12', 'agent_focus-3']) {
    assert.equal(String(conversationOrdinal(id)), id.slice(id.lastIndexOf('-') + 1));
  }
});

test('a drawer conversation can carry a location too', () => {
  const id = buildConversationId('', 'PR #19630 review', 4);

  assert.equal(id, 'agent_pr-19630-review-4');
  assert.equal(conversationProject(id), '');
  assert.equal(isDrawerConversationId(id), true);
  assert.equal(conversationLocation(id), 'pr-19630-review');
});

test('no location means the short form, not an invented one', () => {
  assert.equal(buildConversationId('lte-pr-19630', '', 3), 'p-lte-pr-19630-3');
  assert.equal(buildConversationId('', null, 1), 'agent-1');
  assert.equal(locationSlug(''), '');
  assert.equal(locationSlug(undefined), '');
  assert.equal(locationSlug({}), '');
});

test('the base is where the id starts', () => {
  assert.equal(conversationBase(''), 'agent');
  assert.equal(conversationBase('lte-pr-19630'), 'p-lte-pr-19630');
});

// ── Slugging ──

test('camel case is cut into words, and an acronym stays one', () => {
  assert.equal(locationSlug({ path: 'HTTPServerConfig.ts' }), 'http-server-config-ts');
  assert.equal(locationSlug({ path: 'useWorkspaceRail.ts' }), 'use-workspace-rail-ts');
});

test('runs of punctuation collapse and the edges are trimmed', () => {
  assert.equal(locationSlug('  Review  feedback!! '), 'review-feedback');
  // A bare string is a label and not a path, so its slashes are punctuation like any other.
  assert.equal(locationSlug('__weird__/name__'), 'weird-name');
  assert.equal(locationSlug('CI #19630: failures'), 'ci-19630-failures');
});

test('nothing but punctuation is nowhere, not an empty-ish slug', () => {
  assert.equal(locationSlug('///'), '');
  assert.equal(locationSlug({ path: '/' }), '');
});

test('a line with no path is still worth saying', () => {
  assert.equal(locationSlug({ line: 42 }), 'l42');
  // A line that is not a line does not become one.
  assert.equal(locationSlug({ path: 'a.ts', line: 0 }), 'a-ts');
  assert.equal(locationSlug({ path: 'a.ts', line: -3 }), 'a-ts');
});

test('a deep path keeps its end, because the end is which file it is', () => {
  const slug = locationSlug({
    path: '/workspaces/lte-pr-19630/shell/components/nav/WorkspaceRail/sections/ConversationStrip.vue',
    line: 1921,
  });

  assert.ok(slug.length <= LOCATION_MAX, `${ slug.length } is within ${ LOCATION_MAX }`);
  assert.ok(slug.endsWith('conversation-strip-vue-l1921'), slug);
  // And the directories it did keep are the ones nearest the file.
  assert.ok(!slug.includes('workspaces'), slug);
});

test('one impossible segment is cut rather than allowed to grow the id', () => {
  const slug = locationSlug({ path: `${ 'a'.repeat(300) }.ts`, line: 7 });

  assert.equal(slug.length, LOCATION_MAX);
  assert.ok(slug.endsWith('-l7'), slug);
  // Still a legal location: no dash left hanging where the cut fell.
  assert.ok(parseConversationId(buildConversationId('ws', slug, 1)), 'the cut slug still makes an id');
});

test('the longest id a 63-character workspace can have stays well inside a filename', () => {
  const workspace = `lte-${ 'x'.repeat(59) }`;

  assert.equal(workspace.length, 63);
  const id = buildConversationId(workspace, { path: `${ 'deep/'.repeat(20) }SomeVeryLongComponentName.vue`, line: 9999 }, 999);

  // Plus the longest thing anything appends to it, `.events.jsonl`.
  assert.ok(id.length + '.events.jsonl'.length < 255, `${ id.length } + 13`);
  assert.equal(parseConversationId(id).project, workspace);
});

test('slugging a slug gives the slug back, so the browser API may hand over either', () => {
  const once = locationSlug({ path: 'shell/dialog/AddAuthProviderDialog.vue', line: 193 });

  assert.equal(locationSlug(once), once);
  assert.equal(locationSlug(locationSlug(once)), once);
});

// ── What is not an id ──

test('things that are not conversation ids are not treated as any workspace\'s', () => {
  for (const bad of ['', 'agent', 'agent-', '-5', 'p-1', 'p--1', 'agent-x', 'p-Foo-1', 'p-foo_Bad-1', 'p-foo_-1', '_foo-1', 'nonsense']) {
    assert.equal(isConversationId(bad), false, bad);
    assert.equal(conversationProject(bad), '', bad);
  }
});

test('an id nobody understands is left alone rather than guessed at', () => {
  assert.equal(parseConversationId('mc-agent-1'), null);
  assert.equal(conversationLabel('mc-agent-1'), 'mc-agent-1');
});

// ── The tab label ──

test('an unnamed tab says where it came from, or which number it is', () => {
  assert.equal(conversationLabel('agent-7'), '7');
  assert.equal(conversationLabel('p-lte-pr-19630-1'), '1');
  assert.equal(conversationLabel('p-lte-pr-19630_review-12'), 'review');
});
