// What each workspace needs from the person, and what its agent is doing: the sidebar's
// second line, and the card under the pointer.
//
// Two sources, kept apart because they cost differently. The agents' states come from the
// agent pod in one exec (conversationStates), every fifteen seconds. The work's state comes
// from GitHub - the PR a review is about, the PR an issue's fix opened - which is several
// calls per workspace, so each workspace is read every five minutes, one at a time, in the
// background; the sidebar shows whatever was last read and never waits on it.
import { prDetail, DEFAULT_REPO, devApi } from './reviews';
import { jiraDetail, JIRA_BASE } from './jira';
import { jiraStageOf } from './jira-steps.mjs';
import { linkedPullRequest, branchPullRequest, issueBody } from './github';
import { conversationStates, agentConversations, ConversationState } from './conversations';
import { setWorkspaceRunning, installationRepos } from './api';
import { isLte, LTE_PREFIX, DEFAULT_APP } from './config/constants';
import { listApps } from './apps';
import { reconcileStage } from './stages';
import type { StageRecord } from './stages';

// The stage a workspace shows is stored and guarded, not re-guessed each read: see stages.ts. These
// re-exports let the rail and the PR panel set or release a manual stage without knowing where it lives.
export { setManualStage, clearManualStage, isManual } from './stages';

type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any

import { activityState } from './agent';
import { note } from './dev-log.mjs';
import { noteRepo, notedRepo, resolveRepo } from './workspace-repos.mjs';
import { readPrefs, savePrefs } from './prefs';
import { watch as watchPath } from './events';
import {
  reviewWork, fixWork, toDerived, displayOf, activityTimes as activityTimesOf, isBot as isBotOf, STAGE_LABELS as SHARED_STAGE_LABELS, STAGE_TONE, workspaceNumbers,
} from './stage-derive.mjs';

export type AgentState = 'working' | 'input' | 'idle' | 'finished' | 'none';
/**
 * `asking` is an agent stopped on a question; `attention` is everything else that wants a
 * person. Two tones rather than one because they are two different asks: a question blocks
 * the work until it is answered, and "nothing is running" has been true since yesterday.
 */
export type Tone = 'green' | 'asking' | 'attention' | 'waiting' | 'working' | 'muted';
/** Where the work is, on the rail: a fix's stages, or a review's. */
export type FixStage = 'assess' | 'code' | 'draft' | 'review' | 'feedback' | 'merged';
export type ReviewStage = 'agent' | 'findings' | 'submitted' | 'response' | 'approved';
/**
 * Where the process has a bug: the positions `jiraStageOf` answers, which are its stages.
 *
 * They were collapsed to one, on the grounds that a bug's position is Jira's fact rather than
 * a stage of work here - and that is true of a review's `submitted` as well, which is GitHub's.
 * What matters is that there is one part to play (see `roleForStep`) and the work moves through
 * these as it is carried out, which is what a stepper is for and what the nav now groups by.
 *
 * Waiting for Reporter is the one that is not a step forward: it is where either of the first
 * two goes when the report is not enough, and a bug comes back from it to either. It sits in
 * the line because that is where it sits in the document, and because leaving it out would
 * mean a parked bug had no position at all.
 *
 * The moves are not a property of the position. Every one the document allows from here is on
 * the Actions row at every stage - see TRIAGE_MOVES and the rail's `bugMoves`.
 */
export type BugStage = 'bug-new' | 'bug-triage' | 'bug-waiting' | 'bug-prioritized' | 'bug-done';
export type Stage = FixStage | ReviewStage | BugStage;

/**
 * What each stage is called. One list, so the rail's stepper, the page's headline and the
 * sidebar's second line all name the stage the same way: a workspace that reads "In review"
 * on its rail reads "In review" in the list beside it.
 */
export const STAGE_LABELS: Record<Stage, string> = SHARED_STAGE_LABELS;

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
  kind: 'fix' | 'review' | 'jira' | 'other';
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
  /** The Jira key this workspace is for, where it is for one: `SURE-12345`, else ''. */
  bug: string;
  /** When GitHub was last read for it; 0 when it never has been. */
  readAt: number;
  /**
   * The pull request's last activity by somebody other than you (a comment, a reply, a review, a
   * commit), and when you last spoke on it (a review or a comment of yours). Both ms; 0 unknown.
   * See unread() - they are what "new" in the sidebar is, whatever stage the heuristics settle on.
   */
  othersAt?: number;
  spokeAt?: number;
}

