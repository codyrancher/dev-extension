/**
 * What happened, as events: the two sources the Automations page records, and the diffs that turn
 * a fresh read of each into the changes since the last read.
 *
 * Two sources for now:
 *
 *   - **workspace**: a workspace's stage moved. Read from the `dev-workspace-stages` ConfigMap,
 *     which every dashboard writes the stage into (stages.ts), over a Kubernetes watch, so a
 *     change is an event within a second of being stored.
 *   - **github**: the issues and pull requests the token's owner is assigned to. GitHub has no
 *     push channel for that short of a webhook on every repository, which needs admin on each and
 *     a public address this cluster does not have, so it is a poll: one GraphQL query every three
 *     minutes, compared with what the last one said.
 *
 * A poll can only report differences, so everything is a diff of two snapshots, and the snapshot
 * holds exactly what a diff needs and no more: hashes for bodies, a stamp per comment, the commit
 * ids. Pure, for the tests (tests/automation-events.test.mjs); server.mjs does the reading, the
 * storing and the clock.
 */

/** How often the assigned issues and pull requests are read. */
export const GITHUB_POLL_MS = 3 * 60_000;

/** A closed item is remembered this long, so reopening it is a reopen and not a new assignment. */
export const CLOSED_KEEP_MS = 14 * 24 * 3600_000;

/** One item's events in one poll, at most. A flood is a sign of a bad read, not of a busy item. */
const ITEM_EVENT_CAP = 30;

/** How much of a comment or a body an event carries. The link has the rest. */
const TEXT_MAX = 4000;

/** Every name each source emits, for the editor to offer and the page to filter by. */
export const EVENT_NAMES = {
  github: [
    'issue.assigned', 'issue.unassigned', 'issue.commented', 'issue.comment-edited', 'issue.closed', 'issue.reopened',
    'issue.title-edited', 'issue.body-edited', 'issue.labeled', 'issue.unlabeled',
    'pr.assigned', 'pr.unassigned', 'pr.commented', 'pr.comment-edited', 'pr.reviewed', 'pr.review-commented',
    'pr.pushed', 'pr.checks-passed', 'pr.checks-failed', 'pr.merged', 'pr.closed', 'pr.reopened',
    'pr.ready-for-review', 'pr.converted-to-draft', 'pr.title-edited', 'pr.body-edited', 'pr.labeled', 'pr.unlabeled',
  ],
  workspace: ['stage.changed'],
};

const COMMENT = 'id url body createdAt lastEditedAt author { login }';

const ITEM_COMMON = `
  id number title url state body lastEditedAt updatedAt createdAt
  repository { nameWithOwner }
  author { login }
  labels(first: 30) { nodes { name } }
  assignees(first: 10) { nodes { login } }
  comments(last: 30) { nodes { ${ COMMENT } } }`;

/** One issue or pull request, with everything a diff looks at. */
const ITEM_FIELDS = `
  __typename
  ... on Issue { ${ ITEM_COMMON } stateReason }
  ... on PullRequest {
    ${ ITEM_COMMON }
    isDraft merged mergedAt mergedBy { login } headRefOid headRefName baseRefName
    reviews(last: 20) { nodes { id url state body submittedAt author { login } } }
    reviewThreads(last: 30) { nodes { path comments(last: 10) { nodes { ${ COMMENT } path } } } }
    commits(last: 30) { nodes { commit { oid messageHeadline committedDate author { name user { login } } statusCheckRollup { state } } } }
  }`;

/**
 * The open items the person is assigned, and the closed ones that moved since the last poll - a
 * close is a change to an item that has just left the open list, so it has to be asked for.
 */
export const GITHUB_ITEMS_QUERY = `query($open: String!, $recent: String!) {
  open: search(query: $open, type: ISSUE, first: 50) { issueCount nodes { ${ ITEM_FIELDS } } }
  recent: search(query: $recent, type: ISSUE, first: 30) { nodes { ${ ITEM_FIELDS } } }
}`;

