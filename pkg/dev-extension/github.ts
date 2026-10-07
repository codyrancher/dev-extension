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

/**
 * The repository the unassigned search is scoped to.
 *
 * Its own constant rather than `DEFAULT_REPO` from reviews.ts, which imports this file - taking it
 * from there would close a cycle. The searches above need no repository because `assignee:@me` and
 * `author:@me` mean something on their own; `no:assignee` does not.
 */
const POOL_REPO = 'rancher/dashboard';

/**
 * Which repositories the queue is allowed to look in.
 *
 * `assignee:@me` and `author:@me` mean something across the whole of GitHub, which is the reason
 * these four searches never carried a repository - and the reason the deck filled with work from
 * repositories nobody wanted to see. A scope is a list of `owner/name`; GitHub ORs repeated
 * `repo:` qualifiers, so `repo:a/b repo:c/d` is "either of these".
 *
 * In the query rather than a filter over the results, because a filter asks GitHub for everything
 * and throws most of it away: the page size is 25 per search, so an unscoped search can fill all
 * 25 with work from elsewhere and the ones that matter never arrive at all. Scoping the query is
 * the difference between a short list and a wrong one.
 *
 * Empty means every repository, which is what it did before and the right default for somebody
 * who has not said otherwise.
 */
export function repoScope(repos: string[] | undefined): string {
  const clean = (repos || [])
    .map((repo) => String(repo || '').trim())
    .filter((repo) => /^[\w.-]+\/[\w.-]+$/.test(repo));

  return clean.length ? `${ clean.map((repo) => `repo:${ repo }`).join(' ') } ` : '';
}

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
  /** The PR author's GitHub login, for the reviewer table where the PR is somebody else's. */
  author: string;
  draft: boolean;
  /** Whether the review the PR is waiting on has been given, from GitHub's own decision. */
  approved: boolean;
  /**
   * GitHub's own decision, unreduced: `APPROVED`, `CHANGES_REQUESTED`, `REVIEW_REQUIRED` or ''.
   *
   * `approved` is this flattened to a boolean, which cannot tell "nobody has decided" from "the
   * change was asked for and not yet given" - and the difference is whether a pull request is
   * blocked on the reader. The queue needs the second one; see `reviewing-pushed`.
   */
  reviewDecision: string;
  /** The issue this closes, where the PR says so. Null is the ordinary case, not an error. */
  issue: { number: number; url: string } | null;
  /**
   * How big the change is, which the search that built the queue already knows.
   *
   * Here so a card wanting the fact strip does not read the pull request for three integers it
   * has already been told. Null only if GitHub did not answer with them.
   */
  stat: { files: number; added: number; removed: number } | null;
  checks: GithubChecks | null;
  /** The failing workflow runs, which is what Rerun acts on. Empty when nothing is red. */
  runs: GithubRun[];
  /** When it was opened, for age. */
  createdAt: string;
  updatedAt: string;
  /** When its head commit was pushed, for "has it changed since I reviewed" without counting comments as changes. '' if unknown. */
  pushedAt: string;
  /** When you last reviewed it, for the list of things waiting on you. '' when you never have. */
  reviewedAt: string;
  /** Who has been asked for a review: logins, and team names for a team request. */
  reviewers: string[];
  /** The description, as much of it as matters for telling whether there is one. */
  body: string;
  /**
   * Whether GitHub is currently asking *you* for a review (the `review-requested:@me` search).
   * True the first time you are added, and again when a reviewer re-requests you after changes -
   * so it is the strongest "this wants me now" signal the list has. A PR you reviewed and are
   * only waiting on is false.
   */
  reviewRequested: boolean;
  /** The last comment on it, which is the other clock a person watches. */
  commentedAt: string;
}

/** One issue assigned to you, which is the other half of what a person comes to My Work for. */
/** Where an issue sits on its GitHub project board: the board's "Status" single-select field. */
export interface GithubBoardStatus {
  name: string;
  /** The board's own colour for that column: GRAY, BLUE, GREEN, YELLOW, ORANGE, RED, PINK or PURPLE. */
  color: string;
  project: string;
  url: string;
}

