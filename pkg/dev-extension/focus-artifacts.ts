// What a card puts in front of you so you can decide without leaving it.
//
// A card used to be a title, a line about why it is here, and three buttons. That is enough to
// recognise the work and not nearly enough to do anything about it: every card, whatever it was
// about, ended in opening something else. So each kind of work now carries the things you would
// have gone looking for - the change itself, what the agent found, what it recorded while it
// checked, what CI says, where the running build is - and the buttons do what you would have
// done when you got there.
//
// Two rules hold this together.
//
// **A card draws what it has.** Nothing here is required, and the card composes whatever came
// back rather than switching on a kind. A new kind of work needs data, not a new component; a
// card whose pull request has no screenshots is the same card with one fewer part.
//
// **Only the card in front of you is read.** Every artifact below is a network call or several -
// a pull request with its files, its checks, its comments - and a deck of thirty would be thirty
// pull requests fetched to draw one. See `wants` on CardDef for what each card asks for, and
// Focus.vue for the one place that asks.

import { DEFAULT_REPO, prDetail, ciFailures, artifactUrl } from './reviews';
import type { LocalComment, LocalAttachment } from './reviews';
import { issueBody } from './github';
import { reviewNotes, parsePatch, hunkAround } from './focus-review';
import type { DiffLine, ReviewNote } from './focus-review';
import { devFetch, workspaceMediaListUrl, workspaceMediaFileUrl } from './api';
import { APP_INSTANCE } from './config/constants';
import { previewState } from './previews';
import type { ShareKind } from './workspace-tools';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Store = any;

/**
 * The kinds of thing a card can ask for.
 *
 * Named for what they are to a reader rather than for where they come from: `files` is the
 * change, `notes` is the agent's review of somebody else's change, `comments` is what people
 * said, `media` is what was recorded. A card lists the ones it wants and gets nothing else.
 */
/** What a `rancher-share` AppInstance says it is a share of. Set by the agent's own skill. */
const SHARE_OF_LABEL = 'dev.rancher.io/share-of';

export type Artifact = 'stat' | 'checks' | 'notes' | 'files' | 'comments' | 'media' | 'live' | 'body';

/** How big the change is. Three numbers, because they are the three everybody asks for. */
export interface CardStat { files: number; added: number; removed: number }

export interface CardCheck {
  name: string;
  state: 'passed' | 'failed' | 'running';
  /** What it said, when it said anything: the check's own one-line summary. */
  detail: string;
  url: string;
}

export interface CardMedia {
  kind: 'image' | 'video';
  label: string;
  src: string;
  caption: string;
  /** ISO, so the newest can come first and a card can say how old the evidence is. */
  at: string;
}

/**
 * Something running that you can open and click around in.
 *
 * Three things end up here and they are made by three different parts of this product, which is
 * why they are flattened into one shape rather than named for their mechanism. A reviewer does
 * not care which of them built the thing; they care that there is a link, that it is up, and
 * what it is of.
 */
export interface CardLive {
  kind: ShareKind | 'rancher';
  label: string;
  url: string;
  state: 'absent' | 'building' | 'serving' | 'failed';
  detail: string;
}

/** One hunk of a file's diff: the `@@` line and the run under it. */
export interface DiffHunk { header: string; lines: DiffLine[] }

export interface CardFile {
  path: string;
  status: string;
  added: number;
  removed: number;
  hunks: DiffHunk[];
}

/** Something a person or an agent said about the change, with whatever it attached. */
export interface CardComment {
  id: number;
  author: string;
  /** Written by you, so the card can tell what it is waiting on from what it already answered. */
  mine: boolean;
  /** Not posted yet: the agent's own, still waiting for your pass. */
  pending: boolean;
  body: string;
  path: string;
  line: number | null;
  at: string;
  media: CardMedia[];
  /**
   * The lines it is about.
   *
   * A comment read without its code is a comment you have to go and look up, which is the whole
   * thing this card is trying to stop. GitHub sends the hunk it anchored to with every review
   * comment; the agent's own come with the patch they were written against. Either way the code
   * comes to the comment.
   */
  hunk: DiffLine[];
}

export interface CardArtifacts {
  stat: CardStat | null;
  checks: CardCheck[];
  notes: ReviewNote[];
  files: CardFile[];
  comments: CardComment[];
  media: CardMedia[];
  live: CardLive[];
  body: string;
  labels: string[];
}