/** Items that dropped out of both lists, read by id: unassigned, transferred, or a lagging search. */
export const GITHUB_NODES_QUERY = `query($ids: [ID!]!) { nodes(ids: $ids) { ${ ITEM_FIELDS } } }`;

/** The two searches, for a login and the time the closed list reaches back to. */
export function assignedQueries(login, since) {
  return {
    open:   `assignee:${ login } is:open archived:false sort:updated-desc`,
    recent: `assignee:${ login } is:closed updated:>=${ String(since).replace(/\.\d+Z$/, 'Z') } sort:updated-desc`,
  };
}

/** FNV-1a, 32 bits, as hex: a body is compared by this rather than kept. */
export function eventHash(text) {
  let h = 0x811c9dc5;
  const s = String(text ?? '');

  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }

  return h.toString(16).padStart(8, '0');
}

/** An id that is the same for the same change, so the event is recorded once whoever sees it. */
function idOf(source, key) {
  return `${ source === 'github' ? 'gh' : source.slice(0, 2) }-${ eventHash(key) }${ eventHash(`${ key }#`).slice(0, 4) }`;
}

/** One event, in the shape every source records. */
export function makeEvent({
  source, name, at, subject, title, url = '', actor = '', workspace = '', payload = {}, key,
}) {
  return {
    id:      idOf(source, key || `${ source }|${ name }|${ subject }|${ at }`),
    source,
    name,
    at,
    subject,
    title,
    url,
    actor,
    workspace,
    payload,
  };
}

const clip = (text) => {
  const s = String(text || '');

  return s.length > TEXT_MAX ? `${ s.slice(0, TEXT_MAX) }…` : s;
};
const loginOf = (who) => String(who?.login || '');
const nodesOf = (conn) => (Array.isArray(conn?.nodes) ? conn.nodes.filter(Boolean) : []);

/** The oldest stamp in a window that is full, or '' when the window holds everything there is. */
function floorOf(stamps, size) {
  return stamps.length >= size ? [...stamps].sort()[0] || '' : '';
}

/** The comments on an item: the conversation's, then the review threads', each with its own window. */
function commentsOf(node) {
  const talk = nodesOf(node.comments);
  const threads = nodesOf(node.reviewThreads).flatMap((t) => nodesOf(t.comments).map((c) => ({ ...c, path: c.path || t.path || '' })));

  return { talk, threads };
}

/**
 * What is kept of one item between polls.
 *
 * `talk`/`threads`/`reviews` map an id to the stamp that moves when it is edited, and each keeps a
 * floor: the oldest stamp in a window that was full. A comment older than that floor that appears
 * is an old one coming back into a window of the last thirty because a newer one was deleted - not
 * something somebody just said.
 */
export function itemSnapshot(node, me, now, before = null) {
  const pr = node.__typename === 'PullRequest';
  const { talk, threads } = commentsOf(node);
  const reviews = nodesOf(node.reviews);
  const commits = nodesOf(node.commits).map((c) => c.commit).filter(Boolean);
  const last = commits[commits.length - 1];
  const assignees = nodesOf(node.assignees).map(loginOf).filter(Boolean).sort();
  const state = pr && node.merged ? 'merged' : String(node.state || '').toLowerCase();

  return {
    id:         node.id,
    kind:       pr ? 'pr' : 'issue',
    repo:       String(node.repository?.nameWithOwner || ''),
    number:     Number(node.number) || 0,
    title:      String(node.title || ''),
    url:        String(node.url || ''),
    state,
    draft:      !!node.isDraft,
    body:       eventHash(node.body || ''),
    labels:     nodesOf(node.labels).map((l) => String(l.name || '')).filter(Boolean).sort(),
    assignees,
    mine:       !!me && assignees.some((a) => a.toLowerCase() === String(me).toLowerCase()),
    talk:       Object.fromEntries(talk.map((c) => [c.id, c.lastEditedAt || c.createdAt || ''])),
    talkFloor:  floorOf(talk.map((c) => c.createdAt || ''), 30),
    threads:    Object.fromEntries(threads.map((c) => [c.id, c.lastEditedAt || c.createdAt || ''])),
    threadFloor: floorOf(threads.map((c) => c.createdAt || ''), 30),
    reviews:    Object.fromEntries(reviews.map((r) => [r.id, r.state || ''])),
    reviewFloor: floorOf(reviews.map((r) => r.submittedAt || ''), 20),
    commits:    commits.map((c) => c.oid),
    head:       String(node.headRefOid || ''),
    checks:     String(last?.statusCheckRollup?.state || ''),
    updatedAt:  String(node.updatedAt || ''),
    closedAt:   state === 'open' ? '' : (before?.closedAt || now),
    seenAt:     now,
  };
}

