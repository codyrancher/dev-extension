// The stage rail: the stages a workspace's work moves through, what there is to look at in
// each of them, and what pressing the one button does. The page (WorkspaceRail.vue) draws it;
// this decides it.
//
// The first column is the point of the rail: at every stage it holds what is needed to judge
// the work, drawn from where the work actually is - the agent's last report out of its
// transcript, the branch's commits and diff out of the checkout, the recordings out of the
// workspace's artifacts, the PR with its body, checklist, CI and comments out of GitHub. Every
// stage can be looked at again after it has passed: the evidence is composed per stage, from
// what that stage left behind, so a past step on the rail is a way back to its artifacts.
import {
  prDetail, commitsDiff, ciFailures, ghAssetUrl, ghAssetKind, DEFAULT_REPO
} from './reviews';
import { issueBody } from './github';
import { readInWorkspace } from './workspace-tools';
import {
  parseHunks, highlightRows, highlightLines, hl, renderMd, escapeHtml
} from './components/pr/diff';
import type { DiffRow } from './components/pr/diff';
import { latestAgentReport } from './conversations';
import { devFetch, workspaceMediaListUrl, workspaceMediaFileUrl } from './api';
import { noteCoded, isBot, STAGE_LABELS } from './workspace-status';
import type { WorkspaceStatus, Stage } from './workspace-status';

type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any

export interface RailStep {
  key: Stage;
  label: string;
}

// The stages themselves are named in workspace-status, which is also where the sidebar reads
// them from: a workspace that reads "In review" here reads "In review" in the list.
const step = (key: Stage): RailStep => ({ key, label: STAGE_LABELS[key] });

export const FIX_STEPS: RailStep[] = ['assess', 'code', 'draft', 'review', 'feedback', 'merged'].map((k) => step(k as Stage));

export const REVIEW_STEPS: RailStep[] = ['agent', 'findings', 'submitted', 'response', 'approved'].map((k) => step(k as Stage));

export function stepsFor(kind: WorkspaceStatus['kind']): RailStep[] {
  return kind === 'review' ? REVIEW_STEPS : kind === 'fix' ? FIX_STEPS : [];
}

// ── Evidence ────────────────────────────────────────────────────────────────────────────────

export type EvidenceItem =
  | { kind: 'text'; text: string; html?: string; at?: string; who?: string }
  | { kind: 'kv'; rows: { k: string; v: string; tone?: string }[] }
  | { kind: 'media'; items: { label: string; url: string; video: boolean; at: string }[] }
  | { kind: 'comments'; items: Comment[]; paged?: boolean }
  | { kind: 'commits'; pr: number; items: { sha: string; message: string; who: string; at: string }[]; since?: string }
  | { kind: 'files'; items: { path: string; note: string }[] }
  | { kind: 'links'; items: { label: string; url: string }[] }
  | { kind: 'empty'; text: string };

export interface EvidenceSection {
  title: string;
  items: EvidenceItem[];
}

/** One row of a diff as the page draws it: highlighted code, and whether it is the commented line. */
export interface CodeRow {
  type: DiffRow['type'];
  oldN: number | null;
  newN: number | null;
  html: string;
  marked: boolean;
}

/**
 * A review thread, as a card: where it is, the code it is on (the whole hunk of the PR's diff
 * around the line, not one line), and every message in it, oldest first, rendered.
 */
export interface Comment {
  id: number | string;
  who: string;
  where: string;
  path: string;
  line: number;
  body: string;
  at: string;
  /** Whether the last word is the viewer's side's - nothing waits on them here. */
  answered: boolean;
  /** Who spoke last, and whether that was the PR's author. */
  lastBy: string;
  lastByAuthor: boolean;
  thread: { who: string; author: boolean; body: string; html: string; at: string; isNew: boolean }[];
  /**
   * Whether the PR's author has spoken in this thread at all. Not the same as answered: a
   * thread where they replied twice and the reviewer then raised something new is still
   * waiting on them, which is what `lastByAuthor` says.
   */
  replied: boolean;
  /** Whether the person reading this page has a message in the thread. */
  mine: boolean;
  /** The PR's head, for reading more of the file around the hunk. */
  headSha: string;
  /** GitHub's position in the diff, for its order. */
  position: number;
  /** @deprecated the old one-line context; `rows` is the hunk. */
  context: string;
  rows: CodeRow[];
  /** The file's patch was not in the PR's data (too large, or binary): the code cannot be shown. */
  noPatch: boolean;
  /**
   * A finding of yours that has not been submitted: it can still be marked good, edited,
   * discussed with the agent or dropped, the way the PR panel's cards can.
   */
  local?: boolean;
  status?: string;
  /** What the agent attached to it: the evidence, shown the way the PR panel shows it. */
  attachments?: Json[];
  url: string;
  /** Where the file sits in the PR's file list, for GitHub's order. */
  order: number;
}

/**
 * The hunk of a file's patch that holds one line - the code a review comment is about, with
 * the lines around it, numbered on both sides and highlighted in the file's language, the
 * commented line marked. New-side numbers for a comment on the right, old-side on the left.
 * Empty when the line is not in the patch any more (the file changed since).
 */
export function hunkRows(path: string, patch: string, line: number, side = 'RIGHT'): CodeRow[] {
  if (!patch || !line) {
    return [];
  }
  const hunks = parseHunks(patch);
  const hit = hunks.find((h) => h.rows.some((r) => (side === 'LEFT' ? r.oldN : r.newN) === line));

  if (!hit) {
    return [];
  }
  highlightRows(path, hit.rows);
  const at = hit.rows.findIndex((r) => (side === 'LEFT' ? r.oldN : r.newN) === line);
  // The whole hunk when it is short; otherwise a generous window around the line.
  const rows = hit.rows.length <= 40 ? hit.rows : hit.rows.slice(Math.max(0, at - 18), at + 12);

  return rows.map((r) => ({
    type: r.type, oldN: r.oldN, newN: r.newN, html: r.type === 'hunk' ? escapeHtml(r.text) : hl(r), marked: (side === 'LEFT' ? r.oldN : r.newN) === line && r.type !== 'hunk',
  }));
}

