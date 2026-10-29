// Jira (jira.suse.com): the SURE project's inbound customer bugs for the Rancher UI team, and
// the states the team's triage process moves them through.
//
// Lifted from the harness (claude-harness/api-service/src/jira.ts), which is where this was
// written and proven. What changed in the move is where the token lives and who holds it: the
// harness read it from `/data/config` in a container that was one person's, and here it is
// `JIRA_TOKEN` in the same per-person secret store the GitHub token lives in, read by dev-api.
//
// The calls go through dev-api rather than straight from the page, and have to: Jira Server
// sends no CORS headers, so a browser fetch fails before it leaves. The harness made the same
// choice for the same reason, and put it better - "the token never leaves this container".
import { devApi } from './reviews';

export {
  TRIAGE_ACTIONS, actionForStatus, actionForBug, jiraWorkspaceName, jiraStageOf, roleForStep
} from './jira-steps.mjs';

export const JIRA_BASE = 'https://jira.suse.com';
export const JIRA_PROJECT = 'SURE';

/** Jira's own dashboard for this queue, for the "open it where it lives" link. */
export const DASHBOARD_URL = `${ JIRA_BASE }/secure/Dashboard.jspa?selectPageId=57330`;

/**
 * Review and triage deadlines, in business days.
 *
 * Business days because the process document is explicit that weekends do not count - a bug
 * raised on Friday is not overdue on Monday. `Waiting for Reporter` has no deadline of its
 * own: those are stuck by judgement rather than by a clock, so they are surfaced without one.
 */
const REVIEW_SLA_DAYS = 3;
const TRIAGE_SLA_DAYS = 5;

export interface JiraCategory {
  id: string;
  label: string;
  /** The saved Jira filter this queue is. The filters are the team's, not ours. */
  filterId: number;
  hint: string;
  /** What the next step on a bug in this state is, or null where the state does not say. */
  action: string | null;
  needsProject: boolean;
}

/** The queues the team owns, in the order the process walks them. */
export const CATEGORIES: JiraCategory[] = [
  {
    id: 'new', label: 'New Bugs', filterId: 124181,
    hint: 'Unresolved UI team bugs still in New - review within 3 business days',
    action: 'review', needsProject: false,
  },
  {
    id: 'review', label: 'To Review', filterId: 124180,
    hint: 'In Triage: reviewed, waiting on an engineer to reproduce',
    action: 'reproduce', needsProject: true,
  },
  {
    id: 'waiting', label: 'Waiting for Reporter', filterId: 146480,
    hint: 'Parked on the reporter - watch for the ones going stale',
    action: 'unstick', needsProject: false,
  },
  {
    id: 'todo', label: 'To Do', filterId: 143481,
    hint: 'To Prioritize / Prioritized / Needs Sign Off, minus backend-blocked',
    action: 'fix', needsProject: true,
  },
  {
    // Mixed statuses, so each row gets the step its own state is waiting on.
    id: 'all', label: 'All Team Bugs', filterId: 124380,
    hint: 'Every unresolved UI team bug',
    action: null, needsProject: true,
  },
];

export interface JiraBug {
  key: string;
  url: string;
  summary: string;
  status: string;
  priority: string | null;
  assignee: { name: string; displayName: string } | null;
  reporter: string | null;
  created: string;
  updated: string;
  affectsVersions: string[];
  fixVersions: string[];
  labels: string[];
  /** Business days since it was raised. */
  ageDays: number;
  /** Past the deadline its status carries, where its status carries one. */
  overdue: boolean;
}

export interface JiraCategoryResult extends JiraCategory {
  url: string;
  total: number;
  bugs: JiraBug[];
  error?: string;
}

export interface JiraQueue {
  login: string | null;
  dashboardUrl: string;
  configured: boolean;
  categories: JiraCategoryResult[];
}

/** The fields a row needs, named so Jira does not send the whole issue for each of two hundred. */
const FIELDS = 'summary,status,assignee,reporter,created,updated,priority,versions,fixVersions,labels';

/** One Jira REST call, through dev-api, which holds the token. */
async function jira(pathAndQuery: string): Promise<Record<string, never>> {
  const { answer } = await devApi(`/jira${ pathAndQuery }`);

  return answer;
}

/**
 * Business days between then and now.
 *
 * Lifted unchanged: the deadlines in the process are business days, and counting calendar days
 * makes every bug raised on a Thursday look a day worse than it is.
 */
export function businessDaysSince(iso: string): number {
  const start = new Date(iso);

  if (Number.isNaN(start.getTime())) {
    return 0;
  }
  const cursor = new Date(start);

  cursor.setHours(0, 0, 0, 0);
  const end = new Date();

  end.setHours(0, 0, 0, 0);
  let days = 0;

  while (cursor < end) {
    cursor.setDate(cursor.getDate() + 1);
    const day = cursor.getDay();

    if (day !== 0 && day !== 6) {
      days++;
    }
  }

  return days;
}