/** What every event about an item says about it, so a condition can look at it without a lookup. */
function itemFacts(node, s) {
  return {
    kind:      s.kind,
    repo:      s.repo,
    number:    s.number,
    title:     s.title,
    url:       s.url,
    state:     s.state,
    draft:     s.draft,
    author:    loginOf(node.author),
    labels:    s.labels,
    assignees: s.assignees,
    ...(s.kind === 'pr' ? { branch: String(node.headRefName || ''), base: String(node.baseRefName || ''), head: s.head } : {}),
  };
}

const TERMINAL_CHECKS = { SUCCESS: 'checks-passed', FAILURE: 'checks-failed', ERROR: 'checks-failed' };
const REVIEW_SAYS = new Set(['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED']);

/**
 * The events between what was kept of an item and what it is now.
 *
 * `before` null is an item seen for the first time. After the first poll that is an assignment
 * (it was not in the list and now is); on the first poll ever it is not - `quiet` - because the
 * first poll is the baseline, and announcing every open issue as just assigned would start an
 * automation per issue the moment the page was installed.
 */
export function itemEvents(before, node, { me = '', now, quiet = false } = {}) {
  const s = itemSnapshot(node, me, now, before);
  const facts = itemFacts(node, s);
  const subject = `${ s.repo }#${ s.number }`;
  const events = [];
  const add = (what, { actor = '', at = now, payload = {}, key = '', title = '' } = {}) => {
    events.push(makeEvent({
      source:  'github',
      name:    `${ s.kind }.${ what }`,
      at,
      subject,
      title:   title || s.title,
      url:     payload.comment?.url || payload.review?.url || s.url,
      actor,
      payload: { ...facts, ...payload, self: !!actor && !!me && actor.toLowerCase() === me.toLowerCase() },
      key:     `${ subject }|${ s.kind }.${ what }|${ key || at }`,
    }));
  };

  if (!before) {
    if (!quiet && s.mine && s.state === 'open') {
      add('assigned', { key: `assigned|${ s.updatedAt }` });
    }

    return { snapshot: s, events };
  }

  if (before.mine && !s.mine) {
    add('unassigned', { key: `unassigned|${ s.updatedAt }` });
  } else if (!before.mine && s.mine) {
    add('assigned', { key: `assigned|${ s.updatedAt }` });
  }

  if (before.state !== s.state) {
    if (s.state === 'merged') {
      add('merged', { actor: loginOf(node.mergedBy), at: node.mergedAt || now, payload: { from: before.state, to: s.state }, key: 'merged' });
    } else if (s.state === 'closed') {
      add('closed', { payload: { from: before.state, to: s.state, reason: String(node.stateReason || '').toLowerCase() }, key: `closed|${ s.updatedAt }` });
    } else if (s.state === 'open') {
      add('reopened', { payload: { from: before.state, to: s.state }, key: `reopened|${ s.updatedAt }` });
    }
  }

  if (s.kind === 'pr' && before.draft !== s.draft && s.state === 'open') {
    add(s.draft ? 'converted-to-draft' : 'ready-for-review', { key: `draft|${ s.draft }|${ s.updatedAt }` });
  }

  if (before.title !== s.title) {
    add('title-edited', { payload: { from: before.title, to: s.title }, key: `title|${ eventHash(s.title) }` });
  }
  if (before.body !== s.body) {
    add('body-edited', { at: node.lastEditedAt || now, payload: { body: clip(node.body), editedAt: node.lastEditedAt || '' }, key: `body|${ s.body }` });
  }

  for (const label of s.labels.filter((l) => !before.labels.includes(l))) {
    add('labeled', { payload: { label }, key: `labeled|${ label }|${ s.updatedAt }`, title: `${ s.title } +${ label }` });
  }
  for (const label of before.labels.filter((l) => !s.labels.includes(l))) {
    add('unlabeled', { payload: { label }, key: `unlabeled|${ label }|${ s.updatedAt }`, title: `${ s.title } −${ label }` });
  }

  const { talk, threads } = commentsOf(node);
  const said = (list, held, floor, what, editedWhat) => {
    for (const c of list) {
      const stamp = c.lastEditedAt || c.createdAt || '';
      const comment = {
        id: c.id, url: c.url || '', author: loginOf(c.author), body: clip(c.body), createdAt: c.createdAt || '', ...(c.path ? { path: c.path } : {}),
      };

      if (!(c.id in (held || {}))) {
        if (!floor || (c.createdAt || '') >= floor) {
          add(what, { actor: comment.author, at: c.createdAt || now, payload: { comment }, key: `c|${ c.id }` });
        }
      } else if (held[c.id] !== stamp && c.lastEditedAt) {
        add(editedWhat, { actor: comment.author, at: c.lastEditedAt, payload: { comment, editedAt: c.lastEditedAt }, key: `e|${ c.id }|${ stamp }` });
      }
    }
  };

  said(talk, before.talk, before.talkFloor, 'commented', 'comment-edited');
  if (s.kind === 'pr') {
    said(threads, before.threads, before.threadFloor, 'review-commented', 'comment-edited');

    for (const r of nodesOf(node.reviews)) {
      if (r.id in (before.reviews || {}) || r.state === 'PENDING') {
        continue;
      }
      if (before.reviewFloor && (r.submittedAt || '') < before.reviewFloor) {
        continue;
      }
      // A reply in a review thread is a COMMENTED review with no body of its own; the reply is
      // already its review-commented event, and this would be the same thing said twice.
      if (!REVIEW_SAYS.has(r.state) && !String(r.body || '').trim()) {
        continue;
      }
      add('reviewed', {
        actor:   loginOf(r.author),
        at:      r.submittedAt || now,
        payload: {
          review: {
            id: r.id, url: r.url || '', state: String(r.state || '').toLowerCase(), author: loginOf(r.author), body: clip(r.body),
          },
        },
        key: `r|${ r.id }`,
      });
    }

    if (s.head && before.head && s.head !== before.head) {
      const all = nodesOf(node.commits).map((c) => c.commit).filter(Boolean);
      const fresh = all.filter((c) => !before.commits.includes(c.oid));
      const pusher = fresh.length ? String(fresh[fresh.length - 1].author?.user?.login || '') : '';

      add('pushed', {
        actor:   pusher,
        payload: {
          from:    before.head,
          to:      s.head,
          forced:  !s.commits.includes(before.head),
          commits: fresh.slice(-20).map((c) => ({
            oid: c.oid, message: String(c.messageHeadline || ''), author: String(c.author?.user?.login || c.author?.name || ''), at: c.committedDate || '',
          })),
        },
        key:   `push|${ s.head }`,
        title: `${ s.title } (${ fresh.length } commit${ fresh.length === 1 ? '' : 's' })`,
      });
    }

    // Only where it lands: a push turns the checks to pending on every PR, every time, and that
    // is the push's event already. Passing and failing are what anyone waits on.
    if (s.checks !== before.checks && TERMINAL_CHECKS[s.checks]) {
      add(TERMINAL_CHECKS[s.checks], { payload: { from: before.checks.toLowerCase(), to: s.checks.toLowerCase(), head: s.head }, key: `checks|${ s.head }|${ s.checks }` });
    }
  }

  return { snapshot: s, events: events.slice(0, ITEM_EVENT_CAP) };
}

