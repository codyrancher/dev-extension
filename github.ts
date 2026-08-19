/**
 * What GitHub is asked for My Work, and what comes back.
 *
 * From the browser, not from a pod. A page served through Rancher's service proxy can talk to
 * api.github.com directly: it answers with `access-control-allow-origin: *`, and a request
 * carrying an Authorization header survives its CORS preflight. So there is no server of ours in
 * this path, and the token never leaves the person's own browser except to GitHub.
 *
 * GraphQL rather than the REST search API, and that is not a preference. My Work wants, per pull
 * request: the CI verdict, how many checks are failing, the issue it closes, and whether you have
 * reviewed it. Over REST that is a search, then a fetch per PR for its head commit, then a fetch
 * per commit for its checks, then a fetch per PR for its reviews - somewhere over sixty requests
 * for two lists of twenty. Here it is one.
 */
import { githubToken } from './api';

const ENDPOINT = 'https://api.github.com/graphql';

/** How many of each list to ask for. The harness shows about this many and it fits a screen. */
const PAGE = 25;

/**
 * Issues are asked for in bulk, because they are paged five at a time on the page itself.
 *
 * Thirty-one assigned issues is an ordinary number and a person scrolls through them; asking for
 * twenty-five and drawing "1 of 4 pages" over a list that is missing the rest would be a lie the
 * page tells about its own paging.
 */
const ISSUE_PAGE = 100;

/**
 * The checks on the head commit.
 *
 * `state` is GitHub's own rollup - SUCCESS, PENDING, FAILURE, ERROR - which is what the tick or
 * the cross is. The counts are worked out here rather than asked for, because GitHub counts check
 * runs by *status* (queued, in progress, completed) and what a person wants to know is how many
 * came back red, which is a conclusion. A run with no conclusion has not finished, so it is
 * pending; a status context has no conclusion at all and reports a state instead.
 */
export interface GithubChecks {
  state: string;
  failing: number;
  pending: number;
  total: number;
}

/** What a Rerun needs: the workflow runs behind the failing checks. */
export interface GithubRun {
  id: number;
  url: string;
}

export interface GithubPr {
  /** Unique across both lists and across repositories, which the number alone is not. */
  key: string;
  number: number;
  url: string;
  title: string;
  repo: string;
  draft: boolean;
  /** Whether the review the PR is waiting on has been given, from GitHub's own decision. */
  approved: boolean;
  /** The issue this closes, where the PR says so. Null is the ordinary case, not an error. */
  issue: { number: number; url: string } | null;
  checks: GithubChecks | null;
  /** The failing workflow runs, which is what Rerun acts on. Empty when nothing is red. */
  runs: GithubRun[];
  updatedAt: string;
  /** When you last reviewed it, for the list of things waiting on you. '' when you never have. */
  reviewedAt: string;
  /** The last comment on it, which is the other clock a person watches. */
  commentedAt: string;
}

/** One issue assigned to you, which is the other half of what a person comes to My Work for. */
export interface GithubIssue {
  key: string;
  number: number;
  url: string;
  title: string;
  repo: string;
  /** The labels, which is what the harness calls Area. */
  labels: string[];
  createdAt: string;
}

/**
 * One Dependabot advisory, with every alert it raised folded into it.
 *
 * GitHub reports an alert per package per manifest, so one advisory about a transitive
 * dependency arrives three times for a repository with three lockfiles. What a person acts on is
 * the advisory, and how many files it touches is a number on it rather than three rows.
 */
export interface GithubAlert {
  key: string;
  severity: string;
  summary: string;
  ghsa: string;
  cve: string;
  packages: string[];
  url: string;
  /** How many alerts, and how many distinct manifests they are in. */
  alerts: number;
  files: number;
  /** The version that fixes it, or '' when there is not one yet. */
  patched: string;
}

export interface GithubWork {
  login: string;
  /** Waiting on you: review requested, or reviewed by you and still open. */
  reviewing: GithubPr[];
  mine: GithubPr[];
  issues: GithubIssue[];
}

/**
 * The one query.
 *
 * `latestReviews` rather than a review filtered by author, because filtering needs the login and
 * the login is in the same response: asking for the last few and picking yours out here costs one
 * round trip fewer than asking twice.
 */