export interface GithubIssue {
  key: string;
  number: number;
  url: string;
  title: string;
  repo: string;
  /** The labels, which is what the harness calls Area. */
  labels: string[];
  createdAt: string;
  /** Null when the issue is on no board - or when the token cannot read boards; see GithubWork. */
  projectStatus: GithubBoardStatus | null;
  /** How much has been said on it, which is the cheapest signal of whether it is well specified. */
  comments?: number;
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
  /**
   * Why every issue came back without a board status, when that is the reason. Reading a
   * board's fields needs the read:project scope, which a token scoped for repositories alone
   * does not have - and that is a missing scope, not an empty board.
   */
  projectStatusError: string;
  /** Waiting on you: review requested, or reviewed by you and still open. */
  reviewing: GithubPr[];
  mine: GithubPr[];
  issues: GithubIssue[];
  /** Open issues in this repository that nobody has taken. The pool to pick the next one from. */
  unassigned: GithubIssue[];
}

/**
 * The one query.
 *
 * `latestReviews` rather than a review filtered by author, because filtering needs the login and
 * the login is in the same response: asking for the last few and picking yours out here costs one
 * round trip fewer than asking twice.
 */
const QUERY_FOR = (scope: string) => `
  fragment pr on PullRequest {
    number
    title
    url
    isDraft
    createdAt
    updatedAt
    # The fact strip's three numbers, on the request that is already being made. Every card
    # wanting a stat used to read the whole pull request for them - see readArtifacts.
    # No backticks in here: this fragment lives in a template literal.
    changedFiles
    additions
    deletions
    author { login }
    repository { nameWithOwner }
    reviewDecision
    # Whether anybody has been asked to look at it. A pull request of yours that is green and
    # that nobody has been asked about is not waiting on review; it is waiting on you to ask.
    reviewRequests(first: 10) {
      nodes { requestedReviewer { __typename ... on User { login } ... on Team { name } } }
    }
    # The first part of the description, for telling a pull request that says what it does from
    # one that says nothing. Truncated here rather than fetched whole: this query asks for fifty
    # of them and only the length and the first lines are ever read.
    bodyText
    closingIssuesReferences(first: 1) { nodes { number url } }
    latestReviews(first: 20) { nodes { author { login } submittedAt } }
    comments(last: 1) { nodes { createdAt } }
    commits(last: 1) {
      nodes {
        commit {
          committedDate
          statusCheckRollup {
            state
            contexts(first: 100) {
              totalCount
              nodes {
                __typename
                ... on CheckRun {
                  # name and the timestamps are what dedupes superseded re-runs down to the
                  # latest attempt per check (see latestContexts); without them the rollup's
                  # historical runs are all counted and a re-run-to-green still reads as red.
                  name
                  conclusion
                  startedAt
                  completedAt
                  # The workflow run this check belongs to, which is what a rerun acts on: GitHub
                  # reruns a run, not a check. The databaseId, because the REST endpoint that does
                  # it takes a number and a node id is not one.
                  checkSuite { workflowRun { databaseId url } }
                }
                ... on StatusContext { context state createdAt }
              }
            }
          }
        }
      }
    }
  }

  query MyWork($page: Int!, $issues: Int!) {
    viewer { login }
    reviewing: search(query: "${ scope }is:open is:pr review-requested:@me archived:false", type: ISSUE, first: $page) {
      nodes { ...pr }
    }
    reviewed: search(query: "${ scope }is:open is:pr reviewed-by:@me archived:false", type: ISSUE, first: $page) {
      nodes { ...pr }
    }
    mine: search(query: "${ scope }is:open is:pr author:@me archived:false", type: ISSUE, first: $page) {
      nodes { ...pr }
    }
    # Work nobody has picked up, in the repository this product is for.
    #
    # Scoped to the repository, unlike the searches above: assignee:@me means something across
    # all of GitHub and no:assignee means nothing. Newest first, because an issue nobody has
    # taken in two years is not a thing anybody is about to take now.
    #
    # No backticks anywhere in this query. It is a JavaScript template literal, so one ends the
    # string, and the error it produces names a line thirty lines further down.
    unassigned: search(query: "repo:${ POOL_REPO } is:open is:issue no:assignee archived:false sort:created-desc", type: ISSUE, first: $issues) {
      nodes {
        ... on Issue {
          number
          title
          url
          createdAt
          repository { nameWithOwner }
          labels(first: 10) { nodes { name } }
          comments { totalCount }
        }
      }
    }
    issues: search(query: "${ scope }is:open is:issue assignee:@me archived:false", type: ISSUE, first: $issues) {
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

/**
 * The head commit's checks, one entry per name: its most recent attempt.
 *
 * GitHub's statusCheckRollup lists every check run on the commit, superseded ones included - a
 * re-run adds a new CheckRun beside the old one, and a status context that was posted red and
 * then green keeps both. So a PR whose checks are now all green still carries its old red runs
 * here, and counting the raw list reports failures that no longer exist (thirteen red on a PR the
 * checks UI shows entirely green). The list is reduced to the latest attempt of each named check,
 * by the timestamp GitHub gives it, before anything is counted.
 */
function latestContexts(node: Json): Json[] {
  const contexts: Json[] = node.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts?.nodes || [];
  const latest = new Map<string, { at: string; context: Json }>();

  for (const context of contexts) {
    const name = context.name || context.context || '';
    const at = context.completedAt || context.startedAt || context.createdAt || '';
    const seen = latest.get(name);

    if (!seen || at >= seen.at) {
      latest.set(name, { at, context });
    }
  }

  return [...latest.values()].map((entry) => entry.context);
}

/** The checks on one PR, or null where GitHub has nothing to say about it. */
function checksOf(node: Json): GithubChecks | null {
  const rollup = node.commits?.nodes?.[0]?.commit?.statusCheckRollup;

  if (!rollup) {
    return null;
  }

  const contexts = latestContexts(node);
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

  // Derived from the deduped counts, not from rollup.state: GitHub's own rollup verdict lags for
  // status contexts re-posted green after a red, so a PR whose every latest check is green can
  // read FAILURE there for a while. The counts are the truth the checks UI shows.
  const state = failing ? 'FAILURE' : pending ? 'PENDING' : 'SUCCESS';

  return {
    state, failing, pending, total: contexts.length
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
  const runs = new Map<number, GithubRun>();

  for (const context of latestContexts(node)) {
    const failed = context.__typename === 'CheckRun' &&
      ['FAILURE', 'TIMED_OUT', 'CANCELLED', 'STARTUP_FAILURE'].includes(context.conclusion);
    const run = context.checkSuite?.workflowRun;

    if (failed && run?.databaseId) {
      runs.set(run.databaseId, { id: run.databaseId, url: run.url });
    }
  }

  return [...runs.values()];
}

function prFrom(node: Json, login: string, reviewRequested = false): GithubPr {
  const repo = node.repository?.nameWithOwner || '';
  const mine = (node.latestReviews?.nodes || []).find((review: Json) => review.author?.login === login);

  return {
    key:             `${ repo }#${ node.number }`,
    number:          node.number,
    url:             node.url,
    title:           node.title,
    repo,
    author:          node.author?.login || '',
    draft:           !!node.isDraft,
    stat:            node.changedFiles === undefined || node.changedFiles === null
      ? null
      : { files: node.changedFiles || 0, added: node.additions || 0, removed: node.deletions || 0 },
    approved:        node.reviewDecision === 'APPROVED',
    reviewDecision:  node.reviewDecision || '',
    issue:           node.closingIssuesReferences?.nodes?.[0] || null,
    checks:          checksOf(node),
    runs:            failedRuns(node),
    createdAt:       node.createdAt || '',
    updatedAt:       node.updatedAt || '',
    pushedAt:        node.commits?.nodes?.[0]?.commit?.committedDate || '',
    reviewedAt:      mine?.submittedAt || '',
    reviewRequested,
    commentedAt:     node.comments?.nodes?.[0]?.createdAt || '',
    reviewers:       (node.reviewRequests?.nodes || [])
      .map((row: Json) => row.requestedReviewer?.login || row.requestedReviewer?.name || '')
      .filter(Boolean),
    // Enough to tell a description from the absence of one. A thousand characters is well past
    // any threshold anything here applies, and keeps fifty of these out of the way.
    body:            String(node.bodyText || '').slice(0, 1000),
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
    labels:        (node.labels?.nodes || []).map((label: Json) => label.name),
    createdAt:     node.createdAt || '',
    projectStatus: null,
    comments:      node.comments?.totalCount ?? undefined,
  };
}

