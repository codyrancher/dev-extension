// The events the Automations page records: a GitHub poll and the stage store, diffed.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  itemEvents, githubRound, missingItems, stageEvents, workspaceForItem, assignedQueries, makeEvent,
} from '../dev-api/automation-events.mjs';

const ME = 'cody';
const T0 = '2026-11-09T10:00:00Z';
const T1 = '2026-11-09T10:03:00Z';

function issue(over = {}) {
  return {
    __typename:   'Issue',
    id:           'I_1',
    number:       101,
    title:        'Fix the thing',
    url:          'https://github.com/rancher/dashboard/issues/101',
    state:        'OPEN',
    stateReason:  null,
    body:         'body',
    lastEditedAt: null,
    updatedAt:    T0,
    repository:   { nameWithOwner: 'rancher/dashboard' },
    author:       { login: 'someone' },
    labels:       { nodes: [{ name: 'bug' }] },
    assignees:    { nodes: [{ login: ME }] },
    comments:     { nodes: [] },
    ...over,
  };
}

function pr(over = {}) {
  return {
    ...issue({
      __typename: 'PullRequest', id: 'PR_1', number: 202, url: 'https://github.com/rancher/dashboard/pull/202',
    }),
    isDraft:       false,
    merged:        false,
    headRefOid:    'aaa',
    headRefName:   'fix',
    baseRefName:   'master',
    reviews:       { nodes: [] },
    reviewThreads: { nodes: [] },
    commits:       { nodes: [{ commit: { oid: 'aaa', messageHeadline: 'one', statusCheckRollup: { state: 'PENDING' } } }] },
    ...over,
  };
}

const names = (events) => events.map((e) => e.name);
const base = (node) => itemEvents(null, node, { me: ME, now: T0, quiet: true }).snapshot;

test('the first poll is the baseline and says nothing', () => {
  const round = githubRound({ items: {}, baselined: false }, [issue(), pr()], { me: ME, now: T0 });

  assert.equal(round.events.length, 0);
  assert.equal(Object.keys(round.items).length, 2);
  assert.equal(round.baselined, true);
});

test('an item that appears after the baseline is an assignment', () => {
  const round = githubRound({ items: {}, baselined: true }, [issue()], { me: ME, now: T1 });

  assert.deepEqual(names(round.events), ['issue.assigned']);
  assert.equal(round.events[0].source, 'github');
  assert.equal(round.events[0].subject, 'rancher/dashboard#101');
});

test('a new comment, an edit to one, and an old one coming back into the window', () => {
  const window = Array.from({ length: 30 }, (_, i) => ({
    id: `c${ i }`, createdAt: `2026-11-0${ 1 + (i % 8) }T00:00:${ String(i).padStart(2, '0') }Z`, body: `c${ i }`, author: { login: 'x' },
  }));
  const before = base(issue({ comments: { nodes: window } }));
  const fresh = { id: 'c99', createdAt: T1, body: 'hello', author: { login: 'reviewer' }, url: 'u' };
  const edited = { ...window[5], lastEditedAt: T1 };
  // c-old is older than every comment in the full window: a deletion let it back in.
  const old = { id: 'c-old', createdAt: '2026-10-01T00:00:00Z', body: 'old', author: { login: 'x' } };
  const now = issue({ comments: { nodes: [old, ...window.slice(0, 5), edited, ...window.slice(6), fresh] } });
  const { events } = itemEvents(before, now, { me: ME, now: T1 });

  assert.deepEqual(names(events).sort(), ['issue.comment-edited', 'issue.commented']);
  const said = events.find((e) => e.name === 'issue.commented');

  assert.equal(said.actor, 'reviewer');
  assert.equal(said.payload.comment.body, 'hello');
  assert.equal(said.payload.self, false);
});

test('my own comment is marked as mine', () => {
  const before = base(issue());
  const { events } = itemEvents(before, issue({ comments: { nodes: [{ id: 'c1', createdAt: T1, body: 'me', author: { login: 'Cody' } }] } }), { me: ME, now: T1 });

  assert.equal(events[0].payload.self, true);
});

test('state, title, body and labels', () => {
  const before = base(issue());
  const now = issue({
    state: 'CLOSED', stateReason: 'COMPLETED', title: 'Fixed the thing', body: 'new body', lastEditedAt: T1, labels: { nodes: [{ name: 'ready' }] }, updatedAt: T1,
  });
  const got = names(itemEvents(before, now, { me: ME, now: T1 }).events).sort();

  assert.deepEqual(got, ['issue.body-edited', 'issue.closed', 'issue.labeled', 'issue.title-edited', 'issue.unlabeled']);
});

