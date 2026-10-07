// What each workspace needs from the person, and what its agent is doing: the sidebar's
// second line, and the card under the pointer.
//
// Two sources, kept apart because they cost differently. The agents' states come from the
// agent pod in one exec (conversationStates), every fifteen seconds. The work's state comes
// from GitHub - the PR a review is about, the PR an issue's fix opened - which is several
// calls per workspace, so each workspace is read every five minutes, one at a time, in the
// background; the sidebar shows whatever was last read and never waits on it.
import { prDetail, DEFAULT_REPO } from './reviews';
import { linkedPullRequest, branchPullRequest, issueBody } from './github';
import { conversationStates, ConversationState } from './conversations';
import { setWorkspaceRunning } from './api';
import { isLte } from './config/constants';
import { reconcileStage } from './stages';
import type { DerivedStage, StageRecord } from './stages';

// The stage a workspace shows is stored and guarded, not re-guessed each read: see stages.ts. These
// re-exports let the rail and the PR panel set or release a manual stage without knowing where it lives.
export { setManualStage, clearManualStage, isManual } from './stages';

type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any

import { activityState } from './agent';

export type AgentState = 'working' | 'input' | 'idle' | 'finished' | 'none';
export type Tone = 'green' | 'attention' | 'waiting' | 'working' | 'muted';
/** Where the work is, on the rail: a fix's stages, or a review's. */
export type FixStage = 'assess' | 'code' | 'draft' | 'review' | 'feedback' | 'merged';
export type ReviewStage = 'agent' | 'findings' | 'submitted' | 'response' | 'approved';
export type Stage = FixStage | ReviewStage;

/**
 * What each stage is called. One list, so the rail's stepper, the page's headline and the
 * sidebar's second line all name the stage the same way: a workspace that reads "In review"
 * on its rail reads "In review" in the list beside it.
 */
export const STAGE_LABELS: Record<Stage, string> = {
  assess:    'Assess',
  code:      'Code',
  draft:     'Draft PR',
  review:    'In review',
  feedback:  'Feedback',
  merged:    'Merged',
  agent:     'Agent review',
  findings:  'Your pass',
  submitted: 'Submitted',
  response:  'Developer responded',
  approved:  'Approved',
};

/**
 * A work state with its stage's name already on it. `soft` marks a stage taken from the agent's
 * busy/idle state alone rather than a hard GitHub fact - a guess the stored stage must not be undone
 * by (see stages.ts). Everything not soft is backed by the PR, the reviews, or the comments.
 */
type Work = Pick<WorkspaceStatus, 'label' | 'tone' | 'stage'> & { stageLabel?: string; reviewed?: boolean; round?: number; soft?: boolean };

/** What to call the stage a workspace is at: the rail's own word for it. */
export function stageName(status: Pick<WorkspaceStatus, 'stageLabel' | 'stage'>): string {
  // A status read by an older version of this and kept in session storage has the stage but
  // not its name, so the name is worked out again rather than left off for a read's worth.
  return status.stageLabel || (status.stage ? STAGE_LABELS[status.stage] : '');
}

/**
 * The longer form: the stage, then what that stage is waiting on where there is more to say
 * than the stage's own name. The list has room for the stage alone; the card under the
 * pointer has room for this.
 */
export function statusLine(status: Pick<WorkspaceStatus, 'label' | 'stageLabel' | 'stage'>): string {
  const stage = stageName(status);
  const note = status.label || '';

  if (!stage || !note) {
    return stage || note;
  }

  return note.toLowerCase() === stage.toLowerCase() ? stage : `${ stage } · ${ note }`;
}

export interface WorkspaceStatus {
  /** What the agent in the workspace's conversations is doing, the busiest of them. */
  agent: AgentState;
  /** What the work needs, in a few words, and how loudly to say it. */
  label: string;
  tone: Tone;
  /** The PR's or issue's title, for the card. */
  title: string;
  links: { label: string; url: string }[];
  /** Which kind of work this is, its stage, and the PR it is about (0 until there is one). */
  kind: 'fix' | 'review' | 'other';
  stage: Stage | '';
  /** The stage's name, as the rail's stepper writes it. */
  stageLabel: string;
  /**
   * Whether a review of yours has already gone to GitHub. A pass after that is a second (or
   * fifth) round, and the page says so rather than pretending this is the first look.
   */
  reviewed: boolean;
  /**
   * Which time round this is. 1 is the first look; 2 is a pass over what the agent found after
   * the developer answered your first review, and so on. The rail says so on the step, because
   * the same step twice with nothing to tell them apart reads as no progress at all.
   */
  round: number;
  pr: number;
  /**
   * What the PR's checks are doing, once there is a PR to have any: passing, still running, or
   * failing. '' before GitHub has been read, and for work that has no PR yet.
   */
  ci: CiState;
  /** The same in words, with the counts, for the row's hover card and its title. */
  ciNote: string;
  /** When GitHub was last read for it; 0 when it never has been. */
  readAt: number;
}