/**
 * The board status of each assigned issue, by issue key.
 *
 * A query of its own rather than fields on the main one, because board fields sit behind the
 * read:project scope and GitHub fails a whole query for a token without it - assigned issues,
 * review queue and all. Asked separately, a missing scope costs the one column. An issue can be
 * on more than one board; the first with a status set is the one worth showing.
 */
const STATUS_QUERY_FOR = (scope: string) => `
  query IssueStatuses($issues: Int!) {
    issues: search(query: "${ scope }is:open is:issue assignee:@me archived:false", type: ISSUE, first: $issues) {
      nodes {
        ... on Issue {
          number
          repository { nameWithOwner }
          projectItems(first: 5) {
            nodes {
              project { title url }
              fieldValueByName(name: "Status") {
                ... on ProjectV2ItemFieldSingleSelectValue { name color }
              }
            }
          }
        }
      }
    }
  }
`;

async function issueStatuses(repos?: string[]): Promise<Map<string, GithubBoardStatus>> {
  const data = await graphql(STATUS_QUERY_FOR(repoScope(repos)), { issues: ISSUE_PAGE });
  const found = new Map<string, GithubBoardStatus>();

  for (const node of data.issues?.nodes || []) {
    if (!node?.number) {
      continue;
    }

    for (const item of node.projectItems?.nodes || []) {
      const value = item?.fieldValueByName;

      if (value?.name) {
        found.set(`${ node.repository?.nameWithOwner || '' }#${ node.number }`, {
          name:    value.name,
          color:   value.color || 'GRAY',
          project: item.project?.title || '',
          url:     item.project?.url || '',
        });
        break;
      }
    }
  }

  return found;
}