/**
 * When somebody else last did something on a pull request, and when you last spoke on it.
 *
 * Separate from the stage, and on purpose. The stage is a reading of the conversation - who is
 * waiting on whom - and it is right most of the time and wrong in ways that are hard to see: a
 * question in a thread with no commit, a second reviewer weighing in, an answer to your answer.
 * Each of those is "something happened that you have not seen", which needs no reading at all.
 * Bots do not count; an unsent draft of yours is not you speaking.
 */
export function activityTimes(d: Json): { othersAt: number; spokeAt: number } {
  return activityTimesOf(d);
}

/*
 * When each workspace was last opened, kept in the person's preferences (see prefs.ts `seen`).
 *
 * `since` is when that started being kept: activity before it is not "new", or the first page
 * load after this shipped would have marked every workspace with an old unanswered comment.
 */
const seen: Record<string, number> = {};
let seenSince = 0;
let seenRead: Promise<void> | null = null;
let seenSave: ReturnType<typeof setTimeout> | null = null;

/** Read the record once per page; a failed read leaves it empty, which marks nothing. */
export function loadSeen(): Promise<void> {
  if (!seenRead) {
    seenRead = readPrefs().then((prefs) => {
      Object.assign(seen, prefs.seen || {});
      seenSince = prefs.seenSince || 0;
      if (!seenSince) {
        seenSince = Date.now();
        savePrefs({ seenSince }).catch(() => {});
      }
    }).catch(() => {
      seenSince = Date.now();
    });
  }

  return seenRead;
}

/** The workspace is being looked at: everything on it up to now has been seen. */
export function markSeen(name: string): void {
  seen[name] = Date.now();
  if (seenSave) {
    clearTimeout(seenSave);
  }
  // Batched: a page that marks on every refresh writes the preference once, not every poll.
  seenSave = setTimeout(() => {
    seenSave = null;
    loadSeen().then(() => savePrefs({ seen: { ...seen } })).catch(() => {});
  }, 5000);
}

/**
 * Whether a workspace has something on it you have not seen: activity by somebody else after
 * you last spoke on the pull request, after you last opened the workspace, and after this
 * started being kept. Nothing until the record has been read.
 */