/** GitHub's own hunk for a comment (`diff_hunk`), highlighted, its last line - the commented one - marked. */
export function ownHunkRows(path: string, diffHunk: string): CodeRow[] {
  const hunks = parseHunks(diffHunk);
  const rows = hunks.flatMap((h) => {
    highlightRows(path, h.rows);

    return h.rows;
  });
  const last = [...rows].reverse().find((r) => r.type !== 'hunk');

  return rows.slice(-40).map((r) => ({
    type: r.type, oldN: r.oldN, newN: r.newN, html: r.type === 'hunk' ? escapeHtml(r.text) : hl(r), marked: r === last,
  }));
}

/** A whole file's patch as rows, highlighted: what a commit opens to. */
export function fileRows(path: string, patch: string, limit = 400): CodeRow[] {
  const rows: CodeRow[] = [];
  const hunks = parseHunks(patch);
  const total = hunks.reduce((n, h) => n + h.rows.length, 0);

  for (const h of hunks) {
    highlightRows(path, h.rows);
    for (const r of h.rows) {
      rows.push({
        type: r.type, oldN: r.oldN, newN: r.newN, html: r.type === 'hunk' ? escapeHtml(r.text) : hl(r), marked: false,
      });
      if (rows.length >= limit) {
        // Cut, and said so: a long file must not read as complete.
        rows.push({
          type: 'hunk', oldN: null, newN: null, html: escapeHtml(`… ${ total - rows.length } more lines - open the file on GitHub`), marked: false,
        });

        return rows;
      }
    }
  }

  return rows;
}

export function hunkAround(patch: string, line: number, side = 'RIGHT'): string {
  if (!patch || !line) {
    return '';
  }
  const rows: { no: number; text: string }[] = [];
  let oldNo = 0;
  let newNo = 0;

  for (const l of patch.split('\n')) {
    const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l);

    if (h) {
      oldNo = Number(h[1]);
      newNo = Number(h[2]);
      rows.push({ no: -1, text: l });
      continue;
    }
    if (l.startsWith('+')) {
      rows.push({ no: side === 'LEFT' ? -1 : newNo, text: l });
      newNo++;
    } else if (l.startsWith('-')) {
      rows.push({ no: side === 'LEFT' ? oldNo : -1, text: l });
      oldNo++;
    } else {
      rows.push({ no: side === 'LEFT' ? oldNo : newNo, text: l });
      oldNo++;
      newNo++;
    }
  }
  const at = rows.findIndex((r) => r.no === line);

  return at < 0 ? '' : rows.slice(Math.max(0, at - 8), at + 6).map((r) => r.text).join('\n');
}

interface Branch {
  branch: string;
  commits: { sha: string; message: string; who: string; at: string }[];
  stat: string;
  files: string[];
}

export const ago = (iso: string): string => {
  const ms = Date.now() - (Date.parse(iso || '') || Date.now());
  const m = Math.round(ms / 60_000);

  if (m < 2) {
    return 'just now';
  }
  if (m < 60) {
    return `${ m } min ago`;
  }
  const h = Math.round(m / 60);

  if (h < 36) {
    return `${ h } h ago`;
  }

  return `${ Math.round(h / 24) } days ago`;
};

/** The branch as the checkout has it: its commits over upstream, the diff's size, the files. */
async function readBranch(workspace: string): Promise<Branch | null> {
  const script = [
    'cd $WS/dashboard 2>/dev/null || { echo "@@NOREPO"; exit 0; }',
    'base=$(git merge-base upstream/master HEAD 2>/dev/null || git merge-base origin/master HEAD 2>/dev/null || git rev-parse HEAD)',
    'echo "@@BRANCH $(git rev-parse --abbrev-ref HEAD 2>/dev/null)"',
    'echo "@@COMMITS"',
    'git log --format="%H%x09%s%x09%an%x09%aI" "$base"..HEAD 2>/dev/null | head -30',
    'echo "@@STAT"',
    'git diff --shortstat "$base" 2>/dev/null',
    'echo "@@FILES"',
    'git diff --name-only "$base" 2>/dev/null | head -80',
    'echo "@@END"',
  ].join('\n');
  const out = await readInWorkspace(workspace, script).catch(() => '');

  if (!out || out.includes('@@NOREPO')) {
    return null;
  }
  const section = (name: string, next: string) => out.slice(out.indexOf(`@@${ name }`) + name.length + 3, out.indexOf(`@@${ next }`)).trim();

  return {
    branch:  /@@BRANCH (\S*)/.exec(out)?.[1] || '',
    commits: section('COMMITS', 'STAT').split('\n').filter(Boolean).map((line) => {
      const [sha, message, who, at] = line.split('\t');

      return {
        sha, message: message || '', who: who || '', at: at || '',
      };
    }),
    stat:  section('STAT', 'FILES'),
    files: section('FILES', 'END').split('\n').filter(Boolean),
  };
}

