// What each workspace needs from the person, and what its agent is doing: the sidebar's
// second line, and the card under the pointer.
//
// Two sources, kept apart because they cost differently. The agents' states come from the
// agent pod in one exec (conversationStates), every fifteen seconds. The work's state comes
// from GitHub - the PR a review is about, the PR an issue's fix opened - which is several
// calls per workspace, so each workspace is read every five minutes, one at a time, in the
// background; the sidebar shows whatever was last read and never waits on it.
import { prDetail, DEFAULT_REPO } from './reviews';
import { linkedPullRequest } from './github';
import { conversationStates, ConversationState } from './conversations';

type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any

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

/** A work state with its stage's name already on it. */
type Work = Pick<WorkspaceStatus, 'label' | 'tone' | 'stage'> & { stageLabel?: string; reviewed?: boolean; round?: number };

/**
 * Name the stage on a state that has one. A state may name its own stage instead where the
 * rail has no step for it - a closed PR sits at the end of the rail without being merged.
 */
function staged(work: Work): Pick<WorkspaceStatus, 'label' | 'tone' | 'stage' | 'stageLabel' | 'reviewed' | 'round'> {
  return {
    ...work, stageLabel: work.stageLabel ?? (work.stage ? STAGE_LABELS[work.stage] : ''), reviewed: !!work.reviewed, round: work.round || 1,
  };
}

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
  /** When GitHub was last read for it; 0 when it never has been. */
  readAt: number;
}

const AGENT_LABEL: Record<AgentState, string> = {
  working:  'agent working',
  input:    'agent needs an answer',
  idle:     'agent idle',
  finished: 'agent finished',
  none:     '',
};

export function agentLabel(state: AgentState): string {
  return AGENT_LABEL[state];
}

/**
 * The agent's state as a mark rather than as words.
 *
 * A list of workspaces reads down the left, and "agent idle" repeated eight times down the
 * right is eight rows of the same three words. The icon says the same thing in the space of a
 * character, and its tooltip says it in words for anyone who wants them.
 */
const AGENT_ICON: Record<AgentState, string> = {
  working:  'icon-spinner icon-spin',
  input:    'icon-warning',
  // Not an open dot: the theme's spinner is a broken ring, and at eleven pixels, still, beside
  // one, the two were the same small circle. A pause bar cannot be mistaken for either.
  idle:     'icon-pause',
  finished: 'icon-checkmark',
  none:     '',
};

export function agentIcon(state: AgentState): string {
  return AGENT_ICON[state];
}

const GITHUB_EVERY_MS = 5 * 60_000;
const AGENTS_EVERY_MS = 15_000;
/**
 * How recently the transcript must have been written for the conversation to count as working.
 * Long enough to cover a subagent thinking between writes, short enough that a conversation
 * nobody is in stops claiming to be busy.
 */
const WORKING_WINDOW_S = 90;

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
    agent: 'none', label: '', tone: 'muted', title: '', links: [], readAt: 0, kind: 'other', stage: '', stageLabel: '', reviewed: false, round: 1, pr: 0,
  };
}

function numbers(name: string): { pr: number; issue: number } {
  return {
    pr:    Number(/(?:^|-)pr-(\d+)(?:-|$)/.exec(name)?.[1]) || 0,
    issue: Number(/(?:^|-)issue-(\d+)(?:-|$)/.exec(name)?.[1]) || 0,
  };
}

// ── The agents ──────────────────────────────────────────────────────────────────────────────

const RANK: Record<AgentState, number> = {
  none: 0, finished: 1, idle: 2, input: 3, working: 4,
};