test('a pull request: push, checks, review, review comment, draft, merge', () => {
  const before = base(pr({ isDraft: true }));
  const now = pr({
    isDraft:    false,
    headRefOid: 'bbb',
    commits:    { nodes: [
      { commit: { oid: 'aaa', messageHeadline: 'one' } },
      { commit: { oid: 'bbb', messageHeadline: 'two', author: { user: { login: ME } }, statusCheckRollup: { state: 'FAILURE' } } },
    ] },
    reviews: { nodes: [
      {
        id: 'R1', state: 'CHANGES_REQUESTED', body: 'no', submittedAt: T1, author: { login: 'rev' }
      },
      // A thread reply: a COMMENTED review with no body. Its comment is the event, not this.
      {
        id: 'R2', state: 'COMMENTED', body: '', submittedAt: T1, author: { login: 'rev' }
      },
    ] },
    reviewThreads: { nodes: [{ path: 'a.vue', comments: { nodes: [{ id: 'T1', createdAt: T1, body: 'here', author: { login: 'rev' } }] } }] },
  });
  const events = itemEvents(before, now, { me: ME, now: T1 }).events;

  assert.deepEqual(names(events).sort(), ['pr.checks-failed', 'pr.pushed', 'pr.ready-for-review', 'pr.review-commented', 'pr.reviewed']);
  const push = events.find((e) => e.name === 'pr.pushed');

  assert.equal(push.payload.forced, false);
  assert.deepEqual(push.payload.commits.map((c) => c.oid), ['bbb']);
  assert.equal(events.find((e) => e.name === 'pr.review-commented').payload.comment.path, 'a.vue');

  const merged = itemEvents(itemEvents(before, now, { me: ME, now: T1 }).snapshot, { ...now, state: 'MERGED', merged: true, mergedBy: { login: 'rev' } }, { me: ME, now: T1 }).events;

  assert.deepEqual(names(merged), ['pr.merged']);
  assert.equal(merged[0].actor, 'rev');
});

test('checks going to pending say nothing; a force-push says so', () => {
  const before = base(pr({ commits: { nodes: [{ commit: { oid: 'aaa', statusCheckRollup: { state: 'SUCCESS' } } }] } }));
  const now = pr({ headRefOid: 'ccc', commits: { nodes: [{ commit: { oid: 'ccc', statusCheckRollup: { state: 'PENDING' } } }] } });
  const events = itemEvents(before, now, { me: ME, now: T1 }).events;

  assert.deepEqual(names(events), ['pr.pushed']);
  assert.equal(events[0].payload.forced, true);
});

test('the same change has the same id, so two readers record it once', () => {
  const before = base(issue());
  const now = issue({ comments: { nodes: [{ id: 'c1', createdAt: T1, body: 'x', author: { login: 'a' } }] } });

  assert.equal(itemEvents(before, now, { me: ME, now: T1 }).events[0].id, itemEvents(before, now, { me: ME, now: '2026-11-09T10:06:00Z' }).events[0].id);
});

test('unassigned is reported and forgotten; closed is kept; a dropped item is read by id', () => {
  const held = { items: { I_1: base(issue()), PR_1: base(pr()) }, baselined: true };

  assert.deepEqual(missingItems(held.items, [pr()]), ['I_1']);

  const round = githubRound(held, [issue({ assignees: { nodes: [] } }), pr({ state: 'CLOSED' })], { me: ME, now: T1 });

  assert.deepEqual(names(round.events).sort(), ['issue.unassigned', 'pr.closed']);
  assert.deepEqual(Object.keys(round.items), ['PR_1']);
  assert.equal(round.items.PR_1.closedAt, T1);

  const later = githubRound(round, [], { me: ME, now: '2026-12-01T00:00:00Z' });

  assert.deepEqual(Object.keys(later.items), []);
});

test('stage changes: the first read is the baseline; a move and a first stage are events', () => {
  assert.deepEqual(stageEvents(null, { a: { stage: 'code' } }, T0), []);

  const events = stageEvents(
    { a: { stage: 'code', stageLabel: 'Code' }, b: { stage: 'review' } },
    {
      a: {
        stage: 'draft', stageLabel: 'Draft PR', manual: true, pr: 9, at: T1
      },
      b: { stage: 'review' },
      c: { stage: 'assess', stageLabel: 'Assess' }
    },
    T1,
  );

  assert.deepEqual(events.map((e) => [e.subject, e.payload.from, e.payload.to]), [['a', 'code', 'draft'], ['c', '', 'assess']]);
  assert.equal(events[0].workspace, 'a');
  assert.equal(events[0].title, 'Code → Draft PR');
  assert.equal(events[0].payload.manual, true);
});

test('the workspace an item belongs to', () => {
  const dirs = ['issue-101', 'lte-pr-303', 'other'];

  assert.equal(workspaceForItem('issue', 'rancher/dashboard', 101, dirs), 'issue-101');
  assert.equal(workspaceForItem('pr', 'rancher/dashboard', 303, dirs), 'lte-pr-303');
  assert.equal(workspaceForItem('pr', 'rancher/dashboard', 202, dirs, { 'issue-101': { pr: 202, repo: 'rancher/dashboard' } }), 'issue-101');
  assert.equal(workspaceForItem('pr', 'rancher/dashboard', 202, dirs, { 'issue-101': { pr: 202, repo: 'rancher/other' } }), '');
  assert.equal(workspaceForItem('issue', 'rancher/dashboard', 999, dirs), '');
});

test('the searches', () => {
  const q = assignedQueries('cody', '2026-11-09T10:00:00.123Z');

  assert.equal(q.open, 'assignee:cody is:open archived:false sort:updated-desc');
  assert.equal(q.recent, 'assignee:cody is:closed updated:>=2026-11-09T10:00:00Z sort:updated-desc');
});

test('an event without a key still gets a stable id', () => {
  const a = makeEvent({
    source: 'workspace', name: 'x', at: T0, subject: 's', title: 't'
  });

  assert.match(a.id, /^wo-[0-9a-f]{12}$/);
});