/**
 * One poll, folded into what was kept.
 *
 * `held` is `{ items, baselined }`. `nodes` is everything this poll read: both searches and any
 * item read by id because it dropped out of them. `gone` is the ids of items that read back as
 * nothing at all - deleted, or moved somewhere the token cannot see - which are forgotten quietly.
 *
 * An item that read back no longer assigned is reported and forgotten; a closed one is kept for
 * CLOSED_KEEP_MS so a reopen is a reopen. Everything else is kept as read.
 */
export function githubRound(held, nodes, { me, now, gone = [] }) {
  const items = { ...(held?.items || {}) };
  const quiet = !held?.baselined;
  const events = [];
  const nowMs = Date.parse(now) || Date.now();

  for (const node of nodes) {
    if (!node?.id || !['Issue', 'PullRequest'].includes(node.__typename)) {
      continue;
    }
    const before = items[node.id] || null;
    const { snapshot, events: found } = itemEvents(before, node, { me, now, quiet });

    events.push(...found);
    if (!snapshot.mine) {
      delete items[node.id];
    } else {
      items[node.id] = snapshot;
    }
  }

  for (const id of gone) {
    delete items[id];
  }

  for (const [id, s] of Object.entries(items)) {
    if (s.closedAt && nowMs - (Date.parse(s.closedAt) || nowMs) > CLOSED_KEEP_MS) {
      delete items[id];
    }
  }

  // Oldest first, so the log reads in the order things happened within one poll.
  events.sort((a, b) => String(a.at).localeCompare(String(b.at)));

  return { items, events, baselined: true };
}