/** A PR's checks, as one word. */
export type CiState = '' | 'passing' | 'pending' | 'failing';

/**
 * The three colours the checks are said in. Its own scale rather than the row's `Tone`: the
 * row's colour says how much the work wants a person, and a red check is a fact about the PR
 * whatever the work is waiting on.
 */
export type CiTone = 'green' | 'attention' | 'error';

/**
 * The checks on a PR, from what prDetail already read.
 *
 * Failing first, then pending: a run with one failure and six still going needs a person
 * whatever the six turn into, and saying "pending" until they finish is how a red PR sits in a
 * list looking fine all afternoon.
 */
function ciOf(detail: Json): { ci: CiState; ciNote: string } {
  const ci = detail?.meta?.ci;

  if (!ci || !ci.total) {
    return { ci: '', ciNote: '' };
  }
  if (ci.failing) {
    return { ci: 'failing', ciNote: `${ ci.failing } of ${ ci.total } checks failing` };
  }
  if (ci.pending) {
    return { ci: 'pending', ciNote: `${ ci.pending } of ${ ci.total } checks still running` };
  }

  return { ci: 'passing', ciNote: `${ ci.total } checks passing` };
}

/**
 * The stages at which a PR's checks are worth a word in a list: every stage from the draft PR
 * on, which is every stage at which there is a PR being checked. Before that a fix is being
 * assessed or written and there is nothing to check; a review workspace is about somebody
 * else's PR and so has checks from the first moment.
 */
const CI_STAGES: Stage[] = ['draft', 'review', 'feedback', 'merged', 'agent', 'findings', 'submitted', 'response', 'approved'];

/**
 * The CI chip for a row: its word, its colour, and the counts behind it.
 *
 * One definition, so the sidebar and anything else that shows it agree on when it appears and
 * what it says. `null` when there is nothing to say - no PR, no checks, or work that has not
 * reached a PR yet.
 */
export function ciChip(status: Pick<WorkspaceStatus, 'ci' | 'ciNote' | 'stage' | 'pr'>): { label: string; tone: CiTone; title: string } | null {
  if (!status.ci || !status.pr || !CI_STAGES.includes(status.stage as Stage)) {
    return null;
  }

  const tone: CiTone = status.ci === 'failing' ? 'error' : status.ci === 'pending' ? 'attention' : 'green';

  return { label: `CI ${ status.ci }`, tone, title: status.ciNote };
}

const AGENT_LABEL: Record<AgentState, string> = {
  working:  'agent working',
  input:    'agent needs an answer',
  idle:     'agent idle',
  finished: 'agent finished',
  none:     '',
};

/**
 * The tone to colour a workspace with, wherever it is drawn.
 *
 * The stage's own tone says what the work is waiting on, which is the right thing to say while
 * nothing is happening. An agent actually working is the louder fact: a row reading "Developer
 * responded" in attention amber beside a spinner asks for a person who is not needed yet.
 *
 * Worked out where it is drawn rather than baked into the work, because the agent state has its
 * own poll - knownStatus refreshes `agent` on a status that was read minutes ago - so a tone
 * decided at read time would go stale the moment an agent started or stopped.
 */
export function displayTone(status: Pick<WorkspaceStatus, 'tone' | 'agent'>): Tone {
  return status.agent === 'working' ? 'working' : status.tone;
}

export function agentLabel(state: AgentState): string {
  return AGENT_LABEL[state];
}

// The agent's state is shown by the status disc's colour (see displayTone), not by a glyph of its
// own: the disc beside every row and conversation tab already says it, so a second mark said the
// same thing twice. The words (agentLabel) remain for the card and tooltips.

const GITHUB_EVERY_MS = 5 * 60_000;
const AGENTS_EVERY_MS = 15_000;
const STORE_KEY = 'dev-extension.workspace-status';
const statuses = new Map<string, WorkspaceStatus>(hydrate());
let agents: Record<string, AgentState> = {};