/** One conversation's state from the last hook event its pane recorded, and whether the pane is there. */
function agentStateOf(c: ConversationState): AgentState {
  if (!c.alive) {
    return 'finished';
  }
  // The transcript, when it has moved since the hook last spoke.
  //
  // A hook fires at the edges of a turn, so a turn spent inside subagents - twenty minutes of
  // them - reads as finished to it while the subagents write their transcripts all the while.
  // And there is no hook at all for "the question was answered": a permission prompt answered
  // in the terminal leaves the last Notification standing, so the question mark sat on a
  // workspace whose agent had been working again for ten minutes.
  //
  // Writing since the hook spoke settles both: the agent is doing something, whatever it last
  // said. A question with nothing written since it was asked is still a question.
  const hookAgo = (Date.now() - (Date.parse(c.at) || 0)) / 1000;

  if (c.wroteAgo >= 0 && c.wroteAgo <= WORKING_WINDOW_S && c.wroteAgo + 5 < hookAgo) {
    return 'working';
  }
  if (c.event === 'Notification' && c.notification && c.notification !== 'idle_prompt') {
    return 'input';
  }
  switch (c.event) {
  case 'UserPromptSubmit':
  case 'PreToolUse':
  case 'PostToolUse':
  case 'SubagentStop':
    return 'working';
  case 'Notification':
    return c.notification === 'idle_prompt' ? 'idle' : 'input';
  default:
    return 'idle';
  }
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
  if (m.approved) {
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

    if (pushed || replied) {
      return {
        label: pushed ? 'new commits to review' : 'replied to your comments', tone: 'attention', stage: 'response', reviewed: true, round: rounds,
      };
    }

    return {
      label: 'waiting for the developer', tone: 'waiting', stage: 'submitted', reviewed: true, round: rounds,
    };
  }
  if (agent === 'working') {
    return { label: '', tone: 'working', stage: 'agent' };
  }
  if (pending.length) {
    return { label: 'read the agent\'s findings', tone: 'attention', stage: 'findings' };
  }
  if (agent === 'input') {
    return { label: '', tone: 'attention', stage: 'agent' };
  }

  return { label: 'not started', tone: 'muted', stage: 'agent' };
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
      return { label: '', tone: 'working', stage };
    }
    if (agent === 'input') {
      return { label: '', tone: 'attention', stage };
    }

    return { label: 'no PR yet', tone: 'muted', stage };
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

    return {
      ...staged(reviewWork(d, agent)), title: d.meta?.title || '', links, kind: 'review', pr,
    };
  }
  if (issue) {
    const n = await linkedPullRequest(DEFAULT_REPO, issue).catch(() => 0);
    const d = n ? await prDetail(n) : null;

    if (n) {
      links.push({ label: `PR #${ n }`, url: d?.meta?.url || `https://github.com/${ DEFAULT_REPO }/pull/${ n }` });
    }

    return {
      ...staged(fixWork(d, agent, coded[name] || false)), title: d?.meta?.title || '', links, kind: 'fix', pr: n,
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
    ...empty(), kind: pr ? 'review' : issue ? 'fix' : 'other', links, pr,
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
  const { pr, issue } = numbers(name);
  // A fix with no PR yet moves between Assess and Code on what the checkout says and what the
  // agent is doing, which the tick knows without GitHub.
  const rewrite = !github && before.readAt && !pr && issue && !before.pr ? staged(fixWork(null, agent, coded[name] || false)) : {};
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
export async function workspaceStatuses(workspaces: { name: string; cluster?: string; preview?: boolean }[]): Promise<Record<string, WorkspaceStatus>> {
  const names = workspaces.filter((w) => (w.cluster || 'local') === 'local' && !w.preview).map((w) => w.name);

  void refreshAgents();
  void readStale(names);

  const out: Record<string, WorkspaceStatus> = {};

  for (const name of names) {
    const known = statuses.get(name) || empty();
    const agent = agents[name] || 'none';
    // The work's wording depends on the agent too, and the agent moves more often than
    // GitHub is read: a fix workspace whose agent has just gone idle says so now.
    const { pr, issue } = numbers(name);
    const rewrite = known.readAt && !pr && issue && !known.links.some((l) => l.label.startsWith('PR')) ? fixWork(null, agent, coded[name] || false) : {};

    out[name] = { ...known, ...rewrite, agent };
  }

  return out;
}