function slaFor(status: string): number | null {
  if (status === 'New') {
    return REVIEW_SLA_DAYS;
  }

  return status === 'In Triage' ? TRIAGE_SLA_DAYS : null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toBug(issue: any): JiraBug {
  const f = issue.fields || {};
  const status = f.status?.name || 'Unknown';
  const created = f.created || '';
  const ageDays = businessDaysSince(created);
  const sla = slaFor(status);

  return {
    key:             issue.key,
    url:             `${ JIRA_BASE }/browse/${ issue.key }`,
    summary:         f.summary || '',
    status,
    priority:        f.priority?.name || null,
    assignee:        f.assignee ? { name: f.assignee.name, displayName: f.assignee.displayName || f.assignee.name } : null,
    reporter:        f.reporter?.name || null,
    created,
    updated:         f.updated || '',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    affectsVersions: (f.versions || []).map((v: any) => v.name),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    fixVersions:     (f.fixVersions || []).map((v: any) => v.name),
    labels:          f.labels || [],
    ageDays,
    overdue:         sla !== null && ageDays > sla,
  };
}

async function loadCategory(cat: JiraCategory): Promise<JiraCategoryResult> {
  const search = await jira(
    `/rest/api/2/search?jql=${ encodeURIComponent(`filter = ${ cat.filterId }`) }&maxResults=200&fields=${ FIELDS }`,
  ) as Record<string, never>;
  const issues = (search as { issues?: unknown[] }).issues || [];

  return {
    ...cat,
    url:   `${ JIRA_BASE }/issues/?filter=${ cat.filterId }`,
    total: (search as { total?: number }).total ?? issues.length,
    bugs:  issues.map(toBug),
  };
}

/**
 * The whole queue: one search per filter, in parallel.
 *
 * Five small searches rather than one big one, because the filters *are* the buckets - the team
 * maintains them in Jira - and deriving the buckets back out of a combined result would be this
 * code disagreeing with Jira about what each queue contains.
 *
 * A filter that fails takes only its own row: a saved filter somebody renamed should cost that
 * queue, not the page.
 */
export async function jiraQueue(): Promise<JiraQueue> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const me = await jira('/rest/api/2/myself').catch(() => null) as any;

  if (!me) {
    // No token, or Jira refused it. Either way there is nothing to show and saying which is the
    // settings page's job, not this one's.
    return {
      login: null, dashboardUrl: DASHBOARD_URL, configured: false, categories: [],
    };
  }

  const categories = await Promise.all(CATEGORIES.map(async(cat) => {
    try {
      return await loadCategory(cat);
    } catch (e) {
      return {
        ...cat, url: `${ JIRA_BASE }/issues/?filter=${ cat.filterId }`, total: 0, bugs: [], error: String((e as Error)?.message || e),
      };
    }
  }));

  return {
    login: me?.name || null, dashboardUrl: DASHBOARD_URL, configured: true, categories,
  };
}

/** A comment on the ticket, an attachment, the fields, and what the process says is missing. */
export interface JiraStateCheck {
  field: 'status' | 'assignee' | 'team' | 'fixVersions' | 'affectsVersions' | 'age';
  problem: string;
}

export interface JiraComment {
  id: string;
  author: string;
  created: string;
  updated: string;
  body: string;
}

export interface JiraAttachment {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  created: string;
  author: string;
  /** On dev-api, because jira.suse.com wants a bearer token no browser can attach to an <img>. */
  url: string;
}

export interface JiraDetail {
  key: string;
  url: string;
  summary: string;
  status: string;
  priority: string | null;
  assignee: string | null;
  reporter: string | null;
  created: string;
  updated: string;
  description: string;
  labels: string[];
  components: string[];
  affectsVersions: string[];
  fixVersions: string[];
  resolution: string | null;
  links: { type: string; key: string; summary: string }[];
  team: string | null;
  ageDays: number;
  checks: JiraStateCheck[];
  comments: JiraComment[];
  attachments: JiraAttachment[];
}

/** The field edits a recommendation may carry, each a separate yes or no. */
export interface JiraFieldEdits {
  team?: string | null;
  fixVersions?: string[] | null;
  affectsVersions?: string[] | null;
  labels?: string[] | null;
  resolution?: string | null;
  links?: { type: string; key: string }[] | null;
}

export interface JiraRecommendation {
  key: string;
  action: string;
  fromStatus: string | null;
  toStatus: string | null;
  assignee: string | null;
  assigneeLabel?: string;
  comment: string | null;
  reason: string | null;
  fields: JiraFieldEdits;
  attachments: { path: string; caption: string; name: string; kind: 'image' | 'video' | 'file'; workspace: string; url: string | null }[];
  github: { title: string; body: string; existing: string; labels: string[]; url: string | null; existingUrl: string | null } | null;
  blankIssueUrl: string;
  createdAt: string;
  /** When a person last corrected its prose, if they have: see amendJiraRecommendation. */
  editedAt?: string | null;
  appliedAt: string | null;
  dismissedAt: string | null;
}

