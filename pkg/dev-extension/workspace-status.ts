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
    agent: 'none', label: '', tone: 'muted', title: '', links: [], readAt: 0, kind: 'other', stage: '', pr: 0,
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
function reviewWork(d: Json, agent: AgentState): Pick<WorkspaceStatus, 'label' | 'tone' | 'stage'> {
  const m = d.meta || {};
  const local: Json[] = d.localComments || [];
  const submitted = local.filter((c) => c.submitted_at);
  const pending = local.filter((c) => !c.submitted_at);
  // A review YOU left on GitHub itself counts as submitted too - but only yours. Counting
  // anyone's put the stage back to "waiting for the developer" the moment a bot approved the
  // PR, days after the developer had answered.
  const viewer = d.viewer || '';
  const reviews: Json[] = (d.reviews || []).filter((r: Json) => r.submittedAt && (viewer ? r.author === viewer : r.author && r.author !== m.author && !isBot(r.author)));

  if (m.merged) {
    return { label: 'Merged', tone: 'green', stage: 'approved' };
  }
  if (m.approved) {
    return { label: 'Approved', tone: 'green', stage: 'approved' };
  }
  if (submitted.length || reviews.length) {
    const submittedAt = Math.max(latest(submitted.map((c) => c.submitted_at)), latest(reviews.map((r: Json) => r.submittedAt)));
    const pushed = latest((d.commits || []).map((c: Json) => c.date)) > submittedAt;
    const replied = latest([...(d.discussion || []), ...(d.reviewComments || [])].filter((c: Json) => c.author === m.author).map((c: Json) => c.createdAt)) > submittedAt;

    if (pushed || replied) {
      return { label: pushed ? 'Developer pushed: review again' : 'Developer replied', tone: 'attention', stage: 'response' };
    }

    return { label: 'Waiting for the developer', tone: 'waiting', stage: 'submitted' };
  }
  if (agent === 'working') {
    return { label: 'Agent reviewing', tone: 'working', stage: 'agent' };
  }
  if (pending.length) {
    return { label: 'Review the agent\'s findings', tone: 'attention', stage: 'findings' };
  }
  if (agent === 'input') {
    return { label: 'Agent needs an answer', tone: 'attention', stage: 'agent' };
  }

  return { label: 'Not reviewed yet', tone: 'muted', stage: 'agent' };
}

/**
 * A fix workspace (`issue-<n>`): the agent writes the code and opens a PR the person owns.
 *
 * Without a PR the agent is the story. With one: a draft is the person's to read and mark
 * ready (the skills never do), a review from someone else after the last push is theirs to
 * answer, and otherwise the PR waits for a reviewer.
 */
function fixWork(d: Json | null, agent: AgentState, coded = false): Pick<WorkspaceStatus, 'label' | 'tone' | 'stage'> {
  if (!d) {
    // Before a PR the branch says which of the first two stages this is: commits on it mean the
    // code is being written (or is written); none, and the agent is still assessing.
    const stage: FixStage = coded ? 'code' : 'assess';

    if (agent === 'working') {
      return { label: coded ? 'Working on the code' : 'Assessing the issue', tone: 'working', stage };
    }
    if (agent === 'input') {
      return { label: 'Agent needs an answer', tone: 'attention', stage };
    }

    return { label: coded ? 'Code written, no PR yet' : 'No PR yet', tone: 'muted', stage };
  }
  const m = d.meta || {};

  if (m.merged) {
    return { label: 'Merged', tone: 'green', stage: 'merged' };
  }
  if (m.approved) {
    return { label: 'Approved', tone: 'green', stage: 'merged' };
  }
  const comments: Json[] = [...(d.discussion || []), ...(d.reviewComments || [])];
  const others = latest(comments.filter((c) => c.author && c.author !== m.author && !isBot(c.author)).map((c) => c.createdAt));
  const mine = Math.max(latest(comments.filter((c) => c.author === m.author).map((c) => c.createdAt)), latest((d.commits || []).map((c: Json) => c.date)));

  if (others > mine) {
    return { label: 'Respond to the review', tone: 'attention', stage: 'feedback' };
  }
  if (agent === 'working') {
    return { label: 'Agent working on the PR', tone: 'working', stage: m.draft ? 'draft' : 'review' };
  }
  if (m.draft) {
    return { label: 'Draft PR: read it and mark it ready', tone: 'attention', stage: 'draft' };
  }
  if (m.state === 'CLOSED') {
    return { label: 'PR closed', tone: 'muted', stage: 'merged' };
  }

  return { label: 'Waiting for a review', tone: 'waiting', stage: 'review' };
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
      ...reviewWork(d, agent), title: d.meta?.title || '', links, kind: 'review', pr,
    };
  }
  if (issue) {
    const n = await linkedPullRequest(DEFAULT_REPO, issue).catch(() => 0);
    const d = n ? await prDetail(n) : null;

    if (n) {
      links.push({ label: `PR #${ n }`, url: d?.meta?.url || `https://github.com/${ DEFAULT_REPO }/pull/${ n }` });
    }

    return {
      ...fixWork(d, agent, coded[name] || false), title: d?.meta?.title || '', links, kind: 'fix', pr: n,
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
  const rewrite = !github && before.readAt && !pr && issue && !before.pr ? fixWork(null, agent, coded[name] || false) : {};
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