export function unread(name: string, status: Pick<WorkspaceStatus, 'othersAt' | 'spokeAt'> | null | undefined): boolean {
  const others = status?.othersAt || 0;

  return !!seenSince && others > Math.max(status?.spokeAt || 0, seen[name] || 0, seenSince);
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

/**
 * The colour a workspace is drawn with in a list: whether it is waiting on YOU.
 *
 * The list used to say two things at once - the stage in its own tone, and a CI chip beside it -
 * and neither answered the only question a list of eight workspaces is read to answer: which of
 * these is stuck on me. So the colour answers that, and nothing else; the stage's words say
 * where the work is, and what its checks are doing is on the PR, where it can be acted on.
 *
 * Three readings, in this order:
 *
 *   - an agent asked something and stopped: yours to answer, whatever the stage says.
 *   - an agent is working: in flight, and a row that asks for a person who is not needed yet is
 *     how a list of amber dots stops meaning anything.
 *   - nothing is running: the stage's own tone, EXCEPT that a stage nothing is moving is not
 *     quiet. `muted` is what a stage with no agent and no GitHub fact behind it comes out as -
 *     "not started", "no PR yet", "nothing left to go through" - and every one of those is a
 *     workspace that has stopped and wants a person. Waiting on a reviewer or on the developer
 *     stays its own waiting colour, because that is somebody else's turn, and merged stays
 *     green.
 */
export function attentionTone(status: Pick<WorkspaceStatus, 'tone' | 'agent'>): Tone {
  if (status.agent === 'input') {
    return 'asking';
  }
  if (status.agent === 'working') {
    return 'working';
  }

  return status.tone === 'muted' ? 'attention' : status.tone;
}

/**
 * Why the dot is the colour it is, in a sentence - the tooltip on it.
 *
 * Beside attentionTone rather than wherever a dot is drawn, because a colour and the words for
 * it have to be decided together or they drift: the tooltip used to be the workspace pod's
 * lifecycle state ("Running"), which the colour stopped being about, and a row reading
 * "Developer responded" with no agent in it under a tooltip saying Running is two answers to
 * one question.
 */
export function attentionReason(status: Pick<WorkspaceStatus, 'tone' | 'agent'>): string {
  if (status.agent === 'input') {
    return 'An agent asked something and stopped until it hears back';
  }
  if (status.agent === 'working') {
    return 'An agent is working';
  }
  switch (attentionTone(status)) {
  case 'asking':
    return 'An agent asked something and stopped until it hears back';
  case 'attention':
    return 'Nothing is running - this is waiting on you';
  case 'waiting':
    return 'Waiting on somebody else';
  case 'green':
    return 'Nothing is waiting on you';
  default:
    return 'Nothing is running';
  }
}

export function agentLabel(state: AgentState): string {
  return AGENT_LABEL[state];
}

/**
 * What to call a workspace in front of a person: the piece of work, not the pod.
 *
 * One rule, in one place, because it is read in two: the sidebar row and the workspace page's
 * own heading. They disagreed - the row said "Migrate project from Webpack to Vite", the page
 * said "lte-issue-7468" - so the list and the thing the list opened looked like two different
 * workspaces.
 *
 * The title is the name of the work: it comes from the workspace where that carries one, else
 * from the GitHub status read for it (`resolved`), because a downstream workspace has no title
 * of its own. The `issue-`/`pr-` name is the last resort, and keeps that prefix there, since a
 * bare number with nothing beside it is a mystery. `lte-` is never shown: it says how a workspace
 * is run, which is nothing a person choosing between pieces of work needs, and six rows starting
 * with the same four characters only shorten what fits.
 *
 * Untrimmed. Where it has to fit a row, the caller trims it - see DevSidebar's `rowLabel`.
 */
export function workspaceTitle(workspace: { name: string; title?: string }, resolved = ''): string {
  return workspace.title || resolved || (isLte(workspace.name) ? workspace.name.slice(LTE_PREFIX.length) : workspace.name);
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
    agent: 'none', label: '', tone: 'muted', title: '', links: [], readAt: 0, kind: 'other', stage: '', stageLabel: '', reviewed: false, round: 1, pr: 0, bug: '',
  };
}

/**
 * What a workspace's name says it is for.
 *
 * `bug` is the SURE project alone and not "any Jira key", on purpose: a workspace name is
 * `<prefix>-<thing>-<number>` and `pr-19711` has exactly the shape of a Jira key. SURE is the
 * only project this product touches (see jira.ts), so matching its name and nothing else is
 * the difference between finding the bug workspaces and claiming every pull request is one.
 */