const QUERY = `
  fragment pr on PullRequest {
    number
    title
    url
    isDraft
    updatedAt
    repository { nameWithOwner }
    reviewDecision
    closingIssuesReferences(first: 1) { nodes { number url } }
    latestReviews(first: 20) { nodes { author { login } submittedAt } }
    comments(last: 1) { nodes { createdAt } }
    commits(last: 1) {
      nodes {
        commit {
          statusCheckRollup {
            state
            contexts(first: 100) {
              totalCount
              nodes {
                __typename
                ... on CheckRun {
                  conclusion
                  # The workflow run this check belongs to, which is what a rerun acts on: GitHub
                  # reruns a run, not a check. The databaseId, because the REST endpoint that does
                  # it takes a number and a node id is not one.
                  checkSuite { workflowRun { databaseId url } }
                }
                ... on StatusContext { state }
              }
            }
          }
        }
      }
    }
  }

  query MyWork($page: Int!, $issues: Int!) {
    viewer { login }
    reviewing: search(query: "is:open is:pr review-requested:@me archived:false", type: ISSUE, first: $page) {
      nodes { ...pr }
    }
    reviewed: search(query: "is:open is:pr reviewed-by:@me archived:false", type: ISSUE, first: $page) {
      nodes { ...pr }
    }
    mine: search(query: "is:open is:pr author:@me archived:false", type: ISSUE, first: $page) {
      nodes { ...pr }
    }
    issues: search(query: "is:open is:issue assignee:@me archived:false", type: ISSUE, first: $issues) {
      nodes {
        ... on Issue {
          number
          title
          url
          createdAt
          repository { nameWithOwner }
          labels(first: 10) { nodes { name } }
        }
      }
    }
  }
`;

interface Json { [key: string]: any }

/** The checks on one PR, or null where GitHub has nothing to say about it. */
function checksOf(node: Json): GithubChecks | null {
  const rollup = node.commits?.nodes?.[0]?.commit?.statusCheckRollup;

  if (!rollup) {
    return null;
  }

  const contexts: Json[] = rollup.contexts?.nodes || [];
  let failing = 0;
  let pending = 0;

  for (const context of contexts) {
    // A check run reports a conclusion once it has one; until then it is still running. A status
    // context has no conclusion and reports a state instead, where PENDING means the same thing.
    const outcome = context.__typename === 'CheckRun' ? context.conclusion : context.state;

    if (!outcome || outcome === 'PENDING') {
      pending += 1;
    } else if (outcome === 'FAILURE' || outcome === 'ERROR' || outcome === 'TIMED_OUT' || outcome === 'CANCELLED') {
      failing += 1;
    }
  }

  return {
    state: rollup.state || '', failing, pending, total: rollup.contexts?.totalCount || contexts.length
  };
}

/**
 * The workflow runs behind a PR's failing checks, deduplicated.
 *
 * One rerun covers every failing job in a run, so a PR with four red jobs in one workflow is one
 * button and not four. A PR whose failures are in two workflows is two runs, and rerunning is
 * both.
 */
function failedRuns(node: Json): GithubRun[] {
  const contexts: Json[] = node.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts?.nodes || [];
  const runs = new Map<number, GithubRun>();

  for (const context of contexts) {
    const failed = context.__typename === 'CheckRun' &&
      ['FAILURE', 'TIMED_OUT', 'CANCELLED', 'STARTUP_FAILURE'].includes(context.conclusion);
    const run = context.checkSuite?.workflowRun;

    if (failed && run?.databaseId) {
      runs.set(run.databaseId, { id: run.databaseId, url: run.url });
    }
  }

  return [...runs.values()];
}

function prFrom(node: Json, login: string): GithubPr {
  const repo = node.repository?.nameWithOwner || '';
  const mine = (node.latestReviews?.nodes || []).find((review: Json) => review.author?.login === login);

  return {
    key:         `${ repo }#${ node.number }`,
    number:      node.number,
    url:         node.url,
    title:       node.title,
    repo,
    draft:       !!node.isDraft,
    approved:    node.reviewDecision === 'APPROVED',
    issue:       node.closingIssuesReferences?.nodes?.[0] || null,
    checks:      checksOf(node),
    runs:        failedRuns(node),
    updatedAt:   node.updatedAt || '',
    reviewedAt:  mine?.submittedAt || '',
    commentedAt: node.comments?.nodes?.[0]?.createdAt || '',
  };
}

function issueFrom(node: Json): GithubIssue {
  const repo = node.repository?.nameWithOwner || '';

  return {
    key:       `${ repo }#${ node.number }`,
    number:    node.number,
    url:       node.url,
    title:     node.title,
    repo,
    labels:    (node.labels?.nodes || []).map((label: Json) => label.name),
    createdAt: node.createdAt || '',
  };
}

/**
 * The open Dependabot alerts on one repository, folded by advisory.
 *
 * REST rather than GraphQL: `vulnerabilityAlerts` on the GraphQL side needs the same permission
 * and returns the same thing in a shape that still has to be folded, and this is one request
 * either way. It is a separate request from the rest of My Work because it is about a repository
 * rather than about a person.
 *
 * A token without access to a repository's security tab gets a 403 here, which is not an error
 * worth stopping the page for: the section says it cannot see them and the rest still renders.
 */