/**
 * The open items a poll expected and did not get: assigned and open last time, in neither list
 * this time. Read by id next, rather than taken for unassigned, because a search can lag.
 */
export function missingItems(items, nodes) {
  const seen = new Set(nodes.filter(Boolean).map((n) => n.id));

  return Object.values(items || {}).filter((s) => s.state === 'open' && !seen.has(s.id)).map((s) => s.id).slice(0, 50);
}

/**
 * The workspace an item is the work of, if any: one named for it (`issue-123`, `lte-pr-456`), or
 * for a pull request one whose stored stage is about it - a fix workspace is named for its issue
 * and opens the pull request later.
 */
export function workspaceForItem(kind, repo, number, dirs = [], stages = {}) {
  const n = Number(number);
  const named = new RegExp(`(^|-)${ kind === 'pr' ? 'pr' : 'issue' }-${ n }$`);
  const direct = (dirs || []).find((d) => named.test(d));

  if (direct) {
    return direct;
  }
  if (kind !== 'pr') {
    return '';
  }

  for (const [ws, rec] of Object.entries(stages || {})) {
    if (Number(rec?.pr) === n && (!rec.repo || !repo || rec.repo === repo)) {
      return ws;
    }
  }

  return '';
}

/**
 * The stage events between two reads of the stage store. `before` null is the first read, which
 * is the baseline and says nothing. A workspace with no stage before is one that got its first.
 */
export function stageEvents(before, after, now) {
  if (!before || !after) {
    return [];
  }
  const label = (rec) => String(rec?.stageLabel || rec?.stage || 'none');
  const events = [];

  for (const [ws, rec] of Object.entries(after)) {
    const was = before[ws];

    if (!rec?.stage || was?.stage === rec.stage) {
      continue;
    }
    events.push(makeEvent({
      source:    'workspace',
      name:      'stage.changed',
      at:        rec.at || now,
      subject:   ws,
      title:     `${ label(was) } → ${ label(rec) }`,
      workspace: ws,
      payload:   {
        workspace: ws,
        from:      String(was?.stage || ''),
        fromLabel: was ? label(was) : '',
        to:        rec.stage,
        toLabel:   label(rec),
        manual:    !!rec.manual,
        pr:        Number(rec.pr) || 0,
        repo:      String(rec.repo || ''),
        round:     Number(rec.round) || 0,
      },
      key: `${ ws }|${ was?.stage || '' }|${ rec.stage }|${ rec.at || now }`,
    }));
  }

  return events;
}