/** What was last read, kept across a reload so a page opens on it rather than on nothing. */
function hydrate(): [string, WorkspaceStatus][] {
  try {
    return Object.entries(JSON.parse(sessionStorage.getItem(STORE_KEY) || '{}'));
  } catch {
    return [];
  }
}

function persist(): void {
  try {
    sessionStorage.setItem(STORE_KEY, JSON.stringify(Object.fromEntries(statuses)));
  } catch { /* a browser without storage opens on nothing, as before */ }
}
let agentsAt = 0;
let agentsInFlight: Promise<void> | null = null;
let reading = false;

function empty(): WorkspaceStatus {
  return {
    agent: 'none', label: '', tone: 'muted', title: '', links: [], readAt: 0, kind: 'other', stage: '', stageLabel: '', reviewed: false, round: 1, pr: 0, ci: '', ciNote: '',
  };
}

function numbers(name: string): { pr: number; issue: number } {
  return {
    pr:    Number(/(?:^|-)pr-(\d+)(?:-|$)/.exec(name)?.[1]) || 0,
    issue: Number(/(?:^|-)issue-(\d+)(?:-|$)/.exec(name)?.[1]) || 0,
  };
}

/**
 * The role each workspace's Installation asks for (LABEL_ROLE), told by whoever read it: the
 * sidebar's list, the workspace's own page. `developer` makes a workspace a fix whatever it is
 * called; with no issue in its name, its PR is the one from its checkout's branch.
 */
const roles: Record<string, string> = {};
const branches: Record<string, string> = {};

export function noteRole(name: string, role: string): void {
  roles[name] = role || '';
}

/** The branch a workspace's checkout is on - told by the page, which reads the checkout. */
export function noteBranch(name: string, branch: string): void {
  branches[name] = branch || '';
}

/** Whether a workspace is its owner's own work: named for an issue, or labelled a developer's. */
function isFix(name: string): boolean {
  const { pr, issue } = numbers(name);

  return !pr && (issue > 0 || roles[name] === 'developer');
}

// ── The agents ──────────────────────────────────────────────────────────────────────────────

const RANK: Record<AgentState, number> = {
  none: 0, finished: 1, idle: 2, input: 3, working: 4,
};

/** One conversation's state from the last hook event its pane recorded, and whether the pane is there. */
export function agentStateOf(c: ConversationState): AgentState {
  /*
   * One derivation, and this is no longer it.
   *
   * There were two copies of this judgement and they had drifted: the one here had neither the
   * five-second margin that lets a hook overrule a transcript which has only just stopped, nor the
   * SessionStart fix - the CLI fires SessionStart the moment it finishes an auto-compact and then
   * carries straight on, so treating it as "idle" was wrong every time a conversation compacted.
   * The same conversation therefore read `idle` in this sidebar and `working` in the conversation
   * strip, which is how the drift was found.
   *
   * `activityState` in agent.ts is the surviving copy, and dev-api's watcher was ported from it, so
   * delegating here leaves one algorithm with two call sites rather than two algorithms. The
   * snapshot already carries a state decided that same way; this path is what answers when the
   * watcher cannot be reached.
   */
  return activityState({
    alive:        c.alive,
    event:        c.event,
    notification: c.notification,
    at:           c.at,
    wroteAgo:     c.wroteAgo,
  }) as AgentState;
}

async function refreshAgents(): Promise<void> {
  if (Date.now() - agentsAt < AGENTS_EVERY_MS) {
    return;
  }
  if (!agentsInFlight) {
    agentsInFlight = (async() => {
      try {
        const next: Record<string, AgentState> = {};

        for (const c of await conversationStates()) {
          const state = agentStateOf(c);

          if (RANK[state] > RANK[next[c.workspace] || 'none']) {
            next[c.workspace] = state;
          }
        }
        agents = next;
        agentsAt = Date.now();
      } catch { /* the next poll asks again */ } finally {
        agentsInFlight = null;
      }
    })();
  }
  await agentsInFlight;
}

// ── The work ────────────────────────────────────────────────────────────────────────────────

const latest = (dates: (string | null | undefined)[]) => Math.max(0, ...dates.map((d) => Date.parse(d || '') || 0));

