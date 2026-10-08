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

import {
  DEFAULT_REPO, prDetail, ciFailures, ciFailureDetail, artifactUrl
} from './reviews';
import type { LocalComment, LocalAttachment } from './reviews';
import { issueBody } from './github';
import type { ConversationSnapshot } from './conversations';
import { reviewNotes, parsePatch, hunkAround } from './focus-review';
import type { DiffLine, ReviewNote } from './focus-review';
import { devFetch, workspaceMediaListUrl, workspaceMediaFileUrl } from './api';
import { listConversations } from './conversations';
import { latestAgentReport } from './conversations';
import { conversationPane, readInWorkspace } from './workspace-tools';
import { readPane } from './chat';
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

/**
 * The artifacts that become the card's main surface, as against the band above it.
 *
 * Known from the definition, before anything is read, which is what lets a card lay itself out
 * once. The layout used to follow the artifacts that had *arrived*: no surface yet meant no
 * `card--pass`, which meant the big title - so the title shrank and the summary reflowed the
 * moment the content landed, and the header you had started reading moved. A card knows from its
 * own `wants` whether it is going to have a surface; that does not change while it loads.
 */
/*
 * `SURFACE_WANTS` lived here: the list of wants that meant "this card has a surface, so lay the
 * header out smaller and hide the two fallback blocks". Both fallbacks are gone - they were gated
 * on *not* having a surface, and fifteen of the sixteen shipped cards have one, so neither drew on
 * any of the deck's thirty-six - and the header has one size now, from a written budget rather
 * than from what a card happens to have asked for. Nothing imported it.
 */

export type Artifact =
  | 'stat' | 'checks' | 'logs' | 'notes' | 'files' | 'comments' | 'media' | 'live' | 'body'
  | 'pool' | 'reviewers' | 'commits' | 'conversation' | 'advisory' | 'bump' | 'bumps';

/** How big the change is. Three numbers, because they are the three everybody asks for. */
export interface CardStat { files: number; added: number; removed: number }

export interface CardCheck {
  /**
   * The check run's id on GitHub, or 0 where it has none.
   *
   * 0 means a *status context* - something a bot posted against the commit rather than a job
   * that ran - and the difference is not cosmetic: a status has no log and no annotations, so
   * `Description` and `validate` on this repository's pull requests are rows you can only read
   * on GitHub. Anything with an id has its own output, which is what `CheckReport` is.
   */
  id: number;
  name: string;
  state: 'passed' | 'failed' | 'running';
  /** What it said, when it said anything: the check's own one-line summary. */
  detail: string;
  url: string;
}

/** One place GitHub itself says a check broke: a file, a line, and what it said there. */
export interface CheckAnnotation {
  path: string;
  line: number;
  endLine: number;
  /** `failure`, `warning` or `notice`. The failures are sorted first; see `ciFailureDetail`. */
  level: string;
  message: string;
  title: string;
}

/**
 * What one failing check actually printed.
 *
 * The thing the red-pr card was missing. It had the *names* of the failing jobs - which is not
 * information anybody decides anything on - and the only way to the assertion that failed was to
 * leave the card for GitHub and come back to a deck that had moved on.
 *
 * A CI log is megabytes of `yarn install` and passes, so this is never the log: it is the window
 * around the first thing in it that looks like a failure, with the lines the matcher fired on
 * called out so they can be marked rather than hunted for. `dev-api`'s `failureExcerpt` picks the
 * window - the regex for what a failure looks like belongs next to the log, not in the browser -
 * and `/ci/{id}/log` has the whole thing for the second look.
 */
export interface CheckReport {
  /** Which check this is the output of. Matches `CardCheck.id`. */
  id: number;
  name: string;
  url: string;
  /** The check's own headline, which is often the whole answer: "3 of 48 specs failed". */
  title: string;
  /** And its own body, which is all there is when the check kept no log. */
  summary: string;
  annotations: CheckAnnotation[];
  /** The window: the failure and its neighbourhood, timestamps and ANSI colour already off. */
  text: string;
  /** Lines of `text`, 1-based, that look like the failure itself. What the card marks. */
  hits: number[];
  /** Where `text` begins in the whole log, 1-based, so its lines carry the log's own numbers. */
  at: number;
  /** How long the whole retained log is, so the card can say how much of it this is. */
  lines: number;
  /** False where nothing looked like a failure and `text` is the log's last lines instead. */
  matched: boolean;
  /** The Actions job behind it, for saying where the lines are from. 0 for a status context. */
  jobId: number;
}