/**
 * Move an issue's board Status to the first of `wanted` its board actually offers.
 *
 * The read side (issueStatuses) only names the status; setting it needs the ids a
 * `updateProjectV2ItemFieldValue` mutation takes - the project, the item, the Status field and
 * the option to set - so this fetches them for the one issue and then writes. Matching is on the
 * option name, case-insensitive, because a board names its "working" column whatever it likes.
 *
 * Returns the status that was set, or null when the issue is on no board with a Status field, or
 * none of `wanted` is one of that field's options - both ordinary outcomes, not errors. Writing a
 * project field needs the token's `project` scope; a token without it makes the mutation throw,
 * which the caller (Start fix) swallows so the fix still starts.
 */
const ISSUE_STATUS_FIELDS_QUERY = `
  query IssueStatusFields($owner: String!, $name: String!, $number: Int!) {
    repository(owner: $owner, name: $name) {
      issue(number: $number) {
        projectItems(first: 10) {
          nodes {
            id
            project {
              id
              title
              url
              field(name: "Status") {
                ... on ProjectV2SingleSelectField { id options { id name color } }
              }
            }
          }
        }
      }
    }
  }
`;

const SET_ISSUE_STATUS_MUTATION = `
  mutation SetIssueStatus($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {
    updateProjectV2ItemFieldValue(input: {
      projectId: $projectId, itemId: $itemId, fieldId: $fieldId,
      value: { singleSelectOptionId: $optionId }
    }) { projectV2Item { id } }
  }
`;