async function readMedia(workspace: string): Promise<{ label: string; url: string; video: boolean; at: string; path: string }[]> {
  const data = await devFetch(workspaceMediaListUrl(workspace)).catch(() => null);
  const files: Json[] = data?.files || [];

  return files
    .filter((f) => !/^a11y\//.test(f.path))
    .sort((a, b) => (b.mtimeMs || 0) - (a.mtimeMs || 0))
    .slice(0, 80)
    .map((f) => ({
      label: f.path, url: workspaceMediaFileUrl(workspace, f.path), video: /video/.test(f.type || ''), at: new Date(f.mtimeMs || 0).toISOString(), path: f.path,
    }));
}

const mediaUnder = (media: Awaited<ReturnType<typeof readMedia>>, ...dirs: string[]) => media.filter((m) => dirs.some((d) => m.path.startsWith(`${ d }/`))).slice(0, 8);

function checklist(body: string): { ticked: number; total: number } {
  const ticked = (body.match(/- \[x\]/gi) || []).length;
  const open = (body.match(/- \[ \]/g) || []).length;

  return { ticked, total: ticked + open };
}

function prRows(d: Json): { k: string; v: string; tone?: string }[] {
  const m = d.meta || {};
  const ci = m.ci || {};
  const state = m.merged ? 'merged' : m.draft ? 'draft' : String(m.state || '').toLowerCase();
  const rows: { k: string; v: string; tone?: string }[] = [
    { k: 'PR', v: `#${ m.number } · ${ state }${ m.approved ? ` · approved by ${ (m.approvedBy || []).join(', ') }` : '' }` },
    { k: 'Size', v: `${ m.changedFiles ?? d.files?.length ?? 0 } files · +${ m.additions ?? 0 } −${ m.deletions ?? 0 }` },
  ];

  if (ci.total) {
    const state = ci.failing ? `${ ci.failing } failing` : ci.pending ? `${ ci.pending } running` : 'green';

    rows.push({ k: 'CI', v: `${ state } · ${ ci.total } jobs`, tone: ci.failing ? 'bad' : ci.pending ? '' : 'ok' });
  }
  const list = checklist(m.body || '');

  if (list.total) {
    rows.push({ k: 'Checklist', v: `${ list.ticked } of ${ list.total } boxes ticked` });
  }

  return rows;
}

/**
 * Every thread on a PR, one card each, in GitHub's "Files changed" order: by the file's place
 * in the PR, then the line; the discussion under the PR after them, oldest first. Each with
 * the whole hunk it is on and every message rendered.
 */
function threads(d: Json, since = 0, kinds: Record<string, string> = {}): Comment[] {
  const m = { ...(d.meta || {}), viewer: d.viewer || '' };
  const author = m.author || '';
  const files: Json[] = d.files || [];
  const review: Json[] = (d.reviewComments || []).filter((c: Json) => !c.pending && !isBot(c.author));
  const byId = new Map(review.map((c) => [c.id, c]));
  const rootOf = (c: Json): Json => {
    let cur = c;

    for (let i = 0; i < 50 && cur.inReplyTo && byId.has(cur.inReplyTo); i++) {
      cur = byId.get(cur.inReplyTo);
    }

    return cur;
  };
  const roots = review.filter((c) => rootOf(c).id === c.id);
  const msg = (c: Json) => ({
    who: c.author || '?', author: c.author === author, body: String(c.body || ''), html: renderBody(String(c.body || ''), kinds), at: c.createdAt || '', isNew: since > 0 && (Date.parse(c.createdAt) || 0) > since,
  });
  const card = (root: Json, members: Json[], where: string, path: string, line: number, rows: CodeRow[], order: number, url: string): Comment => {
    const thread = members.sort((a, b) => (Date.parse(a.createdAt) || 0) - (Date.parse(b.createdAt) || 0)).map(msg);
    const last = thread[thread.length - 1];
    const viewer = m.viewer || '';

    return {
      id: root.id, who: root.author || '?', where, path, line, body: String(root.body || '').slice(0, 400), at: last?.at || root.createdAt || '', answered: false, lastBy: last?.who || '', lastByAuthor: !!last?.author, thread, replied: thread.some((t) => t.author), mine: !!viewer && thread.some((t) => t.who === viewer), headSha: m.headSha || '', position: Number(root.position) || 0, context: '', rows, noPatch: false, url, order,
    };
  };
  const out = roots.map((root) => {
    const members = review.filter((c) => rootOf(c).id === root.id);
    const file = files.findIndex((f) => f.path === root.path);
    const line = Number(root.line) || Number(root.originalLine) || 0;
    const patch = files[file]?.patch || '';
    // The current diff when the line is still in it; else GitHub's own hunk for the comment,
    // whose last line is the commented one.
    let rows = root.outdated ? [] : hunkRows(root.path || '', patch, line, root.side);

    if (!rows.length && root.diffHunk) {
      rows = ownHunkRows(root.path || '', root.diffHunk);
    }
    const c = card(root, members, root.path ? `${ root.path }${ line ? `:${ line }` : '' }` : 'review', root.path || '', line, rows, file < 0 ? 9999 : file, m.url ? `${ m.url }#discussion_r${ root.id }` : '');

    c.noPatch = !!root.path && !rows.length && !patch && !root.diffHunk;

    return c;
  }).sort((a, b) => a.order - b.order || (a.position && b.position ? a.position - b.position : a.line - b.line) || (Date.parse(a.at) || 0) - (Date.parse(b.at) || 0));

  for (const c of ((d.discussion || []) as Json[]).filter((c) => !isBot(c.author))) {
    out.push(card(c, [c], 'discussion', '', 0, [], 10000, m.url ? `${ m.url }#issuecomment-${ c.id }` : ''));
  }

  return out;
}

/**
 * The threads that wait on the viewer, after a moment: on a fix, someone other than the author
 * spoke last (the author is the viewer); on a review, the author spoke last (the viewer is the
 * reviewer). `since` keeps only threads with a word after it.
 */
function feedback(d: Json, since: number, viewerIsAuthor = true, kinds: Record<string, string> = {}): Comment[] {
  return threads(d, since, kinds)
    .filter((c) => (Date.parse(c.at) || 0) > since)
    .map((c) => ({ ...c, answered: viewerIsAuthor ? c.lastByAuthor : !c.lastByAuthor }));
}

const pushedAt = (d: Json) => Math.max(0, ...(d.commits || []).map((c: Json) => Date.parse(c.date || '') || 0));

/**
 * What there is to look at for one stage of a workspace's work - the current one, or one that
 * has passed. Everything is read fresh: the branch, the recordings, the PR, the agent's report.
 */
export async function gatherEvidence(workspace: string, status: WorkspaceStatus, stage: Stage, onUpdate?: (sections: EvidenceSection[], done: boolean) => void): Promise<EvidenceSection[]> {
  // Each source arrives when it does - the checkout in a second, GitHub in a few - and the
  // column is redrawn from whatever has arrived so far rather than waiting for the slowest.
  const issue = Number(/(?:^|-)issue-(\d+)(?:-|$)/.exec(workspace)?.[1]) || 0;
  const have: Sources = {};
  const t0 = Date.now();
  const timed = <T>(name: string, p: Promise<T>) => p.then((v) => {
    console.debug(`[rail] ${ workspace } ${ stage }: ${ name } in ${ Date.now() - t0 } ms`); // eslint-disable-line no-console

    return v;
  });
  have.failed = {};
  const reads: Promise<void>[] = [
    timed('report', latestAgentReport(workspace).catch(() => null)).then((v) => { have.report = v; }),
    timed('branch', readBranch(workspace).catch(() => null)).then((v) => {
      have.branch = v;
      // The status module learns from here whether the branch has commits (assess vs code),
      // whatever stage's column is being composed.
      if (v) {
        noteCoded(workspace, !!v.commits.length);
      }
    }),
    timed('media', readMedia(workspace).catch(() => [])).then((v) => { have.media = v; }),
    timed('pr', status.pr ? prDetail(status.pr).catch(() => null) : Promise.resolve(null)).then((v) => {
      have.d = v;
      have.failed = { ...have.failed, pr: !!status.pr && !v };
    }),
    timed('issue', issue && status.kind === 'fix' ? issueBody(DEFAULT_REPO, issue).catch(() => null) : Promise.resolve(null)).then((v) => { have.issue = v; }),
  ];
  let pending = reads.length;
  const emit = (done: boolean) => onUpdate?.(compose(status, stage, have), done);

  // What the comments' attachments are, once the PR is here: asked in parallel, kept, and
  // drawn as images or players when the column is composed again.
  // What the comments' attachments are, once the PR is here. Awaited with the rest: the
  // bodies are composed with these, and a compose without them turns a recording back into a
  // link - which is what happened when this chain was left to land on its own.
  const kindsRead = reads[3].then(async() => {
    const d = have.d;

    if (!d) {
      return;
    }
    const urls = [...new Set([...(d.reviewComments || []), ...(d.discussion || [])].flatMap((c: Json) => assetUrls(String(c.body || ''))))].slice(0, 40);

    if (!urls.length) {
      return;
    }
    const kinds = await Promise.all(urls.map((u) => ghAssetKind(u)));

    have.kinds = Object.fromEntries(urls.map((u, i) => [u, kinds[i]]));
    emit(pending === 0);
  }).catch(() => { /* an attachment whose type is unknown stays a link */ });

  for (const read of reads) {
    read.then(() => {
      pending--;
      emit(pending === 0);
    });
  }
  await Promise.all([...reads, kindsRead]);
  // Which CI jobs fail, once the PR says some do: one more read, worth it only then.
  if (have.d?.meta?.ci?.failing && status.pr) {
    have.ci = await ciFailures(status.pr).catch(() => null);
  }

  return compose(status, stage, have);
}

interface Sources {
  report?: Awaited<ReturnType<typeof latestAgentReport>>;
  branch?: Branch | null;
  media?: Awaited<ReturnType<typeof readMedia>>;
  d?: Json;
  issue?: { title: string; body: string; url: string } | null;
  ci?: Json;
  /** Which reads failed, so the column says so rather than quietly leaving a section out. */
  failed?: { pr?: boolean };
  /** Attachment URL -> content type, for the bodies. */
  kinds?: Record<string, string>;
}

function compose(status: WorkspaceStatus, stage: Stage, have: Sources): EvidenceSection[] {
  const report = have.report || null;
  const branch = have.branch || null;
  const media = have.media || [];
  const d = have.d || null;
  const kinds = have.kinds || {};
  const sections: EvidenceSection[] = [];

  // A read that failed - the in-cluster API restarting, GitHub rate-limiting - is said here.
  // Leaving the PR's sections out silently read as "there is nothing", which is a lie about
  // fifteen comment threads.
  if (have.failed?.pr) {
    sections.push({ title: 'The pull request could not be read', items: [{ kind: 'empty', text: 'GitHub or the in-cluster API did not answer. Trying again in a moment.' }] });
  }
  const reportSection = (title = 'Agent\'s report') => report && sections.push({ title, items: [{ kind: 'text', text: report.text, html: renderMd(report.text), at: report.at }] });
  const mediaSection = (title: string, items: ReturnType<typeof mediaUnder>) => items.length && sections.push({ title, items: [{ kind: 'media', items }] });
  const branchSection = () => {
    if (!branch) {
      return;
    }
    const tests = branch.files.filter((f) => /\.(test|spec)\.[jt]sx?$|__tests__\//.test(f));
    const items: EvidenceItem[] = [];

    if (branch.commits.length) {
      items.push({ kind: 'commits', pr: status.pr, items: branch.commits });
    }
    items.push({ kind: 'kv', rows: [{ k: 'Branch', v: branch.branch }, { k: 'Diff', v: branch.stat || 'no changes over upstream' }, { k: 'Tests', v: tests.length ? tests.join(', ') : 'none added', tone: tests.length ? 'ok' : 'warn' }] });
    if (branch.files.length) {
      items.push({ kind: 'files', items: branch.files.map((path) => ({ path, note: tests.includes(path) ? 'test' : '' })) });
    }
    sections.push({ title: 'The change', items });
  };
  const prSection = () => {
    if (!d) {
      return;
    }
    const items: EvidenceItem[] = [{ kind: 'kv', rows: prRows(d) }];
    const failing: Json[] = (have.ci?.checks || []).filter((c: Json) => c.url);

    if (failing.length) {
      items.push({ kind: 'links', items: failing.slice(0, 8).map((c: Json) => ({ label: `${ c.name || 'check' }: ${ c.conclusion || 'failing' }`, url: c.url })) });
    }
    items.push({ kind: 'text', text: String(d.meta?.body || ''), html: renderBody(String(d.meta?.body || '') || '_(no description)_', kinds) });
    sections.push({ title: 'Pull request', items });
  };
  const issueSection = () => have.issue && sections.push({ title: `The issue: ${ have.issue.title }`, items: [{ kind: 'text', text: have.issue.body, html: renderMd(have.issue.body || '_(no description)_') }, { kind: 'links', items: [{ label: 'On GitHub', url: have.issue.url }] }] });

  if (status.kind === 'fix') {
    switch (stage) {
    case 'assess':
      reportSection(report && branch?.commits.length ? 'Agent\'s latest report' : 'Agent\'s assessment');
      mediaSection('Reproduced', mediaUnder(media, 'reproduce'));
      if (have.issue) {
        issueSection();
      } else {
        sections.push({ title: 'The issue', items: [{ kind: 'links', items: status.links.filter((l) => l.label.startsWith('Issue')) }] });
      }
      break;
    case 'code':
      branchSection();
      mediaSection('Before and after', [...mediaUnder(media, 'verify'), ...mediaUnder(media, 'reproduce')]);
      reportSection();
      break;
    case 'draft':
      prSection();
      branchSection();
      mediaSection('Recorded', [...mediaUnder(media, 'verify'), ...mediaUnder(media, 'reproduce')]);
      reportSection();
      break;
    case 'review':
      // The agent's report and the change come first: after feedback, this is what it pushed.
      reportSection();
      if (d) {
        const fb = feedback(d, 0, true, kinds);

        sections.push({ title: 'Reviewers', items: fb.length ? [{ kind: 'comments', items: fb }] : [{ kind: 'empty', text: 'Nobody has commented yet.' }] });
      }
      prSection();
      branchSection();
      break;
    case 'feedback':
      if (d) {
        // New since the last push: the messages after it are marked as such.
        const all = feedback(d, 0, true, kinds).map((c) => ({ ...c, thread: c.thread.map((t) => ({ ...t, isNew: (Date.parse(t.at) || 0) > pushedAt(d) })) }));
        const fresh = all.filter((c) => (Date.parse(c.at) || 0) > pushedAt(d));
        const older = all.filter((c) => !fresh.includes(c));

        sections.push({ title: 'Since your last push', items: fresh.length ? [{ kind: 'comments', items: fresh, paged: true }] : [{ kind: 'empty', text: 'Nothing new since the last push.' }] });
        // And the commits of this round, so the change the feedback is about can be read as one.
        const roundCommits = (d.commits || []).filter((c: Json) => (Date.parse(c.date || '') || 0) > Math.min(...all.map((x) => Date.parse(x.thread[0]?.at || '') || Date.now()))).map((c: Json) => ({
          sha: String(c.sha || ''), message: c.message, who: c.author, at: c.date,
        }));

        if (roundCommits.length) {
          sections.push({ title: 'Your commits this round', items: [{ kind: 'commits', pr: status.pr, items: roundCommits, since: 'the first comment of this round' }] });
        }
        if (older.length) {
          sections.push({ title: 'Earlier rounds', items: [{ kind: 'comments', items: older, paged: true }] });
        }
      }
      prSection();
      reportSection();
      break;
    case 'merged':
      prSection();
      branchSection();
      break;
    }
  } else if (status.kind === 'review') {
    const local: Json[] = d?.localComments || [];
    const pending = local.filter((c) => !c.submitted_at);
    const submitted = local.filter((c) => c.submitted_at);
    // The review's moment: the last submission here, or on GitHub itself - the same rule the
    // status uses, so the column and the stage agree.
    const viewer = d?.viewer || '';
    const ghReviews: Json[] = (d?.reviews || []).filter((r: Json) => r.submittedAt && (viewer ? r.author === viewer : r.author && r.author !== d?.meta?.author && !isBot(r.author)));
    const submittedAt = Math.max(0, ...submitted.map((c) => Date.parse(c.submitted_at) || 0), ...ghReviews.map((r) => Date.parse(r.submittedAt) || 0));
    // What was submitted, as threads: the review's own comments here, else the PR's threads a
    // reviewer opened (a review left on GitHub directly).
    // The threads this person is in - not every thread on the PR. Without a viewer (no token,
    // an older API) it falls back to every thread somebody other than the author opened.
    const reviewThreads = () => {
      if (!d) {
        return [];
      }
      const all = threads(d, submittedAt, kinds);
      const ours = all.filter((c) => c.mine);

      return ours.length || d.viewer ? ours : all.filter((c) => c.thread.some((t) => !t.author));
    };
    const files: Json[] = d?.files || [];
    const findings = (list: Json[]) => ({
      kind: 'comments' as const,
      paged: true,
      items: list.map((c): Comment => {
        const file = files.findIndex((f) => f.path === c.path);
        const body = String(c.body || '');

        return {
          local: !c.submitted_at, status: c.status || 'pending', attachments: c.attachments || [], id: c.id, who: c.author || 'agent', where: c.path ? `${ c.path }${ c.line ? `:${ c.line }` : '' }` : 'PR', path: c.path || '', line: Number(c.line) || 0, body: body.slice(0, 400), at: c.created_at || '', answered: !!c.submitted_at, lastBy: c.author || 'agent', lastByAuthor: false, thread: [{ who: c.author || 'agent', author: false, body, html: renderBody(body, kinds), at: c.created_at || '', isNew: false }], replied: false, mine: true, headSha: d?.meta?.headSha || '', position: 0, context: '', rows: hunkRows(c.path || '', files[file]?.patch || '', Number(c.line) || 0, c.side), noPatch: !!c.path && file >= 0 && !files[file]?.patch, url: '', order: file < 0 ? 9999 : file,
        };
      }).sort((a, b) => a.order - b.order || a.line - b.line),
    });

    switch (stage) {
    case 'agent':
      if (pending.length) {
        sections.push({ title: `Findings so far (${ pending.length })`, items: [findings(pending)] });
      }
      reportSection(status.agent === 'working' ? 'Where the agent is' : 'Agent\'s report');
      prSection();
      break;
    case 'findings': {
      sections.push({ title: `Findings (${ pending.length } to go through)`, items: pending.length ? [findings(pending)] : [{ kind: 'empty', text: submitted.length ? 'All submitted.' : 'None yet.' }] });
      // The report under the findings: it is the agent saying what it looked at and why it
      // filed what it filed, which is half of judging any of them.
      reportSection(status.reviewed && (Date.parse(report?.at || '') || 0) > submittedAt ? 'What the agent found in the developer\'s changes' : 'Agent\'s report');
      // A pass after a review of yours has a round behind it, and the round is how the
      // findings are read: what the developer changed since you last spoke, and what you and
      // they have already said to each other. Without that, a second pass is judged as if it
      // were the first.
      if (status.reviewed && d) {
        const since = (d.commits || []).filter((c: Json) => (Date.parse(c.date || '') || 0) > submittedAt).map((c: Json) => ({
          sha: String(c.sha || ''), message: c.message, who: c.author, at: c.date,
        }));
        const mine = reviewThreads().map((c) => ({ ...c, answered: c.lastByAuthor }));

        sections.push({ title: 'Since your review', items: since.length ? [{ kind: 'commits' as const, pr: status.pr, items: since, since: 'your review' }] : [{ kind: 'empty' as const, text: 'No new commits since your review.' }] });
        if (mine.length) {
          sections.push({ title: `Your threads (${ mine.filter((c) => c.answered).length } answered, ${ mine.filter((c) => !c.answered).length } waiting on the developer)`, items: [{ kind: 'comments', items: mine, paged: true }] });
        }
      }
      prSection();
      break;
    }
    case 'submitted': {
      const mine = submitted.length ? null : reviewThreads();

      sections.push({ title: `Your review (${ submitted.length || mine?.length || 0 } comments)`, items: submitted.length ? [findings(submitted)] : mine?.length ? [{ kind: 'comments', items: mine.map((c) => ({ ...c, answered: c.lastByAuthor })), paged: true }] : [{ kind: 'empty', text: 'Nothing submitted yet.' }] });
      prSection();
      break;
    }
    case 'response':
      if (d) {
        const newCommits = (d.commits || []).filter((c: Json) => (Date.parse(c.date || '') || 0) > submittedAt).map((c: Json) => ({
          sha: String(c.sha || ''), message: c.message, who: c.author, at: c.date,
        }));
        // Every thread of the review in GitHub's own order, the unanswered ones marked, so what
        // the developer addressed and what they did not are both on the page where they are.
        // Answered means the developer had the last word: a thread they replied in twice and
        // then heard something new in is still waiting on them.
        const mine = reviewThreads().map((c) => ({ ...c, answered: c.lastByAuthor }));

        sections.push({ title: 'Since your review', items: [...(newCommits.length ? [{ kind: 'commits' as const, pr: status.pr, items: newCommits, since: 'your review' }] : []), ...(!newCommits.length ? [{ kind: 'empty' as const, text: 'No new commits since your review.' }] : [])] });
        sections.push({ title: `Your threads (${ mine.filter((c) => c.answered).length } answered, ${ mine.filter((c) => !c.answered).length } waiting on the developer)`, items: mine.length ? [{ kind: 'comments', items: mine, paged: true }] : [{ kind: 'empty', text: 'You have no threads on this PR.' }] });
      }
      if (report) {
        reportSection((Date.parse(report.at) || 0) > submittedAt ? 'What the agent found in the new commits' : 'Agent\'s review report (before the developer responded)');
      }
      prSection();
      break;
    case 'approved':
      prSection();
      break;
    }
  }

  return sections;
}

/** GitHub's `#123` references as links, in rendered markdown (outside tags and code). */
export function linkRefs(html: string): string {
  return html.split(/(<[^>]+>)/).map((part, i) => (i % 2 ? part : part.replace(/(^|[\s(])#(\d{2,7})\b/g, `$1<a href="https://github.com/${ DEFAULT_REPO }/issues/$2" target="_blank" rel="noopener noreferrer">#$2</a>`))).join('');
}

// One source, two uses: `ASSET_SOURCE` builds a fresh regex each time it is needed. A shared
// /g/ regex carries `lastIndex` between calls, so `test()` answered true and false in turn -
// which is why half the images in a comment kept pointing at github.com and stayed broken.
const ASSET_SOURCE = 'https:\\/\\/(?:github\\.com\\/user-attachments\\/(?:assets|files)\\/[\\w.-]+|github\\.com\\/[\\w.-]+\\/[\\w.-]+\\/assets\\/[\\w./-]+|private-user-images\\.githubusercontent\\.com\\/[^\\s"\'<)]+|user-images\\.githubusercontent\\.com\\/[^\\s"\'<)]+)';

const isAsset = (url: string) => new RegExp(`^${ ASSET_SOURCE }$`).test(url) || /githubusercontent\.com\//.test(url);

/** The attachment URLs a body carries, for asking what they are before drawing them. */
export function assetUrls(text: string): string[] {
  return [...new Set((text || '').match(new RegExp(ASSET_SOURCE, 'g')) || [])];
}

/**
 * A comment body as HTML: markdown rendered, references linked, and GitHub's attachments
 * drawn - an image as an image, a recording as a player, through the API with the token,
 * since the browser cannot load them from GitHub itself. A bare attachment URL on a line of
 * its own is what GitHub turns into a player, and it is turned into one here too, when the
 * API said it is a video; an unknown one stays a link.
 */
export function renderBody(text: string, kinds: Record<string, string> = {}): string {
  let html = linkRefs(renderMd(text || ''));

  html = html.replace(/<img([^>]*?)\ssrc="(https:\/\/[^"]+)"/g, (m, attrs, src) => (isAsset(src) ? `<img${ attrs } src="${ ghAssetUrl(src) }" loading="lazy"` : m));
  // A bare attachment URL on its own - what GitHub itself turns into a player or a picture.
  html = html.replace(/<a target="_blank" rel="noopener" href="(https:\/\/[^"]+)">([^<]*)<\/a>/g, (m, href, label) => {
    if (label !== href || !isAsset(href)) {
      return m;
    }
    const kind = kinds[href] || '';

    if (/^video\//.test(kind)) {
      return `<video controls preload="metadata" src="${ ghAssetUrl(href) }"></video>`;
    }
    if (/^image\//.test(kind)) {
      return `<a target="_blank" rel="noopener" href="${ href }"><img src="${ ghAssetUrl(href) }" alt="attachment" loading="lazy"></a>`;
    }

    return m;
  });

  return html;
}

/** The GitHub URL of the PR a status is about, or of the issue when there is no PR yet. */
export function primaryLink(status: WorkspaceStatus): string {
  return (status.links.find((l) => l.label.startsWith('PR')) || status.links[0])?.url || `https://github.com/${ DEFAULT_REPO }`;
}

/** One commit's patch, out of the checkout: what a commit row expands to. Bounded. */
export async function commitPatch(workspace: string, sha: string): Promise<string> {
  if (!/^[0-9a-f]{6,40}$/i.test(sha)) {
    return '';
  }
  const out = await readInWorkspace(workspace, `cd $WS/dashboard 2>/dev/null || exit 0; git show --no-color --format='%H%n%an · %aI%n%n%B%n---' --stat=100 -p ${ sha } 2>/dev/null | head -1500`);

  return out.trim();
}

/** A patch as rows the page colours: the first character says which kind each line is. */
export function diffRows(patch: string): { cls: string; text: string }[] {
  return (patch || '').split('\n').map((text) => ({
    cls: /^\+\+\+ |^--- /.test(text) ? 'file' : text.startsWith('+') ? 'add' : text.startsWith('-') ? 'del' : text.startsWith('@@') ? 'hunk' : /^diff --git/.test(text) ? 'file' : '',
    text,
  }));
}

/**
 * A commit's diff, file by file, as rows the page draws. From GitHub when the commit is on a
 * PR - the checkout of a review workspace can be behind the branch - and from the checkout
 * otherwise. Bounded per file.
 */
export async function commitFiles(workspace: string, pr: number, sha: string): Promise<{ path: string; rows: CodeRow[]; status: string }[]> {
  if (pr) {
    const diff = await commitsDiff(pr, [sha]).catch(() => null);
    const files: Json[] = diff?.files || [];

    if (files.length) {
      const out = files.slice(0, 40).map((f) => ({ path: f.path || f.filename || '', rows: fileRows(f.path || f.filename || '', f.patch || '', 300), status: f.status || '' }));

      if (files.length > 40) {
        out.push({ path: `… ${ files.length - 40 } more files - open the commit on GitHub`, rows: [], status: '' });
      }

      return out;
    }
  }
  const raw = await commitPatch(workspace, sha);
  const out: { path: string; rows: CodeRow[]; status: string }[] = [];
  const parts = raw.split(/^diff --git a\/(\S+) b\/\S+$/m);

  for (let i = 1; i < parts.length; i += 2) {
    out.push({ path: parts[i], rows: fileRows(parts[i], parts[i + 1] || '', 300), status: '' });
  }

  return out;
}

/**
 * More of a file around a hunk, from the file as it is at the PR's head: the lines above the
 * hunk's first new-side line, or below its last, as context rows numbered on the new side.
 */
export function contextRows(path: string, fileText: string, fromLine: number, toLine: number): CodeRow[] {
  const lines = (fileText || '').split('\n');
  const first = Math.max(1, fromLine);
  const last = Math.min(lines.length, toLine);

  if (last < first) {
    return [];
  }
  const slice = lines.slice(first - 1, last);
  const html = highlightLines(path, slice);

  return slice.map((_, i) => ({
    type: 'ctx', oldN: null, newN: first + i, html: html[i], marked: false,
  }));
}

/** Every commit of a list as one diff - what changed since a moment, read at once. */
export async function combinedFiles(pr: number, shas: string[]): Promise<{ path: string; rows: CodeRow[]; status: string }[]> {
  const diff = await commitsDiff(pr, shas.filter((s) => /^[0-9a-f]{7,40}$/i.test(s))).catch(() => null);
  const files: Json[] = diff?.files || [];
  const out = files.slice(0, 60).map((f) => ({ path: f.path || f.filename || '', rows: fileRows(f.path || f.filename || '', f.patch || '', 400), status: f.status || '' }));

  if (files.length > 60) {
    out.push({ path: `… ${ files.length - 60 } more files - open the PR on GitHub`, rows: [], status: '' });
  }

  return out;
}

/**
 * The prompt each non-skill action sends, as a template. Keyed like the skills are, so an edit
 * is kept and shared the same way.
 */
export const ACTION_TEMPLATES: Record<string, string> = {
  startFix:       '/my-issue-fix Fix {{ repo }} issue {{ issue }} - this project was created for it.',
  startReview:    '/my-pr-full-review Review {{ repo }} PR {{ pr }} - harness portal context, file through {{ context }}.',
  answerFeedback: '/my-pr-address-feedback Address the review feedback on {{ repo }} PR {{ pr }}: read every comment left since the last push, answer each one or change the code, re-verify, and push. Report what you changed and what you answered.',
  reverify:       '/my-fix-demonstrate Re-verify the fix on this branch (PR {{ pr }}) and record a fresh video of the same walk.',
  reviewAgain:    'The developer pushed new commits and/or replied since the review of {{ repo }} PR {{ pr }} was submitted. Review what changed against the comments that were made: say which are addressed, which are not, and anything new the changes introduce. File through {{ context }}.',
};

/**
 * The skills worth running at each stage, as buttons beside the one primary action.
 *
 * Every one of them is a prompt into the workspace's conversation - the same path everything
 * else here takes - so what a button starts can be watched and talked to. Only the skills that
 * make sense where the work is: a review's own passes while reviewing, the PR's while the PR
 * is the thing being worked on.
 */
export interface SkillButton {
  label: string;
  skill: string;
  /** What it does, for the button's title. */
  note: string;
  /** Whether it wants its own conversation rather than the one about this work. */
  fresh?: boolean;
}

export function skillsFor(kind: WorkspaceStatus['kind'], stage: Stage): SkillButton[] {
  // `my-pr-checklist` is not here on the review side: the PR template's checklist is the
  // author's work, and a reviewer ticking it is doing somebody else's job. It belongs to the
  // fix stages below, where this person is the author.
  if (kind === 'review') {
    switch (stage) {
    case 'agent':
      return [
        { label: 'Full review', skill: 'my-pr-full-review', note: 'Demo the change, demo the issue, review the diff, verify every comment', fresh: true },
        { label: 'Comments only', skill: 'my-pr-review', note: 'Short pending inline comments, nothing submitted' },
        { label: 'Demo the change', skill: 'my-pr-demo-changes', note: 'Record what the PR changes, against its own build' },
      ];
    case 'findings':
      return [
        { label: 'Verify the findings', skill: 'my-pr-comment-verify', note: 'Prove each comment with a recording or a screenshot attached to it' },
        { label: 'Sharpen the wording', skill: 'my-pr-comment-refinement', note: 'Rewrite each pending comment into impact, why it matters, and evidence' },
        { label: 'Demo the change', skill: 'my-pr-demo-changes', note: 'Record what the PR changes, against its own build' },
      ];
    case 'submitted':
      // Nothing to ask for while it is with the developer; a re-read of the diff is the one
      // thing that can still be useful.
      return [{ label: 'Read the diff again', skill: 'my-pr-review', note: 'Another pass over the diff, as pending comments' }];
    case 'response':
      // Not `my-pr-review` here: the stage's own action already asks for exactly that, and two
      // buttons with one label is worse than one.
      return [
        { label: 'Verify the answers', skill: 'my-pr-comment-verify', note: 'Check what the developer says they fixed' },
        { label: 'Sharpen the wording', skill: 'my-pr-comment-refinement', note: 'Rewrite each pending comment into impact, why it matters, and evidence' },
        { label: 'Demo the change', skill: 'my-pr-demo-changes', note: 'Record what the PR changes now' },
      ];
    default:
      return [];
    }
  }
  if (kind === 'fix') {
    switch (stage) {
    case 'assess':
      return [
        { label: 'Reproduce it', skill: 'my-issue-reproduce', note: 'Record the bug happening, against the current build' },
        { label: 'Root cause', skill: 'my-root-cause-analysis', note: 'Candidates with evidence, the chosen one, the plan' },
      ];
    case 'code':
      return [
        { label: 'Verify the fix', skill: 'my-fix-verify', note: 'Self-review, a test that fails without the fix, edge cases' },
        { label: 'Demonstrate it', skill: 'my-fix-demonstrate', note: 'Record the same walk, now correct' },
        { label: 'Open the PR', skill: 'my-pr-create', note: 'Branch, push, upload the media, open the draft PR' },
      ];
    case 'draft':
      return [
        { label: 'Checklist', skill: 'my-pr-checklist', note: 'Work every item of the PR template checklist' },
        { label: 'Rewrite the body', skill: 'my-pr-fill-template', note: 'Compose the PR body from the template' },
        { label: 'Demo the issue', skill: 'my-pr-demo-issue', note: 'Record the bug on a build without the fix' },
      ];
    case 'review':
      return [{ label: 'Checklist', skill: 'my-pr-checklist', note: 'Work every item of the PR template checklist' }];
    case 'feedback':
      return [
        { label: 'Address the feedback', skill: 'my-pr-address-feedback', note: 'Fix what has merit, answer what does not, push' },
        { label: 'Re-verify', skill: 'my-fix-demonstrate', note: 'Record the same walk again after the changes' },
      ];
    default:
      return [];
    }
  }

  return [];
}

/**
 * What goes into a prompt, and what each one means: shown beside the template so the person
 * editing it knows what they may write, and filled in when the prompt is sent.
 *
 * `$CLAUDE_HARNESS_API` is deliberately not one of these - it is an environment variable of
 * the workspace's own shell, which the agent expands when it runs a command.
 */
export interface PromptVar {
  name: string;
  value: string;
  about: string;
}

export function promptVars(status: WorkspaceStatus | null, issue: number, workspace: string): PromptVar[] {
  const pr = status?.pr || 0;

  return [
    { name: 'repo', value: DEFAULT_REPO, about: 'The repository this workspace works in' },
    { name: 'pr', value: pr ? `#${ pr }` : '', about: 'The pull request, when there is one' },
    { name: 'prNumber', value: pr ? String(pr) : '', about: 'Its number alone' },
    { name: 'issue', value: issue ? `#${ issue }` : '', about: 'The issue this workspace is for' },
    { name: 'issueNumber', value: issue ? String(issue) : '', about: 'Its number alone' },
    { name: 'subject', value: pr ? `${ DEFAULT_REPO } PR #${ pr }` : issue ? `${ DEFAULT_REPO } issue #${ issue }` : 'this workspace', about: 'The PR if there is one, else the issue' },
    { name: 'title', value: status?.title || '', about: 'Its title on GitHub' },
    { name: 'workspace', value: workspace, about: 'This workspace\'s name' },
    { name: 'stage', value: status?.stage || '', about: 'Where the work is on the rail' },
    { name: 'context', value: pr ? `$CLAUDE_HARNESS_API/my-work/pr/${ pr }` : '', about: 'Where the agent reads the PR from, inside the workspace' },
  ];
}

/** A template with its variables filled in. An unknown `{{ name }}` is left as it is. */
export function expandPrompt(template: string, vars: PromptVar[]): string {
  return (template || '').replace(/\{\{\s*([a-zA-Z]+)\s*\}\}/g, (whole, name) => {
    const found = vars.find((v) => v.name === name);

    return found ? found.value : whole;
  });
}

/** What a skill button sends, before the variables go in. */
export function skillTemplate(button: SkillButton): string {
  return `/${ button.skill } {{ subject }}{{ contextClause }}`;
}

/** The clause a PR adds; empty without one, so the sentence still ends properly. */
function contextClause(status: WorkspaceStatus | null): PromptVar {
  return { name: 'contextClause', value: status?.pr ? ` - its context: $CLAUDE_HARNESS_API/my-work/pr/${ status.pr }.` : '.', about: 'Where to read the PR, or just a full stop' };
}

export function skillPrompt(button: SkillButton, status: WorkspaceStatus, issue: number, workspace = '', template = ''): string {
  const vars = [...promptVars(status, issue, workspace), contextClause(status)];

  return expandPrompt(template || skillTemplate(button), vars);
}

