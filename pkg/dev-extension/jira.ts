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