export async function setIssueStatus(repo: string, number: number, wanted: string[] = ['working', 'in progress']): Promise<GithubBoardStatus | null> {
  const targets = wanted.map((name) => name.toLowerCase());
  const data = await graphql(ISSUE_STATUS_FIELDS_QUERY, { ...splitRepo(repo), number });
  const items: Json[] = data.repository?.issue?.projectItems?.nodes || [];

  for (const item of items) {
    const field = item.project?.field;
    const option = (field?.options || []).find((candidate: Json) => targets.includes(String(candidate.name).toLowerCase()));

    if (!field?.id || !option) {
      continue;
    }

    await graphql(SET_ISSUE_STATUS_MUTATION, {
      projectId: item.project.id, itemId: item.id, fieldId: field.id, optionId: option.id,
    });

    return {
      name: option.name, color: option.color || 'GRAY', project: item.project.title || '', url: item.project.url || '',
    };
  }

  return null;
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
export async function myWork(repos?: string[]): Promise<GithubWork> {
  const token = await githubToken();

  if (!token) {
    throw new Error('No GitHub token is set. Add one in Settings.');
  }

  /*
   * The board statuses, started now rather than after the search below has been read.
   *
   * These were two serial round trips to GitHub: this query, and then `issueStatuses`. The second
   * needs nothing from the first - it is annotating issues by key, and it runs its own search - so
   * the only thing making it second was the `await`. Measured on a cold deck: nine GraphQL calls
   * totalling 12.5s, at the head of a chain that is already four deep.
   *
   * Its rejection is handled where it is awaited, below. The idle `catch` here is only so a
   * failure that lands before then is not an unhandled rejection.
   */
  const statusesSoon = issueStatuses(repos);

  statusesSoon.catch(() => undefined);

  const response = await fetch(ENDPOINT, {
    method:  'POST',
    headers: {
      authorization:  `Bearer ${ token }`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ query: QUERY_FOR(repoScope(repos)), variables: { page: PAGE, issues: ISSUE_PAGE } }),
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

  // Two searches, tagged by which one a PR came from. `reviewing` is `review-requested:@me` -
  // GitHub is asking you now - and `reviewed` is `reviewed-by:@me` still open, which you are only
  // waiting on. A PR in both is a re-review (you reviewed it, then were requested again); the
  // request wins, so it is listed first and carries reviewRequested: true.
  for (const [node, requested] of [
    ...(body.data?.reviewing?.nodes || []).map((n: Json) => [n, true] as const),
    ...(body.data?.reviewed?.nodes || []).map((n: Json) => [n, false] as const),
  ]) {
    const pr = prFrom(node, login, requested);

    if (!seen.has(pr.key)) {
      seen.add(pr.key);
      reviewing.push(pr);
    }
  }

  const issues: GithubIssue[] = (body.data?.issues?.nodes || []).map(issueFrom);
  let projectStatusError = '';

  try {
    const statuses = await statusesSoon;

    issues.forEach((issue) => {
      issue.projectStatus = statuses.get(issue.key) || null;
    });
  } catch (e: any) { // eslint-disable-line @typescript-eslint/no-explicit-any
    projectStatusError = /read:project/.test(String(e?.message))
      ? 'The GitHub token needs the read:project scope to show board status.'
      : `Board status unavailable: ${ String(e?.message || e).slice(0, 200) }`;
  }

  return {
    login,
    reviewing,
    mine: (body.data?.mine?.nodes || []).map((node: Json) => prFrom(node, login)),
    issues,
    unassigned: (body.data?.unassigned?.nodes || []).map(issueFrom),
    projectStatusError,
  };
}


// ── One pull request ────────────────────────────────────────────────────────────────────────

/** What a workspace's PR tab shows about the PR it is for. */
export interface GithubPrDetail {
  number: number;
  title: string;
  url: string;
  repo: string;
  /** OPEN, MERGED, CLOSED, or DRAFT for an open draft. */
  state: string;
  headRef: string;
  baseRef: string;
  changedFiles: number;
  additions: number;
  deletions: number;
  reviewDecision: string;
  approvedBy: string[];
  checks: GithubChecks | null;
  updatedAt: string;
  body: string;
}

const PR_QUERY = `
  query PullRequest($owner: String!, $name: String!, $number: Int!) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $number) {
        number title url state isDraft updatedAt bodyText
        headRefName baseRefName changedFiles additions deletions reviewDecision
        latestOpinionatedReviews(first: 20) { nodes { state author { login } } }
        commits(last: 1) {
          nodes {
            commit {
              statusCheckRollup {
                state
                contexts(first: 100) {
                  totalCount
                  nodes {
                    __typename
                    ... on CheckRun { conclusion checkSuite { workflowRun { databaseId url } } }
                    ... on StatusContext { state }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
`;

const LINKED_PR_QUERY = `
  query LinkedPullRequest($owner: String!, $name: String!, $number: Int!) {
    repository(owner: $owner, name: $name) {
      issue(number: $number) {
        timelineItems(itemTypes: [CROSS_REFERENCED_EVENT, CONNECTED_EVENT], last: 50) {
          nodes {
            ... on CrossReferencedEvent { source { ... on PullRequest { number state headRefName } } }
            ... on ConnectedEvent { subject { ... on PullRequest { number state headRefName } } }
          }
        }
      }
    }
  }
`;

const BRANCH_PR_QUERY = `
  query BranchPullRequest($owner: String!, $name: String!, $branch: String!) {
    viewer { login }
    repository(owner: $owner, name: $name) {
      pullRequests(headRefName: $branch, last: 20) {
        nodes { number state author { login } }
      }
    }
  }
`;

/**
 * The viewer's own pull request from a branch of this name, or 0. For a workspace that is not
 * named for an issue, where linkedPullRequest has nothing to start from. The open one when there
 * is one, else the latest.
 */
export async function branchPullRequest(repo: string, branch: string): Promise<number> {
  if (!branch || ['HEAD', 'master', 'main'].includes(branch)) {
    return 0;
  }
  const data = await graphql(BRANCH_PR_QUERY, { ...splitRepo(repo), branch });
  const login = data.viewer?.login;
  const mine: Json[] = (data.repository?.pullRequests?.nodes || []).filter((pr: Json) => pr?.number && pr.author?.login === login);

  return (mine.find((pr) => pr.state === 'OPEN') || mine[mine.length - 1])?.number || 0;
}

async function graphql(query: string, variables: Record<string, unknown>): Promise<Json> {
  const token = await githubToken();

  if (!token) {
    throw new Error('No GitHub token is set. Add one in Settings.');
  }

  const response = await fetch(ENDPOINT, {
    method:  'POST',
    headers: { authorization: `Bearer ${ token }`, 'content-type': 'application/json' },
    body:    JSON.stringify({ query, variables }),
  });

  if (!response.ok) {
    throw new Error(response.status === 401
      ? 'GitHub rejected the token. It may have expired, or it may not have the repo scope.'
      : `GitHub answered ${ response.status }.`);
  }

  const body = await response.json();

  if (body.errors?.length) {
    throw new Error(body.errors.map((error: Json) => error.message).join(' '));
  }

  return body.data;
}

function splitRepo(repo: string): { owner: string; name: string } {
  const [owner, name] = repo.split('/');

  if (!owner || !name) {
    throw new Error(`"${ repo }" is not an owner/name repository.`);
  }

  return { owner, name };
}

/** One PR, by number, in one repository. */
export async function pullRequest(repo: string, number: number): Promise<GithubPrDetail> {
  const data = await graphql(PR_QUERY, { ...splitRepo(repo), number });
  const pr = data.repository?.pullRequest;

  if (!pr) {
    throw new Error(`There is no pull request #${ number } in ${ repo }.`);
  }

  const opinions: Json[] = pr.latestOpinionatedReviews?.nodes || [];

  return {
    number:         pr.number,
    title:          pr.title,
    url:            pr.url,
    repo,
    state:          pr.isDraft && pr.state === 'OPEN' ? 'DRAFT' : pr.state,
    headRef:        pr.headRefName,
    baseRef:        pr.baseRefName,
    changedFiles:   pr.changedFiles,
    additions:      pr.additions,
    deletions:      pr.deletions,
    reviewDecision: pr.reviewDecision || '',
    approvedBy:     opinions.filter((r) => r.state === 'APPROVED').map((r) => r.author?.login).filter(Boolean),
    checks:         checksOf(pr),
    updatedAt:      pr.updatedAt,
    body:           (pr.bodyText || '').slice(0, 2000),
  };
}

/**
 * The PR that references an issue, when there is one.
 *
 * An open one first, then whichever was linked last: the workspace for an issue is about the
 * fix in flight, and a merged PR from a year ago is not that.
 */
export async function linkedPullRequest(repo: string, issue: number): Promise<number> {
  const data = await graphql(LINKED_PR_QUERY, { ...splitRepo(repo), number: issue });
  const nodes: Json[] = data.repository?.issue?.timelineItems?.nodes || [];
  // The many PRs GitHub's timeline mixes together - the one that fixes this issue, and every other
  // PR that merely mentions it in passing - are told apart by the head branch. A fix workspace for
  // `issue-<n>` pushes a branch named for it (`issue-<n>` or `issue-<n>-<slug>`), so the PR from
  // that branch is this workspace's; a "related to #<n>" from a stranger's branch is not. Matching
  // the branch is the known-correct signal, where the timeline's own reference type is not: a real
  // fix PR shows up as a CROSS_REFERENCED_EVENT exactly like a passing mention does. Returns 0 when
  // nothing matches, which is a fix that has no PR yet - not a fix wearing some other PR's state.
  const branch = `issue-${ issue }`;
  const mine = nodes
    .map((node) => node.source || node.subject)
    .filter((pr) => pr?.number && (pr.headRefName === branch || String(pr.headRefName || '').startsWith(`${ branch }-`)));
  const open = mine.find((pr) => pr.state === 'OPEN');

  return (open || mine[mine.length - 1])?.number || 0;
}

/**
 * The REST calls behind the stages of a pull request that happen by hand.
 *
 * Straight to api.github.com with the person's own token, the way the rest of this file reaches
 * GitHub: it answers with `access-control-allow-origin: *`, so a browser can.
 */
async function rest(method: string, path: string, body?: unknown): Promise<Json> {
  const token = await githubToken();

  if (!token) {
    throw new Error('No GitHub token is set. Add one in Settings.');
  }
  const response = await fetch(`https://api.github.com${ path }`, {
    method,
    headers: {
      authorization: `Bearer ${ token }`,
      accept:        'application/vnd.github+json',
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  if (!response.ok) {
    const said = await response.text().catch(() => '');
    const why = (() => {
      try {
        return JSON.parse(said).message || said;
      } catch {
        return said;
      }
    })();

    throw new Error(`GitHub answered ${ response.status }: ${ String(why).slice(0, 200) }`);
  }

  return response.status === 204 ? {} : response.json();
}

/** Put the issue in your name, which is what taking a piece of work means to everybody else. */
export async function assignToMe(repo: string, issue: number, login: string): Promise<void> {
  await rest('POST', `/repos/${ repo }/issues/${ issue }/assignees`, { assignees: [login] });
}

/**
 * Ask people to review it.
 *
 * This used to be left to GitHub's own UI on purpose. It is here now because "nobody has been
 * asked" turned out to be the state a pull request of yours dies in most quietly, and a card that
 * can name the people who already know the change but cannot ask them is a card that has done
 * the hard half and left the easy one.
 *
 * A login that is not a collaborator is refused by GitHub for the whole call, so each is sent on
 * its own and what failed is reported by name rather than losing the ones that would have worked.
 */
export async function requestReviewers(repo: string, pr: number, logins: string[]): Promise<{ asked: string[]; refused: Record<string, string> }> {
  const asked: string[] = [];
  const refused: Record<string, string> = {};

  for (const login of logins) {
    try {
      await rest('POST', `/repos/${ repo }/pulls/${ pr }/requested_reviewers`, { reviewers: [login] });
      asked.push(login);
    } catch (e) {
      refused[login] = (e as Error)?.message || String(e);
    }
  }

  return { asked, refused };
}

/** Say what it does, after the fact. The title and the description, either or both. */
export async function describePr(repo: string, pr: number, changes: { title?: string; body?: string }): Promise<void> {
  await rest('PATCH', `/repos/${ repo }/pulls/${ pr }`, changes);
}

/** Open the pull request for a branch that already has the work on it. */
export async function createPullRequest(repo: string, from: { head: string; base: string; title: string; body?: string; draft?: boolean }): Promise<{ number: number; url: string }> {
  const made = await rest('POST', `/repos/${ repo }/pulls`, {
    head: from.head, base: from.base, title: from.title, body: from.body || '', draft: from.draft ?? true,
  });

  return { number: made.number, url: made.html_url };
}

/**
 * Take a draft PR out of draft. The person's own act - the skills never do it - and the one
 * thing GitHub's UI is otherwise needed for at the draft stage.
 */
export async function markReadyForReview(repo: string, number: number): Promise<void> {
  const data = await graphql(`
    query PullRequestId($owner: String!, $name: String!, $number: Int!) {
      repository(owner: $owner, name: $name) { pullRequest(number: $number) { id isDraft } }
    }
  `, { ...splitRepo(repo), number });
  const pr = data.repository?.pullRequest;

  if (!pr?.id) {
    throw new Error(`PR #${ number } was not found in ${ repo }.`);
  }
  if (!pr.isDraft) {
    return;
  }
  await graphql(`
    mutation MarkReady($id: ID!) {
      markPullRequestReadyForReview(input: { pullRequestId: $id }) { pullRequest { isDraft } }
    }
  `, { id: pr.id });
}

/**
 * An issue's title and text, for judging a fix against what was asked - and the four facts
 * beside it that decide whether to start at all.
 *
 * The labels, the age, how much has been said, and whether somebody already has it. This asked
 * for `title body url` only, so the card about one issue was its prose and nothing else while
 * the card that *browses* issues showed all four for thirty of them at once. They are in the
 * same selection set as the body, so they cost no extra round trip.
 */
export async function issueBody(repo: string, number: number): Promise<{
  title: string;
  body: string;
  url: string;
  labels: string[];
  comments: number;
  /**
   * And what was actually said, which is where an issue's evidence usually is.
   *
   * This returned `comments` - the count - and nothing else, so the Focus card that asks you to
   * commit a workspace to one issue printed "2 comments" in its header and had no way to open
   * them. On #13888 that withheld the entire content of the issue: its body is "There is clearly a
   * margin error. Check the screenshot." and the screenshot is in MSpencer87's reply. Same
   * selection set as the body, so it is one round trip either way.
   *
   * Twenty, newest last, which is how a thread reads. A long thread is a different problem and not
   * this card's.
   */
  comments_list: { author: string; body: string; at: string }[];
  createdAt: string;
  /** Every assignee. Who counts as "somebody else" is the caller's business; see readArtifacts. */
  assignees: string[];
}> {
  const data = await graphql(`
    query Issue($owner: String!, $name: String!, $number: Int!) {
      repository(owner: $owner, name: $name) {
        issue(number: $number) {
          title body url createdAt
          labels(first: 10) { nodes { name } }
          comments(last: 20) { totalCount nodes { body createdAt author { login } } }
          assignees(first: 3) { nodes { login } }
        }
      }
    }
  `, { ...splitRepo(repo), number });
  const issue = data.repository?.issue || {};

  return {
    title:     issue.title || '',
    body:      issue.body || '',
    url:       issue.url || '',
    labels:    (issue.labels?.nodes || []).map((node: Json) => String(node?.name || '')).filter(Boolean),
    comments:  Number(issue.comments?.totalCount || 0),
    comments_list: (issue.comments?.nodes || []).map((node: Json) => ({
      author: String(node?.author?.login || 'somebody'),
      body:   String(node?.body || ''),
      at:     String(node?.createdAt || ''),
    })).filter((one: { body: string }) => one.body),
    createdAt: issue.createdAt || '',
    assignees: (issue.assignees?.nodes || []).map((node: Json) => String(node?.login || '')).filter(Boolean),
  };
}