export async function dependabotAlerts(repo: string): Promise<GithubAlert[]> {
  const token = await githubToken();

  if (!token || !repo) {
    return [];
  }

  const response = await fetch(`https://api.github.com/repos/${ repo }/dependabot/alerts?state=open&per_page=100`, {
    headers: { authorization: `Bearer ${ token }`, accept: 'application/vnd.github+json' },
  });

  if (!response.ok) {
    throw new Error(response.status === 403
      ? `The token cannot read ${ repo }'s Dependabot alerts. That needs a token with security_events, and access to that repository's security tab.`
      : `GitHub answered ${ response.status } for ${ repo }'s Dependabot alerts.`);
  }

  const alerts: Json[] = await response.json();
  const byAdvisory = new Map<string, GithubAlert & { manifests: Set<string>; names: Set<string> }>();

  for (const alert of alerts) {
    const advisory = alert.security_advisory || {};
    const key = advisory.ghsa_id || String(alert.number);
    const found = byAdvisory.get(key) || {
      key,
      severity: advisory.severity || '',
      summary:  advisory.summary || '',
      ghsa:     advisory.ghsa_id || '',
      cve:      advisory.cve_id || '',
      packages: [],
      // The advisory's own page on the repository, which is where a person goes to read it.
      url:      alert.html_url || '',
      alerts:   0,
      files:    0,
      patched:  alert.security_vulnerability?.first_patched_version?.identifier || '',
      manifests: new Set<string>(),
      names:     new Set<string>(),
    };

    found.alerts += 1;
    found.manifests.add(alert.dependency?.manifest_path || '');
    found.names.add(alert.dependency?.package?.name || '');
    byAdvisory.set(key, found);
  }

  return [...byAdvisory.values()].map((entry) => ({
    ...entry,
    files:    entry.manifests.size,
    packages: [...entry.names].filter(Boolean),
  }));
}

/**
 * Ask GitHub to run the failed jobs again.
 *
 * `rerun-failed-jobs` rather than `rerun`, which is the difference between running the two that
 * went red and running all fifty again. It is a REST call because there is no mutation for it,
 * and it answers 201 with no body.
 */
export async function rerunFailed(repo: string, run: GithubRun): Promise<void> {
  const token = await githubToken();
  const response = await fetch(`https://api.github.com/repos/${ repo }/actions/runs/${ run.id }/rerun-failed-jobs`, {
    method:  'POST',
    headers: { authorization: `Bearer ${ token }`, accept: 'application/vnd.github+json' },
  });

  if (!response.ok) {
    const body = await response.json().catch(() => ({}));

    throw new Error(body.message || `GitHub answered ${ response.status }.`);
  }
}

/**
 * Both lists, and who you are.
 *
 * The two searches behind `reviewing` are one list to a person: a pull request stops being
 * review-requested the moment you review it, and one you have reviewed and are waiting on is
 * still yours to watch. GitHub has no single query for the union, so it is two and a merge.
 */
export async function myWork(): Promise<GithubWork> {
  const token = await githubToken();

  if (!token) {
    throw new Error('No GitHub token is set. Add one in Settings.');
  }

  const response = await fetch(ENDPOINT, {
    method:  'POST',
    headers: {
      authorization:  `Bearer ${ token }`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ query: QUERY, variables: { page: PAGE, issues: ISSUE_PAGE } }),
  });

  if (!response.ok) {
    // 401 is the one worth naming: a token that has expired or been revoked looks exactly like a
    // token that was never set unless the page says which.
    throw new Error(response.status === 401
      ? 'GitHub rejected the token. It may have expired, or it may not have the repo scope.'
      : `GitHub answered ${ response.status }.`);
  }

  const body = await response.json();

  // A GraphQL error is a 200 with an errors array, so this is the only place a bad query or a
  // missing scope surfaces at all.
  if (body.errors?.length) {
    throw new Error(body.errors.map((error: Json) => error.message).join(' '));
  }

  const login = body.data?.viewer?.login || '';
  const seen = new Set<string>();
  const reviewing: GithubPr[] = [];

  for (const node of [...(body.data?.reviewing?.nodes || []), ...(body.data?.reviewed?.nodes || [])]) {
    const pr = prFrom(node, login);

    // The two searches overlap by design. First one wins, which is the review-requested one.
    if (!seen.has(pr.key)) {
      seen.add(pr.key);
      reviewing.push(pr);
    }
  }

  return {
    login,
    reviewing,
    mine:   (body.data?.mine?.nodes || []).map((node: Json) => prFrom(node, login)),
    issues: (body.data?.issues?.nodes || []).map(issueFrom),
  };
}