export const NO_ARTIFACTS: CardArtifacts = {
  stat: null, checks: [], notes: [], files: [], comments: [], media: [], live: [], body: '', labels: [],
};

/* ── Reading one thing at a time ────────────────────────────────────────────────────────────── */

/**
 * A patch, split where the diff splits it.
 *
 * `parsePatch` flattens a patch into numbered lines, which is what a comment wants - it has one
 * line to point at. A file being read wants the breaks too: two runs a hundred lines apart are
 * not one run, and drawn as one they read as code that does not compile.
 */
export function patchHunks(patch: string): DiffHunk[] {
  const out: DiffHunk[] = [];
  let header = '';
  let buffer: string[] = [];

  const flush = () => {
    if (buffer.length) {
      out.push({ header, lines: parsePatch([header, ...buffer].join('\n')) });
    }
    buffer = [];
  };

  for (const raw of String(patch || '').split('\n')) {
    if (/^@@ /.test(raw)) {
      flush();
      header = raw;
    } else if (header) {
      buffer.push(raw);
    }
  }
  flush();

  return out;
}

/** The number in `PR #19212` or `Issue #18905`, or 0. */
export function numberIn(what: string): number {
  return Number(/#(\d+)/.exec(String(what || ''))?.[1] || 0);
}

function statOf(detail: Json): CardStat | null {
  const meta = detail?.meta;

  if (!meta || meta.changedFiles === undefined) {
    return null;
  }

  return { files: meta.changedFiles || 0, added: meta.additions || 0, removed: meta.deletions || 0 };
}

/**
 * CI, as the few lines worth reading.
 *
 * The counts come off the pull request; the names come off the failures, because a passing
 * check has nothing to say and twenty of them said at length is how a card stops being read.
 * So: every failure by name with what it reported, and one pill for everything that passed.
 */
async function checksOf(pr: number, detail: Json): Promise<CardCheck[]> {
  const ci = detail?.meta?.ci;

  if (!ci || !ci.total) {
    return [];
  }
  const out: CardCheck[] = [];

  if (ci.failing) {
    const failures = await ciFailures(pr).catch(() => null);

    for (const check of (failures?.checks || []).slice(0, 6)) {
      out.push({
        name:   check.name || 'check',
        state:  'failed',
        detail: String(check.title || check.summary || '').split('\n')[0].slice(0, 120),
        url:    check.url || ci.failingUrl || '',
      });
    }
    // Named by the counts when the detail call came back with nothing, so a red card is never
    // a card that says everything passed.
    if (!out.length) {
      out.push({
        name: `${ ci.failing } failing`, state: 'failed', detail: '', url: ci.failingUrl || '',
      });
    }
  }
  if (ci.pending) {
    out.push({
      name: `${ ci.pending } still running`, state: 'running', detail: '', url: '',
    });
  }

  const passed = (ci.total || 0) - (ci.failing || 0) - (ci.pending || 0);

  if (passed > 0) {
    out.push({
      name: `${ passed } passed`, state: 'passed', detail: '', url: '',
    });
  }

  return out;
}

const MEDIA_KIND = (type: string, name: string): 'image' | 'video' => (
  /video/.test(type || '') || /\.(webm|mp4|mov)$/i.test(name) ? 'video' : 'image'
);

/** What an agent recorded while it worked: the screenshots and the recordings in its workspace. */
async function mediaOf(workspace: string): Promise<CardMedia[]> {
  if (!workspace) {
    return [];
  }
  const data = await devFetch(workspaceMediaListUrl(workspace)).catch(() => null);
  const files: Json[] = data?.files || [];

  return files
    // The accessibility sweep writes hundreds of these and none of them is evidence of anything
    // in particular; the rail leaves them out for the same reason.
    .filter((f) => !/^a11y\//.test(f.path))
    .sort((a, b) => (b.mtimeMs || 0) - (a.mtimeMs || 0))
    .slice(0, 8)
    .map((f) => ({
      kind:    MEDIA_KIND(f.type, f.name || f.path),
      label:   String(f.name || f.path).split('/').pop() || f.path,
      src:     workspaceMediaFileUrl(workspace, f.path),
      caption: f.path,
      at:      new Date(f.mtimeMs || 0).toISOString(),
    }));
}

/** The evidence an agent hung on one of its own comments, served out of its workspace. */
function attachedTo(pr: number, comment: LocalComment): CardMedia[] {
  return (comment.attachments || [])
    .filter((a: LocalAttachment) => a.found && a.kind !== 'file')
    .map((a: LocalAttachment) => ({
      kind:    a.kind === 'video' ? 'video' as const : 'image' as const,
      label:   a.name || a.path,
      src:     artifactUrl(pr, a.path),
      caption: a.caption || a.path,
      at:      comment.updated_at || comment.created_at || '',
    }));
}

/**
 * What was said about the change, newest last, with what it carried.
 *
 * Both sides of it: what people wrote on GitHub, and what the agent has written here and not
 * posted yet. A card about answering feedback is a card about the first; a card about passing
 * over an agent's review is about the second, and `pending` is how it tells them apart.
 */
/** The run of lines a pending comment points at, found in the pull request's own patches. */
function hunkFor(detail: Json, path: string, line: number | null): DiffLine[] {
  if (!path || !line) {
    return [];
  }
  const file = (detail?.files || []).find((f: Json) => f.path === path);

  return file?.patch ? hunkAround(parsePatch(file.patch), line) : [];
}

function commentsOf(pr: number, detail: Json, me: string): CardComment[] {
  const local: LocalComment[] = detail?.localComments || [];
  const mine = me.toLowerCase();
  const fromGithub: CardComment[] = (detail?.reviewComments || [])
    .filter((c: Json) => !c.pending)
    .map((c: Json) => ({
      id:      Number(c.id) || 0,
      author:  c.author || 'somebody',
      mine:    String(c.author || '').toLowerCase() === mine,
      pending: false,
      body:    String(c.body || ''),
      path:    c.path || '',
      line:    c.line ?? c.originalLine ?? null,
      at:      c.createdAt || '',
      media:   [],
      hunk:    parsePatch(c.diffHunk || '').slice(-10),
    }));
  const fromHere: CardComment[] = local
    .filter((c) => c.status === 'pending')
    .map((c) => ({
      id:      c.id,
      author:  c.author === 'you' ? me || 'you' : (c.author || 'the agent'),
      mine:    c.author === 'you',
      pending: true,
      body:    String(c.body || ''),
      path:    c.path || '',
      line:    c.line,
      at:      c.updated_at || c.created_at || '',
      media:   attachedTo(pr, c),
      hunk:    hunkFor(detail, c.path, c.line),
    }));

  return [...fromGithub, ...fromHere]
    .sort((a, b) => String(a.at).localeCompare(String(b.at)))
    .slice(-12);
}

/**
 * Shares the agent put up, found by what they are shares of.
 *
 * These are not the Share tab's builds. An agent asked to share its work runs the
 * `my-rancher-share` skill, which installs a `rancher-share` App of its own - a whole Rancher
 * with the branch's dashboard in it, or a Storybook, on a public sslip name that opens without a
 * login here. They are the thing somebody means by "the shared Rancher", and nothing in this
 * view knew about them.
 *
 * The join is the label the skill sets. The name carries a suffix the agent chose
 * (`share-issue-18062-storybook`), so it is no use for finding them and good for saying which
 * one this is.
 */
async function sharesOf(workspace: string): Promise<CardLive[]> {
  const found = await devFetch(`/v1/${ APP_INSTANCE }s?labelSelector=${ encodeURIComponent(`${ SHARE_OF_LABEL }=${ workspace }`) }`).catch(() => null);
  const rows: Json[] = (found?.data || []).filter((row: Json) => row.metadata?.labels?.[SHARE_OF_LABEL] === workspace);

  return rows.map((row: Json) => {
    const host = String(row.spec?.values?.host || '');
    const name = String(row.metadata?.name || '');
    const storybook = /storybook/.test(name) || /storybook/.test(host);

    return {
      kind:   storybook ? 'storybook' as const : 'rancher' as const,
      label:  storybook ? 'Storybook, shared' : 'Rancher, shared',
      url:    host ? `https://${ host }/` : '',
      state:  host ? 'serving' as const : 'building' as const,
      detail: name,
    };
  }).filter((entry) => entry.url);
}

/** The builds of this workspace that are up on a link, and the ones that failed trying. */
async function liveOf(store: Store, workspace: string): Promise<CardLive[]> {
  if (!workspace) {
    return [];
  }
  const kinds: ShareKind[] = ['dashboard', 'storybook'];
  const [previews, shares] = await Promise.all([
    store
      ? Promise.all(kinds.map((kind) => previewState(store, workspace, 'local', kind).catch(() => null)))
      : Promise.resolve([]),
    sharesOf(workspace).catch(() => [] as CardLive[]),
  ]);

  const built = (previews as Json[])
    .map((state, n) => (state && state.exists ? {
      kind:   kinds[n],
      label:  kinds[n] === 'storybook' ? 'Storybook, built' : 'The dashboard, built',
      url:    state.direct || state.url,
      state:  state.state,
      detail: state.detail,
    } as CardLive : null))
    // `entry !== null` rather than `Boolean(entry)`: the second does not narrow the type inside
    // the same expression, so reading `entry.url` after it is an error the dev server's
    // transpile-only pass does not raise and a real build does.
    .filter((entry): entry is CardLive => entry !== null && (!!entry.url || entry.state !== 'absent'));

  return [...shares, ...built];
}

/* ── Reading what one card wants ────────────────────────────────────────────────────────────── */

/** What a task is about, as the things that can be looked up. */
export interface Subject {
  /** The pull request, when there is one. */
  pr: number;
  /** The issue, when the work is an issue rather than a pull request. */
  issue: number;
  workspace: string;
  rule: string;
}

export function subjectOf(task: { what: string; workspace: string; rule: string }): Subject {
  const n = numberIn(task.what);
  const isIssue = /issue/i.test(task.what);

  return {
    pr:        isIssue ? 0 : n,
    issue:     isIssue ? n : 0,
    workspace: task.workspace || '',
    rule:      task.rule || '',
  };
}

/**
 * Everything the card in front of you asked for, read once.
 *
 * `wants` comes off the card definition, so what a card shows is configuration rather than code
 * and an agent asked to change a card can change what it puts in front of you. Everything is
 * read in parallel and every one of them is allowed to fail on its own: a card with no CI is a
 * card without that part, not a card that failed to load.
 */
export async function readArtifacts(
  task: { what: string; workspace: string; rule: string },
  wants: Artifact[],
  store: Store,
  me = '',
): Promise<CardArtifacts> {
  const want = new Set(wants || []);
  const subject = subjectOf(task);
  const out: CardArtifacts = { ...NO_ARTIFACTS };

  if (!want.size) {
    return out;
  }

  // One read of the pull request behind everything that comes off it. `prDetail` keeps its
  // answer for a few seconds, but the point here is that four artifacts share one await rather
  // than racing four of them through the same cache.
  const needsPr = subject.pr && ['stat', 'checks', 'files', 'comments', 'body'].some((kind) => want.has(kind as Artifact));
  const detail = needsPr ? await prDetail(subject.pr).catch(() => null) : null;

  await Promise.all([
    (async() => {
      if (want.has('stat') && detail) {
        out.stat = statOf(detail);
      }
    })(),

    (async() => {
      if (want.has('checks') && detail && subject.pr) {
        out.checks = await checksOf(subject.pr, detail).catch(() => []);
      }
    })(),

    (async() => {
      if (want.has('notes') && subject.pr) {
        out.notes = await reviewNotes(subject.pr).catch(() => []);
      }
    })(),

    (async() => {
      if (want.has('files') && detail) {
        out.files = (detail.files || [])
          .slice(0, 40)
          .map((f: Json) => ({
            path:    f.path,
            status:  f.status || 'modified',
            added:   f.additions || 0,
            removed: f.deletions || 0,
            hunks:   patchHunks(f.patch || ''),
          }))
          // A file with no patch is one GitHub would not render either - a binary, or a change
          // too big to send - and an empty pane is worse than a file that is not offered.
          .filter((f: CardFile) => f.hunks.length);
      }
    })(),

    (async() => {
      if (want.has('comments') && detail && subject.pr) {
        out.comments = commentsOf(subject.pr, detail, me);
      }
    })(),

    (async() => {
      if (want.has('media')) {
        out.media = await mediaOf(subject.workspace).catch(() => []);
      }
    })(),

    (async() => {
      if (want.has('live')) {
        out.live = await liveOf(store, subject.workspace).catch(() => []);
      }
    })(),

    (async() => {
      if (!want.has('body')) {
        return;
      }
      if (subject.issue) {
        const issue = await issueBody(DEFAULT_REPO, subject.issue).catch(() => null);

        out.body = String(issue?.body || '').slice(0, 2400);
      } else if (detail) {
        out.body = String(detail.meta?.body || '').slice(0, 2400);
      }
    })(),
  ]);

  return out;
}