export interface CardMedia {
  /**
   * Not everything an agent leaves behind is a picture.
   *
   * The artifacts directory holds its notes and briefs as well as its screenshots, and with only
   * two kinds here every one of those was drawn as an image: a broken \`<img>\` where the preview
   * should be, under the word "Image". `text` is the third kind, so a file that is read rather
   * than looked at can be drawn as one.
   */
  kind: 'image' | 'video' | 'text';
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

/** One thing you could pick up, with what there is to judge it by. */
export interface PoolIssue {
  number: number;
  title: string;
  url: string;
  repo: string;
  labels: string[];
  /** How much has been said on it: the cheapest signal of whether it is specified. */
  comments: number;
  /** Days since it was opened. */
  age: number;
  /**
   * Who *else* already has it.
   *
   * Always empty for the pool - it is built from the unassigned search - and on the card about a
   * single issue it is the one fact that makes "Start the fix" the wrong button.
   *
   * **The viewer is not in here.** It was every assignee, and `fromIssues` builds these cards from
   * the viewer's own issues with a board status of Working - so the assignee is always the viewer,
   * and IssueMarks drew `codyrancher has it` in `--warning` on 6 of 6 start-fix cards, naming the
   * person reading it. A warning that fires on every card of a kind carries no information and
   * reads as if somebody else has the work. What is worth the colour is the other case, which the
   * live deck has exactly one of: `MSpencer87 also has it` on #13888.
   */
  assignee: string;
  /** And whether the viewer is one of them, which is what makes it "also". */
  mine?: boolean;
}

/**
 * Somebody worth asking, and the reason they are worth asking.
 *
 * The reason is the half that makes the row a decision rather than a name: "touched this branch"
 * and "already commented on it" are different claims, and a list of five bare handles is a
 * reviewer picker, which is the thing this card exists instead of.
 */
export interface Candidate {
  who: string;
  /** In words, on the line under the name: "already commented on it". */
  why: string;
}

/** Who has been asked to review, who has answered, and who else knows this change. */
export interface Reviewers {
  asked: string[];
  approved: string[];
  /** Who to ask, best first, with the reason each. See `reviewersOf`. */
  suggested: Candidate[];
}

/**
 * What the agent is actually asking, and the last thing it said.
 *
 * The card this is for is the highest thing in the queue - an agent has stopped and nothing it
 * is doing can continue until it hears back - and it was showing the pull request's description,
 * because `body` is what it asked for and that is what `body` resolves to. The one thing needed
 * to answer the question was the one thing not on the card.
 *
 * `question` is the dialog claude is showing, read off its pane: the prompt and its numbered
 * choices, which is what makes this answerable from here rather than somewhere else. `said` is
 * its last report, for a stop with no question in it - which is what `stalled` always is.
 */
export interface AgentTurn {
  /** The conversation it is in, so a card can open exactly that one. */
  conversation: string;
  /** The question, when it is asking one. */
  question: string;
  /** The choices it is offering, when it offers any. */
  options: { key: string; label: string; selected: boolean }[];
  /** What kind of answer it wants: a choice, a yes, a line of text. */
  wants: string;
  /** The last thing it said, when there is no dialog up. */
  said: string;
  /** Where it has got to, in its own words ("Brewing for 12s"), or '' when it is not working. */
  status: string;
  /** Its last few lines, for a stop that is neither a question nor a report. */
  tail: string;
  /** What the conversation is called, for a card that can say nothing else about it. */
  title: string;
  /**
   * Whether its pane could be read at all.
   *
   * `agentTurnOf` used to return null when every pane came back empty, and null is the one
   * answer this card cannot use: the surface ladder falls through, and the highest thing in the
   * whole queue - an agent blocked on an answer - draws as a title, a why-line and three
   * buttons. False here means "it is there, we could not read it", which is a sentence; null
   * meant nothing at all.
   */
  reachable: boolean;
}

/** A security advisory, as the thing you decide about. */
export interface AdvisoryFacts {
  severity: string;
  /** The packages it is about. */
  packages: string[];
  /** What is vulnerable, and what fixes it. */
  affected: string;
  patched: string;
  /** How many alerts it raised in this repository. */
  alerts: number;
  summary: string;
}

/** A dependency bump: the one fact that decides it. */
export interface BumpFacts {
  package: string;
  ecosystem: string;
  from: string;
  to: string;
  /** Whether the version jump crosses a major, which is the whole question. */
  major: boolean;
}

/**
 * One row of the bumps card: a bump, as the four things that decide it in a list.
 *
 * Deliberately off the bot's own pull request list and nothing else - no per-bump detail read -
 * because eleven bumps would otherwise be eleven pull requests' worth of calls for a card you
 * scan, and because one source per number is what stopped two different failing counts appearing
 * on the same card. See fromBotPrs.
 */
export interface BumpRow {
  number: number;
  package: string;
  from: string;
  to: string;
  url: string;
  state: 'green' | 'failing' | 'pending';
  /**
   * Whether the jump crosses a major.
   *
   * The single-bump card has said this since it was written - "crosses a major: a major version
   * can change or remove what this repository uses, worth reading the changelog before merging" -
   * and the card that merges without reading did not have it. On the live pile the one green row
   * was `ts-node 8.10.2 → 10.9.2`, a major, and it was exactly what "Merge the green ones"
   * merged. Stating the deciding fact on one card and withholding it on the card that acts is
   * worse than never stating it.
   */
  major: boolean;
  failing: number;
  /** Days since it was last touched: an old bump is usually one nobody will ever read. */
  age: number;
}

/** A commit on the branch: what there is to turn into a pull request. */
export interface CardCommit {
  sha: string;
  message: string;
  author: string;
  at: string;
}

/**
 * What CI says about a pull request, as the counts it says it in.
 *
 * Separate from `checks` because they are not the same thing and the card was reading one as the
 * other. `checks` is at most six failures *by name*; this is how many there are. A lede reading
 * `6 of 7 checks failing` sat 36px above its own summary line reading `6 of 46 checks failing`,
 * and a badge read `1 passed` on a pull request where 40 had. The numbers were counts of display
 * rows. They come straight off `detail.meta.ci`, which `ciOf` was already reading.
 */
export interface CardCi {
  total: number;
  failing: number;
  pending: number;
  passed: number;
}

export interface CardArtifacts {
  stat: CardStat | null;
  ci: CardCi | null;
  /** The failures, by name, capped at six. How many there are is `ci`. */
  checks: CardCheck[];
  /**
   * And what one of them printed, for the card whose whole subject is a red build.
   *
   * One, not six. Each of these costs a check-run read plus a streamed log tail, and the deck
   * prefetches the two cards either side of the one you are looking at - so six would be
   * eighteen log fetches to draw one card. The one picked is the first failure with an Actions
   * job behind it; the other five are a press away, and `CheckList` reads them on that press.
   * Only the cards that ask for `logs` pay for it; the six that ask for `checks` for the badge
   * alone do not. Null where the read failed or nothing failing has a log.
   */
  report: CheckReport | null;
  notes: ReviewNote[];
  files: CardFile[];
  comments: CardComment[];
  media: CardMedia[];
  live: CardLive[];
  body: string;
  /**
   * The issue behind this card, as the facts that decide it.
   *
   * This slot used to be `labels: string[]` - declared, defaulted, never assigned by
   * `readArtifacts` and never read by a component. The card about one issue asked for `body`
   * and got prose and nothing else: no area label, no age, no comment count, no sign that
   * somebody already had it, all four of which the *browsing* card shows for thirty issues at
   * once. Same shape as a pool row, so IssueMarks draws either.
   */
  issue: PoolIssue | null;
  pool: PoolIssue[];
  reviewers: Reviewers | null;
  commits: CardCommit[];
  agent: AgentTurn | null;
  advisory: AdvisoryFacts | null;
  bump: BumpFacts | null;
  bumps: BumpRow[];
}

export const NO_ARTIFACTS: CardArtifacts = {
  stat:   null,
  ci:     null,
  checks: [],
  report: null,
  notes:  [],
  files:  [],
  comments: [],
  media:  [],
  live:   [],
  body:   '',
  issue:  null,
  pool:   [],
  reviewers: null,
  commits: [],
  agent:  null,
  advisory: null,
  bump:   null,
  bumps:  [],
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
 * CI: the counts, and the few names worth reading.
 *
 * **These used to come back as one list, and the card counted the list.** The names are capped at
 * six - a passing check has nothing to say and twenty of them said at length is how a card stops
 * being read - and there were two synthetic rows on the end, `{n} still running` and `{n}
 * passed`, so `checks.length` was 7 on a pull request with 46 checks and
 * `checks.filter(passed).length` was 1 on one where 40 passed. The card's 36px lede and its badge
 * row both read those, and both were wrong on every card with a build. So the counts leave here
 * as counts, in their own shape, and the list is only ever the failures by name.
 *
 * `withLog` is the second artifact: what one of them printed. See `CardArtifacts.report` for why
 * it is one and why it is opt-in.
 */
async function ciOf(pr: number, detail: Json, withLog = false): Promise<{ ci: CardCi | null; checks: CardCheck[]; report: CheckReport | null }> {
  const meta = detail?.meta?.ci;

  if (!meta || !meta.total) {
    return { ci: null, checks: [], report: null };
  }
  const ci: CardCi = {
    total:   meta.total || 0,
    failing: meta.failing || 0,
    pending: meta.pending || 0,
    passed:  Math.max(0, (meta.total || 0) - (meta.failing || 0) - (meta.pending || 0)),
  };
  const checks: CardCheck[] = [];
  let report: CheckReport | null = null;

  if (ci.failing) {
    const failures = await ciFailures(pr).catch(() => null);
    const raw: Json[] = (failures?.checks || []).slice(0, 6);

    for (const check of raw) {
      checks.push({
        // Only a check *run* has output to go and read; a status context's id is a status id and
        // would 404 against /check-runs. See `CardCheck.id`.
        id:     check.kind === 'check' ? Number(check.id) || 0 : 0,
        name:   check.name || 'check',
        state:  'failed',
        detail: String(check.title || check.summary || '').split('\n')[0].slice(0, 120),
        url:    check.url || meta.failingUrl || '',
      });
    }
    // One row carrying the count, where the detail call came back with nothing: the badge opens
    // onto a list, and an empty list under a red badge reads as a card that lost the answer.
    if (!checks.length) {
      checks.push({
        id: 0, name: `${ ci.failing } failing`, state: 'failed', detail: '', url: meta.failingUrl || '',
      });
    }

    /*
     * The one worth reading, of up to six.
     *
     * A job with a log first, because that is the only kind with a failure to show: on this
     * repository's red pull requests the six failures are three or four `e2e-test (...)` jobs
     * plus `Description` and `validate`, and the last two are status contexts that kept nothing.
     * Picking the list's first row regardless would have drawn the card's whole surface off
     * `Description`, which is a bot saying the description is too short.
     */
    if (withLog) {
      const pick = raw.find((c) => c.kind === 'check' && c.jobId) || raw.find((c) => c.kind === 'check');

      if (pick?.id) {
        report = await ciFailureDetail(pr, Number(pick.id)).then(checkReportFrom).catch(() => null);
      }
    }
  }

  return { ci, checks, report };
}

/**
 * One `/ci/{id}` reply as a `CheckReport`.
 *
 * Exported because two callers map it and they must map it the same way: this file reads the one
 * report a card arrives with, and `CheckList` reads the others when somebody presses for them.
 * Every field is defaulted rather than trusted - the dev-api runs from a ConfigMap and can be a
 * version behind the extension, in which case `at`, `hits` and `lines` are simply absent and the
 * card draws the excerpt without marks instead of drawing nothing.
 */
export function checkReportFrom(data: Json): CheckReport | null {
  const check = data?.check;

  if (!check) {
    return null;
  }
  const log = data.log || {};

  return {
    id:          Number(check.id) || 0,
    name:        String(check.name || ''),
    url:         String(check.url || ''),
    title:       String(check.title || ''),
    summary:     String(check.summary || ''),
    // Eight. They are two lines each and the pane they sit above is the point of the card; a
    // check with fifty annotations is a lint run, and the eight at the top are the failures.
    annotations: (Array.isArray(data.annotations) ? data.annotations : []).slice(0, 8).map((a: Json) => ({
      path:    String(a.path || ''),
      line:    Number(a.line) || 0,
      endLine: Number(a.endLine) || 0,
      level:   String(a.level || ''),
      message: String(a.message || ''),
      title:   String(a.title || ''),
    })),
    text:    String(log.text || ''),
    hits:    (Array.isArray(log.hits) ? log.hits : []).map(Number).filter((n: number) => n > 0),
    at:      Number(log.at) || 1,
    lines:   Number(log.lines) || 0,
    matched: Boolean(log.matched),
    jobId:   Number(log.jobId) || 0,
  };
}

/**
 * What a file is, from what the API said and what it is called.
 *
 * The name decides when the type is unhelpful, which it often is: the media listing types a
 * `.md` as `text/markdown` but an unknown extension as nothing at all, and "nothing at all" used
 * to fall through to `image`. Images are the default still - that is what most of this directory
 * is - but only after text has had its say.
 */
const TEXT_NAME = /\.(md|markdown|txt|log|json|ya?ml|diff|patch|csv|tsv|html?|xml|ts|js|mjs|cjs|vue|css|sh|py|go|sql|ini|conf|toml)$/i;

const MEDIA_KIND = (type: string, name: string): 'image' | 'video' | 'text' => {
  if (/video/.test(type || '') || /\.(webm|mp4|mov)$/i.test(name)) {
    return 'video';
  }
  if (/^text\/|json|yaml|xml|markdown/.test(type || '') || TEXT_NAME.test(name)) {
    return 'text';
  }

  return 'image';
};

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

/**
 * The pool, read from the same search the queue counted - all of it.
 *
 * `myWork` already fetched it, so this takes what the page has rather than asking GitHub again -
 * which is why `readArtifacts` is handed the work it was built from.
 *
 * **It used to `slice(0, 30)`.** The rule's title counts the search (`100 open issues nobody has
 * taken`) and the card's lede and section head counted this, so one card said 100 at the top, 30
 * at 36px 150px below it, and `30 open` under that: two different counts of one set in one glance,
 * and the 36px one was a sample size dressed as a quantity. The list scrolls; thirty rows and a
 * hundred rows cost the same to draw, and the honest number is free.
 */
function poolFrom(issues: Json[]): PoolIssue[] {
  const now = Date.now();

  return (issues || []).map((issue) => ({
    number:   issue.number,
    title:    issue.title,
    url:      issue.url,
    repo:     issue.repo,
    labels:   issue.labels || [],
    comments: issue.comments ?? 0,
    age:      Math.max(0, Math.round((now - Date.parse(issue.createdAt || '')) / 86_400_000)) || 0,
    // The pool is the unassigned search, so this is always empty here; it is a fact the shape
    // carries for the card about one issue, which can be assigned to somebody.
    assignee: '',
  }));
}

/**
 * What an issue's labels say, minus the noise.
 *
 * This repository labels nearly everything `kind/bug` and `area/...`; the area is the useful
 * half and the prefix is not. It lived in CardPool as a local arrow function, and then the card
 * about a single issue needed the same four labels cleaned the same way - so it is here, beside
 * the shape it cleans, rather than copied into a second component.
 */
export function issueTags(issue: PoolIssue): string[] {
  return (issue.labels || [])
    .filter((label) => !/^status\/|^priority\//.test(label))
    .map((label) => label.replace(/^(kind|area|team)\//, ''))
    .slice(0, 4);
}

/**
 * Who has been asked, who has answered, and who would be the obvious person to ask.
 *
 * **The suggestions used to be impossible on the one card that needs them.** They were built from
 * the authors of `detail.reviewComments` - and the card asking for them is `mine-unasked`, whose
 * whole definition is that nobody has been asked and nobody is looking, so there are no review
 * comments by definition. Measured on both live cards of this rule: `suggested` empty, so the one
 * surface the card has degraded to a sentence telling you to go and pick a reviewer on GitHub, and
 * the wired-up one-press `requestReviewers` was unreachable on its own kind of work.
 *
 * So four sources, best first, every one of them already in hand - three off the `prDetail`
 * response the stat and the checks come from, and one off the queue's own copy of my open pull
 * requests. Whoever has said anything on it knows the change without being briefed; whoever has
 * reviewed it before knows it too; and failing both, the people I have asked on my other open pull
 * requests are the people I ask, which is the answer on exactly the card where the first three are
 * empty by definition. Each carries why it thinks so, because a bare handle is a reviewer picker
 * and that is the thing this card exists instead of.
 *
 * Not `detail.commits[].author`, which was the obvious fourth: the dev API maps it from
 * `commit.author.name`, so it is a git display name - "Cody Jackson" - and `requestReviewers`
 * wants a login. A candidate the one-press Ask cannot ask is the bug this function was fixing.
 */
function reviewersOf(pr: number, detail: Json, work: Json, me: string): Reviewers {
  // Who has been asked comes off the queue's own copy of the pull request, not off `prDetail`:
  // the dev API's `meta` has `approvedBy` but no review requests, and `myWork` already asked
  // GitHub for them. Adding a call to find out what is in hand would be the wrong trade.
  const found = [...(work?.mine || []), ...(work?.reviewing || [])].find((entry: Json) => entry.number === pr);
  const asked: string[] = found?.reviewers || [];
  const approved: string[] = detail?.meta?.approvedBy || [];
  const seen = new Set([...asked, ...approved]);

  // Typed on the way in: `detail` is `any`, so a list built straight off it is `unknown[]` and
  // nothing can be asked about its members.
  const named = (rows: Json[], why: string): Candidate[] => (rows || [])
    .map((row: Json) => ({ who: String(row?.author || ''), why }));

  // Who I have asked on my other open pull requests, newest first. `work.mine` is the queue's own
  // copy, so this is free, and on the card this function exists for it is the only source that can
  // have anything in it.
  const elsewhere: Candidate[] = (work?.mine || [])
    .filter((entry: Json) => Number(entry?.number) !== pr && (entry?.reviewers || []).length)
    .flatMap((entry: Json) => (entry.reviewers || [])
      .map((who: Json) => ({ who: String(who || ''), why: `you asked them on #${ entry.number }` })));

  const suggested: Candidate[] = [
    ...named(detail?.reviewComments, 'already commented on the diff'),
    ...named(detail?.discussion, 'already commented on it'),
    ...named(detail?.reviews, 'has reviewed it before'),
    ...elsewhere,
  ]
    .filter((row) => row.who && row.who !== me && !seen.has(row.who))
    // First reason wins: the sources are in order of how well it knows the change, and the same
    // person showing up twice would otherwise read as two candidates.
    .filter((row, n, all) => all.findIndex((other) => other.who === row.who) === n)
    /*
     * Five, not three. This list is the whole of its card's surface - the question the card asks
     * is "who do I ask" - and the surface is 173px now, which is three 44px rows and most of a
     * fourth. Three candidates in a box that holds four is a list that cannot be scrolled and a
     * row of empty space under it.
     */
    .slice(0, 5);

  return { asked, approved, suggested };
}

/**
 * What the agent in a workspace is asking, or last said.
 *
 * The pane first, because a dialog is answerable and a report is not: `readPane` recognises the
 * four shapes claude's own UI uses - a numbered list, a yes/no, a login, a bare prompt - and the
 * numbered list is the case that matters here. Then the last report, for a stop with no question
 * in it, which is what a stalled workspace always is.
 *
 * Reads the busiest conversation rather than all of them: a workspace with four has one that
 * stopped, and the others are not what the card is about.
 */
async function agentTurnOf(workspace: string): Promise<AgentTurn | null> {
  if (!workspace) {
    return null;
  }
  const sessions = await listConversations(workspace).catch(() => []);

  if (!sessions.length) {
    return null;
  }

  // Newest first: the one that stopped is the one last written to.
  for (const session of [...sessions].reverse().slice(0, 3)) {
    const pane = await conversationPane(workspace, session.id, 40).catch(() => null);

    if (!pane?.text) {
      continue;
    }
    const seen = readPane(pane.text);
    const tail = pane.text.split('\n').filter((line) => line.trim()).slice(-6).join('\n');

    if (seen.dialog) {
      return {
        conversation: session.id,
        question:     seen.dialog.prompt,
        options:      seen.dialog.options,
        wants:        seen.dialog.kind,
        said:         '',
        status:       seen.status,
        tail,
        title:        session.title || '',
        reachable:    true,
      };
    }

    // No dialog: its last report, which is what a skill ends with.
    const report = await latestAgentReport(workspace).catch(() => null);

    return {
      conversation: report?.conversation || session.id,
      question:     '',
      options:      [],
      wants:        seen.idle ? 'text' : '',
      said:         report?.text || '',
      status:       seen.status,
      tail,
      title:        session.title || '',
      reachable:    true,
    };
  }

  /*
   * Its conversations exist and not one of their panes could be read.
   *
   * A degraded turn rather than null: the name of the busiest conversation and the admission
   * that the pane is unreadable beats an empty card on the highest-priority item in the queue.
   * See `reachable`, which is what CardAgent words differently.
   */
  const busiest = sessions[sessions.length - 1];

  return {
    conversation: busiest.id,
    question:     '',
    options:      [],
    wants:        '',
    said:         '',
    status:       '',
    tail:         '',
    title:        busiest.title || '',
    reachable:    false,
  };
}

/**
 * The branch's own commits, for work that has no pull request.
 *
 * The card this is for exists precisely because there is no pull request yet - and every other
 * artifact on it comes off `prDetail`, which needs one. So `commits` resolved to nothing on the
 * one card whose whole subject is what is on the branch, and it drew an empty body. Measured
 * rather than reasoned about: the sweep reported `surf=none commits=0` on it.
 *
 * Read from the checkout, over the merge base, which is what the rail's own branch panel does.
 */
async function branchCommits(workspace: string): Promise<CardCommit[]> {
  if (!workspace) {
    return [];
  }
  const out = await readInWorkspace(workspace, [
    'cd $WS/dashboard 2>/dev/null || { echo "@@NOREPO"; exit 0; }',
    'base=$(git merge-base upstream/master HEAD 2>/dev/null || git merge-base origin/master HEAD 2>/dev/null || git rev-parse HEAD)',
    'git log --format="%h%x09%s%x09%an%x09%aI" "$base"..HEAD 2>/dev/null | head -20',
  ].join('\n')).catch(() => '');

  if (!out || out.includes('@@NOREPO')) {
    return [];
  }

  return out.split('\n').filter(Boolean).map((line) => {
    const [sha, message, author, at] = line.split('\t');

    return {
      sha: sha || '', message: message || '', author: author || '', at: at || '',
    };
  }).filter((commit) => commit.sha);
}

/**
 * The branch's own diff, for work that has no pull request - and how big it is.
 *
 * The card this is for asks for `files`, `stat` and `media`, and every one of those came off
 * `prDetail`: its rule is `fix-no-pr`, so by construction there is no pull request, `needsPr`
 * is false and all three resolved to nothing. What was left was commit subject lines - and the
 * card's primary button publishes the branch to GitHub. You were being asked to open a pull
 * request having seen nothing but the commit messages.
 *
 * Same mechanism as `branchCommits`, one command further: `git diff` over the merge base feeds
 * the same `patchHunks` the pull-request path uses, so ChangeSet draws a local branch exactly
 * as it draws a remote one, and `--numstat` gives the three numbers the band wants.
 *
 * Capped at forty files and at a diff a card can hold. A branch that changed four hundred files
 * is not going to be read on a card, and the cost of reading it is paid on every turn of the
 * deck onto this one.
 */
async function branchDiff(workspace: string): Promise<{ files: CardFile[]; stat: CardStat | null }> {
  const none = { files: [], stat: null };

  if (!workspace) {
    return none;
  }
  const out = await readInWorkspace(workspace, [
    'cd $WS/dashboard 2>/dev/null || { echo "@@NOREPO"; exit 0; }',
    'base=$(git merge-base upstream/master HEAD 2>/dev/null || git merge-base origin/master HEAD 2>/dev/null || git rev-parse HEAD)',
    'echo "@@NUMSTAT"',
    'git diff --numstat "$base"..HEAD 2>/dev/null | head -200',
    'echo "@@PATCH"',
    'git diff --no-color --unified=3 "$base"..HEAD 2>/dev/null | head -6000',
  ].join('\n')).catch(() => '');

  if (!out || out.includes('@@NOREPO') || !out.includes('@@PATCH')) {
    return none;
  }
  const [counts, patch] = out.slice(out.indexOf('@@NUMSTAT') + 9).split('@@PATCH');

  // `added<TAB>removed<TAB>path`, with '-' for a binary file.
  const sizes = new Map<string, { added: number; removed: number }>();
  let added = 0;
  let removed = 0;

  for (const line of String(counts || '').split('\n')) {
    const [plus, minus, path] = line.trim().split('\t');

    if (!path) {
      continue;
    }
    const size = { added: Number(plus) || 0, removed: Number(minus) || 0 };

    sizes.set(path, size);
    added += size.added;
    removed += size.removed;
  }

  // One patch per `diff --git` header, which is how git separates them.
  const files: CardFile[] = [];

  for (const chunk of String(patch || '').split(/^diff --git /m).slice(1)) {
    const path = /^a\/(\S+) b\/(\S+)/.exec(chunk)?.[2] || '';
    const hunks = patchHunks(chunk);

    if (!path || !hunks.length) {
      continue;
    }
    const size = sizes.get(path) || { added: 0, removed: 0 };

    files.push({
      path,
      status: /^new file mode/m.test(chunk) ? 'added' : /^deleted file mode/m.test(chunk) ? 'removed' : 'modified',
      added:  size.added,
      removed: size.removed,
      hunks,
    });
    if (files.length >= 40) {
      break;
    }
  }

  return { files, stat: sizes.size ? { files: sizes.size, added, removed } : null };
}

/**
 * The advisory behind an alert card, out of what the queue was built from.
 *
 * Matched on the queue's own key rather than on words parsed back out of the title. It read the
 * slug out of `Advisory GHSA-xxxx` and then looked for a row whose `slug` was that - but the
 * rows' `slug` is the *package* slug and the title carries the GHSA id (priority.ts prefers
 * `ghsaId` when building it), and the field it tried for the id was called `ghsa` while dev-api
 * calls it `ghsaId`. So nothing ever matched: `wants: ['advisory']` resolved to null, the surface
 * never became 'facts', and all three live advisory cards drew a title over 126px of nothing -
 * with `Take the patch` offered under it. The severity band, the affected range, the patched
 * version and the summary are the facts that decision is made on.
 *
 * The key is `alert:<slug or ghsaId>` (see fromAlerts), which is exactly one of the two fields
 * a row can be found by, so there is nothing to parse.
 */
function advisoryFrom(task: { key?: string; what: string }, alerts: Json[]): AdvisoryFacts | null {
  const key = String(task.key || '').replace(/^alert:/, '')
    || /Advisory\s+(\S+)/i.exec(task.what)?.[1]
    || '';
  const found = (alerts || []).find((row: Json) => [row.slug, row.ghsaId, row.ghsa, row.key].includes(key));

  if (!found) {
    return null;
  }

  /*
   * The field names are dev-api's grouped ones (`fetchDependabot`): `patchedVersion` on the
   * group, `alerts` as the array of the raised alerts, `description` as the advisory's own prose
   * - the group's `title` *is* its summary, and the card already uses that as its title, so
   * repeating it here would have been the only thing in the body. `vulnerableRange` is read
   * where dev-api carries it and is simply absent otherwise; CardFacts draws the rows it has.
   */
  return {
    severity: String(found.severity || '').toLowerCase(),
    packages: found.packages || [],
    affected: String(found.vulnerableRange || found.alerts?.[0]?.vulnerableRange || found.affected || ''),
    patched:  String(found.patchedVersion || found.firstPatchedVersion || found.patched || ''),
    alerts:   Number(found.count || found.alerts?.length || 0),
    summary:  String(found.description || found.summary || '').slice(0, 600),
  };
}

/**
 * Every unreviewed bump, as the rows of the one card that holds them all.
 *
 * Sorted green first and then oldest first: the green ones are the four seconds of work this card
 * exists for, and among the rest the one that has sat longest is the one to look at.
 */
function bumpsFrom(botPrs: Json[], reviews: Json): BumpRow[] {
  const state = (pr: Json): BumpRow['state'] => {
    if (pr.ci?.failing) {
      return 'failing';
    }

    return !pr.ci || pr.ci.pending ? 'pending' : 'green';
  };

  return (botPrs || [])
    .filter((pr: Json) => !reviews?.[pr.number])
    .map((pr: Json) => ({
      number:  Number(pr.number),
      package: String(pr.packageName || pr.title || ''),
      from:    String(pr.fromVersion || ''),
      to:      String(pr.toVersion || ''),
      url:     String(pr.url || ''),
      state:   state(pr),
      // The same one-liner `bumpFrom` uses for the single-bump card, on the rows of the card that
      // merges a pile of them without reading any.
      major:   Boolean(pr.fromVersion && pr.toVersion
        && String(pr.fromVersion).split('.')[0] !== String(pr.toVersion).split('.')[0]),
      failing: Number(pr.ci?.failing || 0),
      age:     Math.max(0, Math.round((Date.now() - Date.parse(pr.updatedAt || '')) / 86_400_000)) || 0,
    }))
    // The same dedupe the queue does, for the same reason: the bot leaves its replacements open.
    .filter((row, n, all) => all.findIndex((other) => other.package === row.package
      && other.from === row.from
      && other.to === row.to) === n)
    .sort((a, b) => (a.state === 'green' ? 0 : 1) - (b.state === 'green' ? 0 : 1) || b.age - a.age);
}

/**
 * The description, as long as a description gets.
 *
 * It was `.slice(0, 2400)`, and the card printed `prose.length / 1000` beside the control that
 * opens it - so every long description read exactly "2.4k", which is the cap and not the size of
 * anything, and the modal it opened held 2201-2212 characters ending mid-sentence: "Cluster detail
 * → Machine P", "(unlikely,", "writes the file to". Nothing on the card or in the modal said
 * anything had been cut, so you read the author's description, believed you had read it, and
 * pressed "Start a review workspace".
 *
 * `detail.meta.body` is in hand uncut and TextModal scrolls, so the only reason for a cap at all
 * is that a pull request body can be a 200KB generated table and this renders markdown into the
 * card. 40,000 characters is past every real description and short of that; the card no longer
 * prints a number, because the honest number was never the one it had.
 */
const BODY_CAP = 40_000;

const capBody = (body: unknown): string => String(body || '').slice(0, BODY_CAP);

/** The version change behind a bump card: the one fact that decides it. */
function bumpFrom(pr: number, botPrs: Json[]): BumpFacts | null {
  const found = (botPrs || []).find((row: Json) => Number(row.number) === pr);

  if (!found) {
    return null;
  }
  const from = String(found.fromVersion || '');
  const to = String(found.toVersion || '');

  return {
    package:   String(found.packageName || ''),
    ecosystem: String(found.ecosystem || ''),
    from,
    to,
    // A major jump is the whole question on a bump; everything else is usually a formality.
    major:     Boolean(from && to && from.split('.')[0] !== to.split('.')[0]),
  };
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

/**
 * The card, written out so a conversation can be told what it is about.
 *
 * The bar is one conversation across the whole deck, so a question typed into it arrives with
 * no idea which card was on screen when it was asked - and "why did this fail?" about nothing
 * in particular is a question the agent has to guess the subject of. This is that subject, as
 * the few lines somebody would have typed themselves: what kind of card, which thing it is
 * about, and where to look.
 *
 * Deliberately short. It goes at the top of a message a person is still writing, so it has to
 * be readable in the composer and cheap to delete half of - not a dump of everything the card
 * loaded. The identifiers are the valuable part: with the repository, the number and the
 * workspace, the agent can read the rest for itself.
 */
export function cardContext(task: {
  what: string; workspace: string; rule: string; title?: string;
  needs?: string; about?: string; url?: string; card?: { label?: string; chip?: string };
}): string {
  const subject = subjectOf(task);
  const lines: string[] = [];
  const kind = task.card?.label || task.card?.chip || '';

  lines.push(`Card: ${ kind || task.rule }${ kind ? ` (${ task.rule })` : '' }`);
  if (task.title) {
    lines.push(`Title: ${ task.title }`);
  }
  if (subject.pr) {
    lines.push(`Pull request: ${ DEFAULT_REPO }#${ subject.pr }`);
  }
  if (subject.issue) {
    lines.push(`Issue: ${ DEFAULT_REPO }#${ subject.issue }`);
  }
  if (subject.workspace) {
    lines.push(`Workspace: ${ subject.workspace }`);
  }
  if (task.needs) {
    lines.push(`What it needs: ${ task.needs }`);
  }
  if (task.about) {
    lines.push(`Why it is here: ${ task.about }`);
  }
  if (task.url) {
    lines.push(`Link: ${ task.url }`);
  }

  return `About the card I am looking at:\n${ lines.map((line) => `- ${ line }`).join('\n') }\n\n`;
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
/**
 * What has already been read, by task key, for as long as the tab lives.
 *
 * It was a `Map` declared inside Focus.vue's `setup`, which means it was rebuilt on every mount -
 * and the URL restores which card you were on, so leaving the deck and coming back read the same
 * pull request again and showed the spinner again. Most visits to this page are return visits.
 *
 * Here rather than in the page for exactly that reason: a module outlives a component. Not in
 * storage, though - these hold whole diffs and comment bodies, and a diff read yesterday is not
 * something to draw today without asking.
 *
 * Bounded, oldest out first. The number is small on purpose: the value is in the neighbours you
 * are about to reach and the card you just left, not in remembering the whole deck.
 */
const seen = new Map<string, CardArtifacts>();
const SEEN_MAX = 12;

/** What was read for this key, if it still is. */
export function keptArtifacts(key: string): CardArtifacts | undefined {
  return seen.get(key);
}

/** Whether this key has been read, without handing back what was read. */
export function haveArtifacts(key: string): boolean {
  return seen.has(key);
}

/** Remember what was read for a key, forgetting the oldest to stay bounded. */
export function keepArtifacts(key: string, found: CardArtifacts): void {
  seen.set(key, found);
  while (seen.size > SEEN_MAX) {
    seen.delete(seen.keys().next().value as string);
  }
}

/** The keys held, for the probe the page exposes. */
export function keptKeys(): string[] {
  return [...seen.keys()];
}

/** The states that mean a conversation has stopped and the work is a person's again. */
const SETTLED_STATES = new Set(['input', 'idle', 'finished', 'gone']);

/** The stopped conversation in this workspace as the `conversation` artifact, or null. */
export function turnFromSnapshot(agents: ConversationSnapshot | null, workspace: string): AgentTurn | null {
  const found = Object.values(agents?.conversations || {})
    .filter((c) => c.workspace === workspace && SETTLED_STATES.has(c.state) && c.state !== 'gone')
    .sort((a, b) => String(b.changedAt).localeCompare(String(a.changedAt)))[0];

  if (!found || (!found.said && !found.question)) {
    return null;
  }

  return {
    conversation: found.id,
    question:     found.question?.header || found.message || '',
    options:      (found.question?.options || []).map((label, i) => ({ key: String(i), label, selected: false })),
    wants:        found.question ? (found.question.tool === 'ExitPlanMode' ? 'plan' : 'choice') : (found.state === 'finished' ? '' : 'text'),
    said:         found.said,
    status:       '',
    tail:         '',
    title:        '',
    reachable:    true,
  };
}

export async function readArtifacts(
  task: { key?: string; what: string; workspace: string; rule: string },
  wants: Artifact[],
  store: Store,
  me = '',
  /** What the queue was built from, for the artifacts that are already in it. See poolFrom. */
  work: Json = null,
  /** The other two things the queue was built from: the advisories and the bot's pull requests. */
  extra: { alerts?: Json[]; botPrs?: Json[]; botReviews?: Json; agents?: ConversationSnapshot | null } | null = null,
): Promise<CardArtifacts> {
  const want = new Set(wants || []);
  const subject = subjectOf(task);
  const out: CardArtifacts = { ...NO_ARTIFACTS };
  /*
   * Who the reader is *on GitHub*.
   *
   * `me` is `currentOwner()`, which is this Rancher's principal id put through `sanitiseOwner` -
   * so every comparison against a GitHub login in here was against the wrong name. Measured: the
   * start-fix cards drew "codyrancher has it" in `--warning` on every one of them, because the
   * filter that is supposed to take the reader out of the assignee list never matched; and
   * `comment.mine` was false on every comment the reader had written. `myWork` asks
   * `viewer { login }` in the same query the queue is built from and returns it, and `work` is
   * that payload - so the right name was already on the call.
   */
  const viewer = String(work?.login || me || '');

  if (!want.size) {
    return out;
  }

  /*
   * One read of the pull request behind everything that comes off it, started but not waited for.
   *
   * `prDetail` keeps its answer for a few seconds, and the point of one read is that the artifacts
   * which come off it share an await rather than racing four of them through the same cache. But
   * this was awaited *here*, so every branch below started at `t=prDetail` - including the eight
   * that never look at it. A card wanting `media` or `conversation` or an `advisory` waited on a
   * GitHub round trip for a pull request it does not read.
   *
   * So the read starts here and each branch awaits it only if it needs it. The ones that do are no
   * slower; the ones that do not now start at once.
   */
  /*
   * The queue's own entry for this pull request, which already holds some of what is wanted.
   *
   * `stat` is the clear case: the three numbers on the fact strip come back with the search that
   * built the deck, so a card asking for them was reading a whole pull request for integers it had
   * already been told. Where that is the *only* detail a card wants - a `bump` card, say - there is
   * now nothing to read at all, which is why this is settled before `needsPr`.
   */
  const entry: Json = subject.pr ? [...(work?.mine || []), ...(work?.reviewing || [])].find((e: Json) => e.number === subject.pr) : null;
  const statFromQueue = (entry?.stat || null) as CardStat | null;

  const DETAIL_KINDS: Artifact[] = ['stat', 'checks', 'logs', 'files', 'comments', 'body', 'reviewers', 'commits'];
  const needsPr = subject.pr && DETAIL_KINDS.some((kind) => want.has(kind) && !(kind === 'stat' && statFromQueue));
  const detailSoon: Promise<Json | null> = needsPr ? prDetail(subject.pr).catch(() => null) : Promise.resolve(null);

  await Promise.all([
    (async() => {
      if (!want.has('stat')) {
        return;
      }

      // What the search already answered, or the pull request where it had no entry for it.
      if (statFromQueue) {
        out.stat = statFromQueue;

        return;
      }

      const detail = await detailSoon;

      if (detail) {
        out.stat = statOf(detail);
      }
    })(),

    (async() => {
      const detail = await detailSoon;

      /*
       * `logs` on its own is enough to ask: a card that wants the failing output wants the names
       * and the counts it is placed among, and the one call behind all three is the same.
       */
      if ((want.has('checks') || want.has('logs')) && detail && subject.pr) {
        const found = await ciOf(subject.pr, detail, want.has('logs')).catch(() => ({ ci: null, checks: [], report: null }));

        out.ci = found.ci;
        out.checks = found.checks;
        out.report = found.report;
      }
    })(),

    /*
     * No `notes` read here.
     *
     * This called `reviewNotes(subject.pr)` and wrote `out.notes`, and nothing has ever read that
     * field - the notes a card draws arrive as a prop from the page's own `readNotes`, which calls
     * the same function. So it was a second fetch of the same comments, on the review-pass card
     * that is usually the first one in the deck, for a field with no readers. The field stays on
     * `CardArtifacts` as the empty array it already is for every other kind of card, so a card in
     * a ConfigMap that names it still finds it.
     */

    (async() => {
      const detail = await detailSoon;

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
      const detail = await detailSoon;

      if (want.has('comments') && detail && subject.pr) {
        out.comments = commentsOf(subject.pr, detail, viewer);
      }
    })(),

    /*
     * The change, when there is no pull request to read it off.
     *
     * One read for both artifacts rather than two: `files` and `stat` come out of the same
     * `git diff`, and the card that needs this - the one offering to publish a branch - asks
     * for both. Without it that card showed commit subject lines and nothing else, and its
     * primary button creates a pull request on GitHub. See `branchDiff`.
     */
    (async() => {
      const detail = await detailSoon;

      if (detail || !subject.workspace || !(want.has('files') || want.has('stat'))) {
        return;
      }
      const local = await branchDiff(subject.workspace).catch(() => ({ files: [] as CardFile[], stat: null }));

      if (want.has('files')) {
        out.files = local.files;
      }
      if (want.has('stat')) {
        out.stat = local.stat;
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
      if (want.has('pool')) {
        out.pool = poolFrom(work?.unassigned || []);
      }
    })(),

    (async() => {
      if (want.has('conversation')) {
        /*
         * The watcher's own read first.
         *
         * `agentTurnOf` is up to five execs - a conversation listing, three pane reads and a `node
         * -e` over a transcript - and the deck prefetches the two cards either side of the one on
         * screen, so one deck move was up to fifteen. When a conversation has stopped, dev-api has
         * already read its last word and its pending question off the mount, for nothing, so this
         * is the same answer for no execs at all.
         *
         * What is lost is `status` and `tail`, both of which come from the pane's own text.
         * `status` is the spinner's verb and is '' for a conversation that has stopped - which
         * every one of these is - so nothing is lost there. `tail` is the pane's last six lines,
         * against `said`, the last thing claude wrote in the transcript: for a crash those differ,
         * which is what the `finished` wording is for.
         */
        out.agent = turnFromSnapshot(extra?.agents || null, subject.workspace) ||
          await agentTurnOf(subject.workspace).catch(() => null);
      }
    })(),

    (async() => {
      if (want.has('advisory')) {
        out.advisory = advisoryFrom(task, extra?.alerts || []);
      }
    })(),

    (async() => {
      if (want.has('bump') && subject.pr) {
        out.bump = bumpFrom(subject.pr, extra?.botPrs || []);
      }
    })(),

    (async() => {
      if (want.has('bumps')) {
        out.bumps = bumpsFrom(extra?.botPrs || [], extra?.botReviews || null);
      }
    })(),

    (async() => {
      const detail = await detailSoon;

      if (want.has('reviewers') && detail && subject.pr) {
        out.reviewers = reviewersOf(subject.pr, detail, work, viewer);
      }
    })(),

    (async() => {
      const detail = await detailSoon;

      if (!want.has('commits')) {
        return;
      }
      if (detail) {
        out.commits = (detail.commits || []).slice(-12).map((commit: Json) => ({
          sha: String(commit.sha || '').slice(0, 7), message: commit.message || '', author: commit.author || '', at: commit.date || '',
        }));
      } else {
        // No pull request to read them from, which is the whole point of the card asking.
        out.commits = await branchCommits(subject.workspace).catch(() => []);
      }
    })(),

    (async() => {
      const detail = await detailSoon;

      if (!want.has('body')) {
        return;
      }
      if (subject.issue) {
        const issue = await issueBody(DEFAULT_REPO, subject.issue).catch(() => null);

        out.body = capBody(issue?.body);
        if (issue) {
          // The same four facts the pool shows, for the card that asks you to commit a
          // workspace to this one issue. Same shape, so IssueMarks draws either.
          // Everybody but the reader. See `assignee` on PoolIssue for what the reader being in
          // there cost: a warning-coloured "codyrancher has it" on every card of this kind.
          const whoElse = issue.assignees.filter((who) => who.toLowerCase() !== viewer.toLowerCase());

          out.issue = {
            number:   subject.issue,
            title:    issue.title,
            url:      issue.url,
            repo:     DEFAULT_REPO,
            labels:   issue.labels,
            comments: issue.comments,
            age:      Math.max(0, Math.round((Date.now() - Date.parse(issue.createdAt || '')) / 86_400_000)) || 0,
            assignee: whoElse.join(', '),
            mine:     issue.assignees.length !== whoElse.length,
          };
          /*
           * An issue's comments, which is where its evidence usually is.
           *
           * #13888's body is "There is clearly a margin error. Check the screenshot." and the
           * screenshot is in a comment. They come out of the same query as the body - no extra
           * round trip - and only the card that asked for them gets them.
           */
          if (want.has('comments')) {
            out.comments = issue.comments_list.map((comment, n) => ({
              id:      n + 1,
              author:  comment.author,
              mine:    comment.author.toLowerCase() === viewer.toLowerCase(),
              pending: false,
              body:    comment.body,
              path:    '',
              line:    null,
              at:      comment.at,
              media:   [],
              hunk:    [],
            }));
          }
        }
      } else if (detail) {
        out.body = capBody(detail.meta?.body);
      }
    })(),
  ]);

  return out;
}