function numbers(name: string): { pr: number; issue: number; bug: string } {
  return workspaceNumbers(name);
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

// Who tells it, and why an empty value is ignored: see workspace-repos.mjs.
export { noteRepo };

/** The repository a workspace is for, as far as this tab has been told, falling back to this product's own. */
export function repoOf(name: string): string {
  return notedRepo(name) || DEFAULT_REPO;
}

/**
 * The repository a workspace is for, asking its Installation when this tab has not been told.
 * Every read that goes to GitHub, or stores a stage, goes through this rather than repoOf.
 */
async function repoFor(name: string): Promise<string> {
  return (await resolveRepo(name, installationRepos)) || DEFAULT_REPO;
}

/**
 * The repository a workspace is for, from the workspace itself: its Installation's `repo` value,
 * else its App's, else the default App's.
 *
 * The Installation comes first because an App's `repo` is only the default a new workspace is
 * made with. `lte-pr-222`, a rancher/virtual-clusters-ui PR, was made from lte-workspace, whose
 * default is rancher/dashboard; reading the App alone pointed its PR, Review and Share tabs at
 * rancher/dashboard#222.
 */
export async function workspaceRepo(store: Parameters<typeof listApps>[0], workspace: { app?: string; repo?: string }): Promise<string> {
  if (workspace.repo) {
    return workspace.repo;
  }
  const apps = await listApps(store).catch(() => []);
  const own = apps.find((app) => app.id === workspace.app && app.repo);
  const fallback = apps.find((app) => app.id === DEFAULT_APP && app.repo) || apps.find((app) => !!app.repo);

  return (own || fallback)?.repo || DEFAULT_REPO;
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

// A question outranks work in progress. A workspace's state is the busiest of its
// conversations', and with `working` on top a question went invisible behind a sibling that
// happened to be busy - the one state a person has to act on, hidden by one they do not. It
// blocks: that conversation has stopped and will not move again until it hears back.
const RANK: Record<AgentState, number> = {
  none: 0, finished: 1, idle: 2, working: 3, input: 4,
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
    // Apart from wroteAgo, and the reason is the whole of the flicker: a Stop hook ends the
    // main agent's turn and says nothing about its subagents. See activityBucket.
    subAgo:       c.subAgo,
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
        /*
         * The pod's own answer first: which conversations each workspace HAS, crossed with what
         * each one is DOING. See agentConversations.
         *
         * The fallback below infers the first from the second, and that is the inaccuracy it
         * replaces - a state left behind by a conversation that has gone still names a workspace,
         * because the workspace is read out of the id, so the workspace went on reporting an
         * idle agent with nothing in it. Every state here belongs to a conversation the pod has
         * just listed.
         */
        const asked = await agentConversations();

        if (asked) {
          for (const row of asked) {
            if (RANK[row.state] > RANK[next[row.workspace] || 'none']) {
              next[row.workspace] = row.state;
            }
          }
        } else {
          // The agents half cannot answer: an older bundle on the page, or a pod that is away.
          // The watcher's document is less exact and is still better than going blank.
          for (const c of await conversationStates()) {
            const state = agentStateOf(c);

            if (RANK[state] > RANK[next[c.workspace] || 'none']) {
              next[c.workspace] = state;
            }
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

// ── The statuses dev-api derives ──────────────────────────────────────────────────────────
//
// Every review and fix workspace's stage, what it needs, its title and links, as dev-api works them
// out (see stage-derive.mjs): from GitHub only when its events poll says a pull request moved, so
// a tab - however many are open - asks GitHub nothing for them. Watched, so a stage that moves is
// here within a few seconds of dev-api seeing it. `null` until dev-api has answered once; `false`
// for a dev-api from before the route, which this tab then reads the old way, below.

let server: boolean | null = null;
let serverAsked: Promise<void> | null = null;

/** What of dev-api's status this tab shows; the agent's state stays this tab's own, read more often. */
function fromServer(s: Json): Partial<WorkspaceStatus> {
  return {
    label:      s.label || '',
    tone:       s.tone || 'muted',
    title:      s.title || '',
    links:      Array.isArray(s.links) ? s.links : [],
    kind:       s.kind || 'other',
    stage:      s.stage || '',
    stageLabel: s.stageLabel || '',
    reviewed:   !!s.reviewed,
    round:      s.round || 1,
    pr:         s.pr || 0,
    othersAt:   s.othersAt || 0,
    spokeAt:    s.spokeAt || 0,
    readAt:     s.readAt || Date.now(),
  };
}

function takeServer(answer: Json): void {
  for (const [name, s] of Object.entries(answer?.statuses || {}) as [string, Json][]) {
    if (s && s.kind !== 'other') {
      statuses.set(name, { ...(statuses.get(name) || empty()), ...fromServer(s) });
    }
  }
  persist();
}

/** Ask dev-api once whether it derives statuses, and from then on hear them as they change. */
function serverStatuses(): Promise<void> {
  if (!serverAsked) {
    serverAsked = (async() => {
      const answer = await devApi('/workspaces/status').catch(() => null);

      server = !!answer?.statuses;
      if (server) {
        takeServer(answer);
        watchPath('/workspaces/status', takeServer, { every: 15000 });
      }
    })();
  }

  return serverAsked;
}

/** One workspace's pull request read again by dev-api now: after an action, a page wants the result. */
async function serverRefresh(name: string): Promise<Partial<WorkspaceStatus> | null> {
  const answer = await devApi(`/workspaces/${ name }/status/refresh`, { method: 'POST', body: '{}' }).catch(() => null);

  return answer?.status && answer.status.kind !== 'other' ? fromServer(answer.status) : null;
}

// ── The work ────────────────────────────────────────────────────────────────────────────────
//
// How a review or a fix workspace reads - reviewWork, fixWork, and the store's trust rules - is
// stage-derive.mjs, shared with dev-api, which works every workspace's status out itself and serves
// it (`/workspaces/status`). This tab takes those; what is below is for a dev-api from before that.

/** The stored record, as the row shows it. */
function display(rec: StageRecord, w: Json): Pick<WorkspaceStatus, 'label' | 'tone' | 'stage' | 'stageLabel' | 'reviewed' | 'round'> {
  return displayOf(rec, w) as Pick<WorkspaceStatus, 'label' | 'tone' | 'stage' | 'stageLabel' | 'reviewed' | 'round'>;
}

async function readWork(name: string): Promise<Partial<WorkspaceStatus>> {
  const { pr, issue, bug } = numbers(name);

  await serverStatuses();
  if (server && !bug && (pr || isFix(name))) {
    const fresh = await serverRefresh(name);

    if (fresh) {
      return fresh;
    }
  }
  const agent = agents[name] || 'none';
  const links: WorkspaceStatus['links'] = [];
  // The workspace's own, not this product's, known before anything is read. See workspace-repos.mjs.
  const repo = await repoFor(name);

  if (issue) {
    links.push({ label: `Issue #${ issue }`, url: `https://github.com/${ repo }/issues/${ issue }` });
  }
  if (bug) {
    links.push({ label: bug, url: `${ JIRA_BASE }/browse/${ bug }` });
  }
  if (pr) {
    const d = await prDetail(pr, repo);

    links.push({ label: `PR #${ pr }`, url: d.meta?.url || `https://github.com/${ repo }/pull/${ pr }` });
    const w = reviewWork(d, agent);
    const rec = await reconcileStage(name, toDerived('review', w, pr, repo));

    return {
      ...display(rec, w), title: d.meta?.title || '', links, kind: 'review', pr, ...activityTimes(d),
    };
  }
  /*
   * A bug's workspace reads Jira, not GitHub.
   *
   * Before `isFix`, because a bug's workspace can carry the `developer` role - a fix step runs in
   * the same workspace the reproduction ran in - and `isFix` would then claim it and draw a fix's
   * stages over a ticket that has no pull request.
   *
   * Its stage is the ticket's own status and nothing else: this is not a stage somebody here
   * moves through, it is where Jira says the bug is, so it is read rather than reconciled against
   * a stored one. A ticket that cannot be read leaves the stage alone instead of resetting it.
   */
  if (bug) {
    const ticket = await jiraDetail(bug).catch(() => null);

    if (!ticket) {
      return {
        links, kind: 'jira', bug, title: bug,
      };
    }
    const position = jiraStageOf(ticket.status, ticket.resolution);
    const overdue = ticket.checks.some((c) => c.field === 'age');

    return {
      links,
      kind:  'jira',
      bug,
      pr:    0,
      title: ticket.summary || bug,
      stage: position,
      // The ticket's own status, not the stage's word for it: the nav row says which of the
      // eight statuses that reach Reproduced this one actually is, while the stepper's node
      // says the place in the process. See STAGE_LABELS.
      stageLabel: ticket.status,
      // Overdue is the deadline the process puts on this status, not an opinion, so it is said
      // rather than left to the colour.
      label:      overdue ? 'past its deadline' : '',
      tone:       overdue ? 'attention' : ((STAGE_TONE as Record<string, Tone>)[position] || 'muted'),
    };
  }
  if (isFix(name)) {
    const n = await (issue ? linkedPullRequest(repo, issue) : branchPullRequest(repo, branches[name] || '')).catch(() => 0);
    const d = n ? await prDetail(n, repo) : null;

    if (n) {
      links.push({ label: `PR #${ n }`, url: d?.meta?.url || `https://github.com/${ repo }/pull/${ n }` });
    }
    const w = fixWork(d, agent, coded[name] || false);
    const rec = await reconcileStage(name, toDerived('fix', w, n, repo));
    // The PR's title once there is one; until then the issue's own title, so a fix reads as the work
    // it is rather than its `issue-<n>` name. Without this a fix with no PR yet had no title at all,
    // and the row fell back to the bare number.
    const title = d?.meta?.title || (issue ? await issueBody(repo, issue).catch(() => ({ title: '' })).then((i) => i.title) : '') || '';

    return {
      ...display(rec, w), title, links, kind: 'fix', pr: n, ...(d ? activityTimes(d) : {}),
    };
  }

  return { links, kind: 'other' };
}

/**
 * Whether a fix workspace's branch has commits yet.
 *
 * Told by two readers: the workspace page, which runs git in the checkout while it is open, and
 * refreshCoded below, which asks dev-api for every fix workspace the sidebar lists. Only the page
 * did, so a row stayed Assess until somebody opened it - and the switch to Code is the moment the
 * row exists to announce.
 */
const coded: Record<string, boolean> = {};

export function noteCoded(name: string, value: boolean): void {
  coded[name] = value;
}

const CODED_EVERY_MS = 30000;
let codedAt = 0;
let codedInFlight: Promise<void> | null = null;

/**
 * Ask dev-api which fix workspaces' checkouts have commits (GET /workspaces/coded, which reads
 * git's reflog off the disk - see dev-api/branch-state.mjs). Every 30 seconds at most, one
 * request in flight, and a null answer - no checkout yet - leaves what was known. A dev-api from
 * before the route answers 404, which is the same as not knowing.
 */
async function refreshCoded(names: string[]): Promise<void> {
  const fixes = names.filter((name) => isFix(name) && !statuses.get(name)?.links.some((l) => l.label.startsWith('PR')));

  if (!fixes.length || Date.now() - codedAt < CODED_EVERY_MS) {
    return codedInFlight || undefined;
  }
  codedAt = Date.now();
  codedInFlight = (async() => {
    try {
      const answer = await devApi(`/workspaces/coded?names=${ encodeURIComponent(fixes.join(',')) }`);

      for (const [name, state] of Object.entries(answer || {}) as [string, { coded: boolean | null }][]) {
        if (typeof state?.coded === 'boolean') {
          coded[name] = state.coded;
        }
      }
    } catch (e) {
      note('dev', 'which workspaces have commits could not be read', e);
    } finally {
      codedInFlight = null;
    }
  })();

  return codedInFlight;
}

/** What the name alone says - the kind, the links - so a page can draw its rail before any read answers. */
export function provisionalStatus(name: string): WorkspaceStatus {
  const { pr, issue, bug } = numbers(name);
  const links: WorkspaceStatus['links'] = [];
  // Whatever has been noted for it, which before the first listing is this product's own. These
  // links are replaced by the real read a moment later; the point is that they are not wrong in
  // the meantime for a workspace that is somebody else's repository. Asked for now, so the next
  // draw has it even if this one did not.
  const repo = repoOf(name);

  void repoFor(name);

  if (issue) {
    links.push({ label: `Issue #${ issue }`, url: `https://github.com/${ repo }/issues/${ issue }` });
  }
  if (pr) {
    links.push({ label: `PR #${ pr }`, url: `https://github.com/${ repo }/pull/${ pr }` });
  }
  if (bug) {
    links.push({ label: bug, url: `${ JIRA_BASE }/browse/${ bug }` });
  }

  return {
    ...empty(), kind: pr ? 'review' : bug ? 'jira' : isFix(name) ? 'fix' : 'other', links, pr, bug,
  };
}

/** The agent state last read for a workspace. For a ranking that outlives the read it was built on. */
export function agentOf(name: string): AgentState {
  return agents[name] || 'none';
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

  if (!server && !github && before.readAt && isFix(name) && !before.pr) {
    const w = fixWork(null, agent, coded[name] || false);

    rewrite = display(await reconcileStage(name, toDerived('fix', w, 0, await repoFor(name))), w);
  }
  const next = { ...before, ...work, ...rewrite, readAt: github ? Date.now() : before.readAt, agent };

  statuses.set(name, next);
  persist();

  return next;
}

/** GitHub's own bots, which are not reviewers. */
export const isBot = (login: string): boolean => isBotOf(login);

/**
 * How many workspaces one pass reads. The reason it is not one, and not all of them.
 *
 * It was one. That is a queue, and the time to notice anything is the length of it: with a
 * dozen workspaces a verdict could sit wrong for the better part of an hour, and the symptom is
 * a row that says "Developer responded" about a pull request you approved. The stage itself was
 * right - run the rule over the data and it answers Approved - it had simply not been asked
 * again yet.
 *
 * Not all of them either. Each is several GitHub calls, and a dozen workspaces times a page
 * that reloads is how a token meets its rate limit. Three at a time, oldest first, is a full
 * sweep in a few passes and a handful of calls per pass.
 */
const READ_AT_ONCE = 3;

/** GitHub, the stalest few first; never two passes at once. */
async function readStale(names: string[]): Promise<void> {
  await serverStatuses();
  // dev-api reads these and pushes what it finds; only a Jira bug's workspace is read from here.
  if (server) {
    names = names.filter((name) => numbers(name).bug);
  }
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
    // Together rather than in turn: they are independent reads of different pull requests, and
    // the slowest of three is a great deal less than the sum of three.
    await Promise.all(due.slice(0, READ_AT_ONCE).map(async({ name }) => {
      const before = statuses.get(name) || empty();

      try {
        statuses.set(name, { ...before, ...(await readWork(name)), readAt: Date.now() });
      } catch (e) {
        // Read again next time round, not on every poll: the failure is usually GitHub's rate
        // limit or a token, and either is the same in five seconds.
        statuses.set(name, { ...before, readAt: Date.now() });
        note('dev', `the status of ${ name } could not be read`, e);
      }
    }));
    persist();
  } finally {
    reading = false;
  }
}

/**
 * The statuses of these workspaces, as last known: the agents' states refreshed when they are
 * more than fifteen seconds old, the work's read in the background when more than five
 * minutes old. Returns at once with what there is.
 */
export async function workspaceStatuses(workspaces: { name: string; cluster?: string; preview?: boolean; role?: string; repo?: string }[]): Promise<Record<string, WorkspaceStatus>> {
  // Every workspace, not only local ones. The status is GitHub work (read by PR/issue number, the
  // same from any cluster) plus the agent state (read from the one agent pod, which tracks a
  // conversation by workspace name whatever cluster it runs on) - neither is cluster-scoped, so a
  // downstream-hosted workspace gets its status line and dot like any other. Previews have none.
  const names = workspaces.filter((w) => !w.preview).map((w) => w.name);

  workspaces.forEach((w) => {
    noteRole(w.name, w.role || '');
    noteRepo(w.name, w.repo || '');
  });
  /*
   * Awaited, where the other two reads are not, because the statuses it fills are read back
   * synchronously below - and whoever reads them ranks on what is there at that moment.
   *
   * Fire-and-forget made every caller's answer depend on a race. The sidebar polls this call for
   * as long as standard mode is on screen, so `agents` is warm by the time anything else asks;
   * a page loaded cold asks first and is told every agent is `none`. Focus ranks its deck from
   * exactly this - so the same queue came out two different ways, one deck for a click out of
   * standard mode and another for a reload, decided by which call got there first.
   *
   * It costs one GET, and only sometimes: fifteen-second throttle, and one in-flight refresh
   * shared by every caller. The sidebar's poll pays nothing for it.
   */
  await refreshAgents();
  // Before the rewrite below reads `coded`, so a fix whose agent has committed moves to Code
  // on this poll rather than on the next visit to its page.
  await refreshCoded(names);
  void readStale(names);

  const out: Record<string, WorkspaceStatus> = {};

  await Promise.all(names.map(async(name) => {
    const known = statuses.get(name) || empty();
    const agent = agents[name] || 'none';
    // The work's wording depends on the agent too, and the agent moves more often than
    // GitHub is read: a fix workspace whose agent has just gone idle says so now. Through the store,
    // so this soft move only carries Assess to Code and never undoes a stored stage.
    let rewrite: Partial<WorkspaceStatus> = {};

    if (!server && known.readAt && isFix(name) && !known.links.some((l) => l.label.startsWith('PR'))) {
      const w = fixWork(null, agent, coded[name] || false);

      rewrite = display(await reconcileStage(name, toDerived('fix', w, 0, await repoFor(name))), w);
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