/**
 * A review workspace (`pr-<n>`): the person reviews someone else's PR with an agent's help.
 *
 * Read from the PR and the review's own comments (which ride in prDetail): the agent's
 * findings not yet submitted are the person's to go through; a submitted review is waiting
 * on the developer until they push or answer; an approval, theirs or anyone's, is done.
 */
function reviewWork(d: Json, agent: AgentState): Work {
  const m = d.meta || {};
  const local: Json[] = d.localComments || [];
  const submitted = local.filter((c) => c.submitted_at);
  const pending = local.filter((c) => !c.submitted_at);
  // A review YOU left on GitHub itself counts as submitted too - but only yours. Counting
  // anyone's put the stage back to "waiting for the developer" the moment a bot approved the
  // PR, days after the developer had answered.
  const viewer = d.viewer || '';
  const reviews: Json[] = (d.reviews || []).filter((r: Json) => r.submittedAt && (viewer ? r.author === viewer : r.author && r.author !== m.author && !isBot(r.author)));
  // Your own latest opinionated review. GitHub's PR-wide `approved` (m.approved) is true only when
  // every required reviewer has approved and none is requesting changes - so another reviewer's
  // "changes requested" from rounds ago keeps it false even after you approve today. This is your
  // reviewer workspace and the stage is about your review: if the last opinion you left is an
  // approval, your review is done, whatever the rest of the PR is still waiting on.
  const myLatestOpinion = (d.reviews || [])
    .filter((r: Json) => r.author === viewer && ['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(r.state))
    .sort((a: Json, b: Json) => (Date.parse(a.submittedAt || '') || 0) - (Date.parse(b.submittedAt || '') || 0))
    .pop();
  const iApproved = !!viewer && myLatestOpinion?.state === 'APPROVED';
  // How many times you have already sent this PR a review. The same review is often recorded
  // twice - once as the comments submitted here, once as GitHub's own review - so they are
  // counted by the minute they went out rather than one by one.
  const rounds = new Set([...submitted.map((c) => c.submitted_at), ...reviews.map((r: Json) => r.submittedAt)]
    .map((at) => String(at || '').slice(0, 16))
    .filter(Boolean)).size;

  if (m.merged) {
    return {
      label: '', tone: 'green', stage: 'approved', stageLabel: 'Merged',
    };
  }
  if (m.approved || iApproved) {
    return { label: '', tone: 'green', stage: 'approved' };
  }
  if (submitted.length || reviews.length) {
    const submittedAt = Math.max(latest(submitted.map((c) => c.submitted_at)), latest(reviews.map((r: Json) => r.submittedAt)));
    const pushed = latest((d.commits || []).map((c: Json) => c.date)) > submittedAt;
    const replied = latest([...(d.discussion || []), ...(d.reviewComments || [])].filter((c: Json) => c.author === m.author).map((c: Json) => c.createdAt)) > submittedAt;

    // Findings of the agent's that have not gone anywhere are a pass waiting to be made,
    // whichever round this is: the rail goes back to Your pass and carries the round with it.
    // A review is a loop, not a line, and the step that says what you have to do is this one.
    if (pending.length) {
      return {
        label: 'go through the new findings', tone: 'attention', stage: 'findings', reviewed: true, round: rounds + 1,
      };
    }

    // Whether this is a reply or still waiting turns on who you are (your review, your comments). If
    // the viewer's identity came back blank - a degraded read - that distinction is not trustworthy,
    // so it is marked soft and the store keeps whatever it already had rather than dropping, say, a
    // stored Approved to Submitted for one bad read.
    /*
     * A reply is always a response; a bare push is one only while you are owed an answer.
     *
     * `pushed` is the head commit's committer date against your review's, and a timestamp cannot
     * tell an answer from a rebase or a merge of main - the same comparison that put "Pushed since"
     * on a pull request with nothing being asked, and was narrowed there (`asksAgain`,
     * priority.ts). That narrowing does not run for a pull request being reviewed in a workspace:
     * `priorityQueue` claims those by number and `fromReviewing` skips them, so this path ranks
     * them instead - at 80, which is higher than the 58 that was fixed.
     *
     * The approval gate above already catches the approve-then-push case. What was left was a
     * review you left as comments: any push afterwards returned "Review the new commits" at the
     * second-highest score in the deck, for a pull request that was not waiting on you.
     * `myLatestOpinion` is computed above and says the thing GitHub's pull-request-wide decision
     * cannot: whether the change request is *yours* and still standing.
     *
     * A push with nothing outstanding falls through to `submitted` below, and `REVIEW_NEEDS` has
     * no `submitted` key - so it produces no card at all, which is the point.
     */
    const owedToMe = myLatestOpinion?.state === 'CHANGES_REQUESTED';

    if (replied || (pushed && owedToMe)) {
      return {
        label: pushed ? 'new commits to review' : 'replied to your comments', tone: 'attention', stage: 'response', reviewed: true, round: rounds, soft: !viewer,
      };
    }

    return {
      label: 'waiting for the developer', tone: 'waiting', stage: 'submitted', reviewed: true, round: rounds, soft: !viewer,
    };
  }
  if (agent === 'working') {
    return { label: '', tone: 'working', stage: 'agent', soft: true };
  }
  if (pending.length) {
    return { label: 'read the agent\'s findings', tone: 'attention', stage: 'findings' };
  }
  // The agent's pass finished and what it found is gone - read and deleted, every one of them.
  // That is a pass made, not a review still to run: falling back to Agent review offered to
  // review the PR again, which is the opposite of what emptying the list said. The run record
  // is what remembers, because the findings themselves no longer exist to say so.
  // Soft, unlike the pending-findings case above where findings actually exist: this is inferred
  // from the run record with an empty list, which a degraded read can also produce. It still carries
  // a soft 'agent' stage forward to findings (higher rank), but must not knock back a stored Approved.
  if (d.run?.state === 'complete') {
    return { label: 'nothing left to go through', tone: 'muted', stage: 'findings', soft: true };
  }
  if (agent === 'input') {
    return { label: '', tone: 'attention', stage: 'agent', soft: true };
  }

  return { label: 'not started', tone: 'muted', stage: 'agent', soft: true };
}

/**
 * A fix workspace (`issue-<n>`): the agent writes the code and opens a PR the person owns.
 *
 * Without a PR the agent is the story. With one: a draft is the person's to read and mark
 * ready (the skills never do), a review from someone else after the last push is theirs to
 * answer, and otherwise the PR waits for a reviewer.
 */
function fixWork(d: Json | null, agent: AgentState, coded = false): Work {
  if (!d) {
    // Before a PR the branch says which of the first two stages this is: commits on it mean the
    // code is being written (or is written); none, and the agent is still assessing.
    const stage: FixStage = coded ? 'code' : 'assess';

    if (agent === 'working') {
      return { label: '', tone: 'working', stage, soft: true };
    }
    if (agent === 'input') {
      return { label: '', tone: 'attention', stage, soft: true };
    }

    return { label: 'no PR yet', tone: 'muted', stage, soft: true };
  }
  const m = d.meta || {};

  if (m.merged) {
    return { label: '', tone: 'green', stage: 'merged' };
  }
  if (m.approved) {
    return {
      label: 'ready to merge', tone: 'green', stage: 'merged', stageLabel: 'Approved',
    };
  }
  const comments: Json[] = [...(d.discussion || []), ...(d.reviewComments || [])];
  const others = latest(comments.filter((c) => c.author && c.author !== m.author && !isBot(c.author)).map((c) => c.createdAt));
  const mine = Math.max(latest(comments.filter((c) => c.author === m.author).map((c) => c.createdAt)), latest((d.commits || []).map((c: Json) => c.date)));

  if (others > mine) {
    return { label: 'respond to the review', tone: 'attention', stage: 'feedback' };
  }
  if (agent === 'working') {
    return { label: '', tone: 'working', stage: m.draft ? 'draft' : 'review' };
  }
  if (m.draft) {
    return { label: 'read it and mark it ready', tone: 'attention', stage: 'draft' };
  }
  if (m.state === 'CLOSED') {
    return {
      label: '', tone: 'muted', stage: 'merged', stageLabel: 'Closed',
    };
  }

  return { label: 'waiting for a reviewer', tone: 'waiting', stage: 'review' };
}

/** A stage's own tone, for when the stored stage is not the one just derived and has no note of its own. */
const STAGE_TONE: Record<Stage, Tone> = {
  assess: 'muted', code: 'muted', draft: 'attention', review: 'waiting', feedback: 'attention', merged: 'green',
  agent: 'muted', findings: 'attention', submitted: 'waiting', response: 'attention', approved: 'green',
};

/** A derived work state, packaged for the store to reconcile against what it already holds. */
function toDerived(kind: 'fix' | 'review', w: Work, pr: number): DerivedStage {
  return {
    kind, stage: (w.stage || (kind === 'review' ? 'agent' : 'assess')) as Stage, stageLabel: w.stageLabel, soft: !!w.soft, round: w.round || 1, reviewed: !!w.reviewed, pr,
  };
}

/**
 * Turn the stored stage into what the row shows. When the stored stage is the one just derived, the
 * derived state's own words and tone are used - they say the most. When they differ - a manual hold,
 * or a soft guess the store would not follow - the stage's name stands alone in the stage's own tone,
 * rather than a note that describes a different stage than the one on the rail.
 */
function display(rec: StageRecord, w: Work): Pick<WorkspaceStatus, 'label' | 'tone' | 'stage' | 'stageLabel' | 'reviewed' | 'round'> {
  const match = rec.stage === w.stage;

  return {
    stage:      rec.stage,
    stageLabel: rec.stageLabel || STAGE_LABELS[rec.stage] || '',
    reviewed:   rec.reviewed,
    round:      rec.round || 1,
    label:      match ? (w.label || '') : '',
    tone:       match ? w.tone : (STAGE_TONE[rec.stage] || 'muted'),
  };
}

async function readWork(name: string): Promise<Partial<WorkspaceStatus>> {
  const { pr, issue } = numbers(name);
  const agent = agents[name] || 'none';
  const links: WorkspaceStatus['links'] = [];

  if (issue) {
    links.push({ label: `Issue #${ issue }`, url: `https://github.com/${ DEFAULT_REPO }/issues/${ issue }` });
  }
  if (pr) {
    const d = await prDetail(pr);

    links.push({ label: `PR #${ pr }`, url: d.meta?.url || `https://github.com/${ DEFAULT_REPO }/pull/${ pr }` });
    const w = reviewWork(d, agent);
    const rec = await reconcileStage(name, toDerived('review', w, pr));

    return {
      ...display(rec, w), ...ciOf(d), title: d.meta?.title || '', links, kind: 'review', pr,
    };
  }
  if (isFix(name)) {
    const n = await (issue ? linkedPullRequest(DEFAULT_REPO, issue) : branchPullRequest(DEFAULT_REPO, branches[name] || '')).catch(() => 0);
    const d = n ? await prDetail(n) : null;

    if (n) {
      links.push({ label: `PR #${ n }`, url: d?.meta?.url || `https://github.com/${ DEFAULT_REPO }/pull/${ n }` });
    }
    const w = fixWork(d, agent, coded[name] || false);
    const rec = await reconcileStage(name, toDerived('fix', w, n));
    // The PR's title once there is one; until then the issue's own title, so a fix reads as the work
    // it is rather than its `issue-<n>` name. Without this a fix with no PR yet had no title at all,
    // and the row fell back to the bare number.
    const title = d?.meta?.title || (issue ? await issueBody(DEFAULT_REPO, issue).catch(() => ({ title: '' })).then((i) => i.title) : '') || '';

    return {
      ...display(rec, w), ...ciOf(d), title, links, kind: 'fix', pr: n,
    };
  }

  return { links, kind: 'other' };
}

/** Whether a fix workspace's branch has commits yet - told by the page, which reads the checkout. */
const coded: Record<string, boolean> = {};

export function noteCoded(name: string, value: boolean): void {
  coded[name] = value;
}

/** What the name alone says - the kind, the links - so a page can draw its rail before any read answers. */
export function provisionalStatus(name: string): WorkspaceStatus {
  const { pr, issue } = numbers(name);
  const links: WorkspaceStatus['links'] = [];

  if (issue) {
    links.push({ label: `Issue #${ issue }`, url: `https://github.com/${ DEFAULT_REPO }/issues/${ issue }` });
  }
  if (pr) {
    links.push({ label: `PR #${ pr }`, url: `https://github.com/${ DEFAULT_REPO }/pull/${ pr }` });
  }

  return {
    ...empty(), kind: pr ? 'review' : isFix(name) ? 'fix' : 'other', links, pr,
  };
}

/** What was last read for a workspace, if anything - the page draws this first and reads behind it. */
export function knownStatus(name: string): WorkspaceStatus | null {
  const known = statuses.get(name);

  return known ? { ...known, agent: agents[name] || known.agent } : null;
}

/**
 * One workspace's status, read now rather than on the sidebar's schedule: the page that shows
 * the stage wants it fresh on open, and after an action that changes it. The agents and GitHub
 * are read at the same time, not one after the other. With `github` false only the agents
 * are read and the work's state is what was last read - the page's regular tick.
 */
export async function readStatusNow(name: string, github = true): Promise<WorkspaceStatus> {
  agentsAt = 0;
  const before = statuses.get(name) || empty();
  const [work] = await Promise.all([github ? readWork(name) : Promise.resolve({}), refreshAgents()]);
  const agent = agents[name] || 'none';
  // A fix with no PR yet moves between Assess and Code on what the checkout says and what the
  // agent is doing, which the tick knows without GitHub - still through the store, so the move only
  // ever goes forward and never undoes a stored stage.
  let rewrite: Partial<WorkspaceStatus> = {};

  if (!github && before.readAt && isFix(name) && !before.pr) {
    const w = fixWork(null, agent, coded[name] || false);

    rewrite = display(await reconcileStage(name, toDerived('fix', w, 0)), w);
  }
  const next = { ...before, ...work, ...rewrite, readAt: github ? Date.now() : before.readAt, agent };

  statuses.set(name, next);
  persist();

  return next;
}

/** GitHub's own bots, which are not reviewers. */
export const isBot = (login: string) => /\[bot\]$/i.test(login || '') || /^(github-actions|dependabot|codecov|renovate)/i.test(login || '');

/** GitHub, one workspace at a time, the stalest first; never two at once. */
async function readStale(names: string[]): Promise<void> {
  if (reading) {
    return;
  }
  const due = names
    .map((name) => ({ name, at: statuses.get(name)?.readAt || 0 }))
    .filter((w) => Date.now() - w.at > GITHUB_EVERY_MS)
    .sort((a, b) => a.at - b.at);

  if (!due.length) {
    return;
  }
  reading = true;
  try {
    const { name } = due[0];
    const before = statuses.get(name) || empty();

    try {
      statuses.set(name, { ...before, ...(await readWork(name)), readAt: Date.now() });
      persist();
    } catch (e) {
      // Read again next time round, not on every poll: the failure is usually GitHub's rate
      // limit or a token, and either is the same in five seconds.
      statuses.set(name, { ...before, readAt: Date.now() });
      console.warn(`[dev] the status of ${ name } could not be read`, e); // eslint-disable-line no-console
    }
  } finally {
    reading = false;
  }
}

/**
 * The statuses of these workspaces, as last known: the agents' states refreshed when they are
 * more than fifteen seconds old, the work's read in the background when more than five
 * minutes old. Returns at once with what there is.
 */
export async function workspaceStatuses(workspaces: { name: string; cluster?: string; preview?: boolean; role?: string }[]): Promise<Record<string, WorkspaceStatus>> {
  // Every workspace, not only local ones. The status is GitHub work (read by PR/issue number, the
  // same from any cluster) plus the agent state (read from the one agent pod, which tracks a
  // conversation by workspace name whatever cluster it runs on) - neither is cluster-scoped, so a
  // downstream-hosted workspace gets its status line and dot like any other. Previews have none.
  const names = workspaces.filter((w) => !w.preview).map((w) => w.name);

  workspaces.forEach((w) => noteRole(w.name, w.role || ''));
  void refreshAgents();
  void readStale(names);

  const out: Record<string, WorkspaceStatus> = {};

  await Promise.all(names.map(async(name) => {
    const known = statuses.get(name) || empty();
    const agent = agents[name] || 'none';
    // The work's wording depends on the agent too, and the agent moves more often than
    // GitHub is read: a fix workspace whose agent has just gone idle says so now. Through the store,
    // so this soft move only carries Assess to Code and never undoes a stored stage.
    let rewrite: Partial<WorkspaceStatus> = {};

    if (known.readAt && isFix(name) && !known.links.some((l) => l.label.startsWith('PR'))) {
      const w = fixWork(null, agent, coded[name] || false);

      rewrite = display(await reconcileStage(name, toDerived('fix', w, 0)), w);
    }
    out[name] = { ...known, ...rewrite, agent };
  }));

  return out;
}

// ── Spin down what is idle ────────────────────────────────────────────────────────────────
//
// A running dev server is two to three gigabytes the cluster does not get back until its pod
// goes, and most of the time most workspaces are between conversations. This spins the idle ones
// down; opening one starts it again (WorkspaceDetail). It runs in the browser, off the sidebar's
// poll, on the agent states it already read - so an agent that is working or waiting on an answer
// is never touched, and neither is a workspace on an open page. That is what makes it safe to do
// without asking: the only thing it stops is a dev server nobody is using and no agent is in.

/**
 * How long a workspace's agent must have been idle, with nobody looking, before it is stopped.
 * Long enough that stepping away for a coffee leaves it as you left it; short enough that a
 * night of idle workspaces is not a cluster's memory held for nothing.
 */
const IDLE_STOP_MS = 45 * 60_000;

const IDLE_KEY = 'dev-extension.idle-since';
/** When each running workspace was first seen idle; cleared the instant it is busy again. */
const idleSince = new Map<string, number>(hydrateIdle());
/** The workspace a page is open on: never stopped from under the person reading it. */
let viewing = '';
/** A stop already in flight, so a slow scale is not asked for twice. */
const stopping = new Set<string>();

function hydrateIdle(): [string, number][] {
  try {
    return Object.entries(JSON.parse(sessionStorage.getItem(IDLE_KEY) || '{}'));
  } catch {
    return [];
  }
}

function persistIdle(): void {
  try {
    sessionStorage.setItem(IDLE_KEY, JSON.stringify(Object.fromEntries(idleSince)));
  } catch { /* a browser without storage forgets between polls, which only defers a stop */ }
}

/**
 * Mark the workspace a page is open on, so the background never stops it; `''` on the way out.
 * Called by WorkspaceDetail, because the one being watched is exactly the one a spin-down would
 * be felt on.
 */
export function setViewing(name: string): void {
  viewing = name || '';
  if (viewing) {
    idleSince.delete(viewing);
    persistIdle();
  }
}

type IdleWorkspace = { name: string; cluster?: string; preview?: boolean; state?: string; replicas?: number };

/**
 * Scale down workspaces whose agent has been idle for IDLE_STOP_MS and which nobody is looking
 * at. Only local ones, which are the ones the agent states cover; `working` and `input` are
 * never touched, so an autonomous agent - one running with no browser open - is safe. Errors are
 * swallowed: a stop that does not take is asked for again next poll.
 */
export async function autoStopIdle(workspaces: IdleWorkspace[]): Promise<void> {
  const now = Date.now();

  // Blind is not idle. If the agent states have not been read successfully and recently - the
  // agent pod is down, the token has expired - reading every workspace as `none` and stopping
  // the lot would take working agents with it. So on stale state, stop nothing and wait.
  if (!agentsAt || now - agentsAt > 2 * 60_000) {
    return;
  }

  for (const w of workspaces) {
    const local = (w.cluster || 'local') === 'local';
    const running = w.state === 'running' || (w.replicas || 0) > 0;

    // Not a candidate: forget any idle it had started to accrue, so a workspace that goes busy,
    // stops, or is opened does not carry a stale clock into its next idle spell.
    //
    // A leased workspace is never a candidate, and that is not an exemption - it is that there
    // is nothing here to spin down. Its pod holds the tree and runs nothing (single digits of
    // megabytes), and the thing this was written to reclaim - a dev server compiling for
    // nobody, two to three gigabytes of it - is a tool with a lease of its own now, which
    // dev-api ends whether or not anybody has a dashboard open. Stopping the pod would save
    // nothing, leave the tools running, and take away the one thing a conversation needs: the
    // pod its commands are forwarded into. It is also how a pressed button ended in a
    // conversation with a prompt queued and no pane.
    if (w.preview || !local || !running || isLte(w.name) || w.name === viewing || stopping.has(w.name)) {
      idleSince.delete(w.name);
      continue;
    }

    const state = agents[w.name] || 'none';

    // Busy or waiting on an answer. `none` on a running workspace is a dev server whose agent
    // pane is gone - left up with no conversation - which is exactly what should spin down.
    if (state === 'working' || state === 'input') {
      idleSince.delete(w.name);
      continue;
    }

    if (!idleSince.has(w.name)) {
      idleSince.set(w.name, now);
    }
    if (now - (idleSince.get(w.name) as number) < IDLE_STOP_MS) {
      continue;
    }

    stopping.add(w.name);
    idleSince.delete(w.name);
    setWorkspaceRunning(w.name, false, w.cluster || 'local')
      .catch(() => { /* asked for again next poll */ })
      .finally(() => stopping.delete(w.name));
  }
  persistIdle();
}