export interface JiraProposal {
  key: string;
  current: {
    status: string | null;
    assignee: string | null;
    assigneeName: string | null;
    team: string | null;
    fixVersions: string[];
    affectsVersions: string[];
    labels: string[];
    resolution: string | null;
    links: string[];
  };
  recommendation: JiraRecommendation | null;
  transitions: { id: string; name: string }[];
  extras: { assignee: string | null; assigneeLabel: string; team: string | null };
  owner: { name: string; label: string };
}

/** How far a triage step has got, in the same states a review run uses. */
export interface JiraRun {
  key: string;
  action: string;
  workspace: string | null;
  state: 'starting' | 'waiting-for-sidecars' | 'running' | 'idle' | 'complete' | 'failed' | 'cancelled';
  note: string;
  startedAt: string;
  updatedAt: string;
}

export async function jiraDetail(key: string): Promise<JiraDetail> {
  return devApi(`/my-work/jira/${ encodeURIComponent(key) }/detail`);
}

/** The proposal waiting on a person, what the ticket says today, and the moves it allows. */
export async function jiraProposal(key: string): Promise<JiraProposal> {
  return devApi(`/my-work/jira/${ encodeURIComponent(key) }/recommendation`);
}

export async function jiraRun(key: string, action: string): Promise<JiraRun | null> {
  return (await devApi(`/my-work/jira/${ encodeURIComponent(key) }/run/${ encodeURIComponent(action) }`))?.run || null;
}

/**
 * Write to the ticket: the evidence, the comment, the fields, then the move.
 *
 * The one call here that changes something a customer sees, which is why it is a person pressing
 * a button and never a poll. `recommendation: false` applies without marking the pending
 * proposal as taken - for a correction made with no proposal behind it.
 *
 * `attachments` are paths under the workspace's artifacts, uploaded before anything else is
 * written. They go through the apply rather than one at a time, because a comment embedding one
 * (`!shot.png|thumbnail!`) that lands before the file renders as that markup in front of the
 * customer - see the route's own note.
 */
export async function jiraApply(key: string, change: {
  toStatus?: string | null;
  comment?: string;
  assignee?: string | null;
  recommendation?: boolean;
  attachments?: string[];
  workspace?: string;
} & JiraFieldEdits): Promise<{ ok: boolean; status: string | null; details: string[]; attached?: string[] }> {
  return devApi(`/my-work/jira/${ encodeURIComponent(key) }/apply`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(change),
  });
}

/**
 * Put right what the agent concluded, without superseding it.
 *
 * The two pieces of prose only - the reasoning and the comment the reporter will get. Filing a
 * recommendation again (`POST`) replaces the whole thing and takes the attachments and the
 * GitHub draft from the body, so a person fixing a sentence would lose the evidence they were
 * reading. See the route's own note.
 */
export async function amendJiraRecommendation(key: string, prose: { reason?: string; comment?: string }): Promise<JiraRecommendation> {
  return (await devApi(`/my-work/jira/${ encodeURIComponent(key) }/recommendation`, { method: 'PUT', body: JSON.stringify(prose) })).recommendation;
}

export async function dismissJiraRecommendation(key: string): Promise<void> {
  await devApi(`/my-work/jira/${ encodeURIComponent(key) }/recommendation/dismiss`, { method: 'POST' });
}

/** Everything written to Jira from here, newest first: what a rotation has to report. */
export async function jiraChanges(days = 30): Promise<{ days: number; changes: Record<string, never>[] }> {
  return devApi(`/my-work/jira/changes?days=${ days }`);
}

/** What this ticket's fields may be set to, and the moves its own workflow allows. */
export interface JiraOptions {
  key: string;
  transitions: { id: string; name: string }[];
  teams: string[];
  fixVersions: string[];
  affectsVersions: string[];
  labels: string[];
  resolutions: string[];
  linkTypes: string[];
  assignees: { name: string; label: string }[];
  defaults: { assignee: string; assigneeLabel: string; team: string };
}

export async function jiraOptions(key: string): Promise<JiraOptions> {
  return devApi(`/my-work/jira/${ encodeURIComponent(key) }/options`);
}

/**
 * How a comment points at an attachment, in Jira's own wiki markup.
 *
 * An image is shown where it is named; anything else - a recording, a HAR, a log - is a link,
 * because Jira will not play a video inline and a bare `!name!` for one renders as a broken
 * image. The reference is by FILENAME, which is why the upload answers with the name Jira
 * stored it under rather than with the path it came from.
 */
export function jiraEmbed(filename: string, kind = ''): string {
  const image = kind === 'image' || /\.(png|jpe?g|gif|webp)$/i.test(filename);

  return image ? `!${ filename }|thumbnail!` : `[^${ filename }]`;
}

/** Put one file from the bug's workspace onto the ticket. One at a time, deliberately. */
export async function attachToJira(key: string, path: string, workspace = ''): Promise<{ ok: boolean; filename: string }> {
  return devApi(`/my-work/jira/${ encodeURIComponent(key) }/attach`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path, workspace }),
  });
}
