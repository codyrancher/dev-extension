// One queue: everything that is waiting on this person, in the order it is waiting.
//
// The other views are each about one kind of thing - the pull requests you were asked to
// review, the issues assigned to you, the advisories, the workspaces and their stages - and
// answering "what should I do next" meant reading five lists and holding the answer in your
// head. This is that answer as a list.
//
// Two rules decide everything below.
//
// **Only what needs you.** A fix whose agent is working, a review you have submitted and are
// waiting on, a merged PR: none of them want anything from a person, so none of them are here.
// A list of everything is the five lists again.
//
// **The stage is the question.** A workspace's stage already says what the work is waiting on -
// that is what the rail is - so the ranking is mostly a reading of it: an agent that asked a
// question is blocked on an answer, findings on the table are a pass somebody owes, a draft PR
// is a thing to read. Work with no workspace is ranked by the same question asked of GitHub:
// has somebody asked me for a review, is my own PR red, is it approved and unmerged.
//
// The scores are bands rather than a scale. Nothing is calibrated between them; what matters is
// that everything in the 90s genuinely cannot move without this person and everything in the
// 10s could wait until Friday.

import type { GithubWork, GithubPr, GithubIssue } from './github';
import type { WorkspaceStatus } from './workspace-status';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

/** One thing waiting on you. */
export interface PriorityItem {
  key: string;
  /** What it is: `PR #19212`, `Issue #18905`, `Advisory GHSA-…`. */
  what: string;
  /** Its own words - the PR's title, the advisory's summary. */
  title: string;
  /** What it wants from you, as the thing you would do: `Review it`, `Answer the feedback`. */
  needs: string;
  /** Why it is here and why it is this high, in one line. */
  why: string;
  /** The workspace it is in, when it has one, so the row can say where the work lives. */
  workspace: string;
  /** Where to look: the PR, the issue, the advisory. */
  url: string;
  score: number;
  /**
   * When it started waiting (ISO), or '' where nothing says.
   *
   * Only ever a tiebreak. Two pull requests that both want a first review want it equally by
   * every rule above, and then the one that has been waiting three weeks wants it more than the
   * one opened this morning - which is the whole of what this is for.
   */
  since: string;
}

/**
 * The stages at which a *fix* wants its person, and what it wants.
 *
 * Read from the rail's own vocabulary (workspace-status.ts): `draft` is a PR written and waiting
 * to be read, `feedback` is reviewers having asked for something. `assess` and `code` are the
 * agent's to get on with, and `merged` is over - neither appears here, which is how they stay
 * out of the queue.
 */
const FIX_NEEDS: Record<string, { needs: string; why: string; score: number }> = {
  feedback: {
    needs: 'Answer the review comments',
    why:   'reviewers asked for changes and nothing has gone back yet',
    score: 85,
  },
  draft: {
    needs: 'Read the draft PR and mark it ready',
    why:   'the agent finished and the draft is waiting to be read',
    score: 75,
  },
};

/** The same for a *review*: the stages where the reviewer is the one holding things up. */
const REVIEW_NEEDS: Record<string, { needs: string; why: string; score: number }> = {
  findings: {
    needs: 'Go through the agent\'s findings',
    why:   'the agent has finished and its findings are waiting for your pass',
    score: 90,
  },
  response: {
    needs: 'Review the new commits',
    why:   'the developer answered your review and pushed',
    score: 80,
  },
  agent: {
    needs: 'Start the review',
    why:   'the PR is yours to review and no review has run',
    score: 55,
  },
};

/**
 * A workspace whose agent stopped without reaching a stage that wants a person.
 *
 * Not the same as work that needs a decision: nothing is waiting on an opinion, something has
 * simply stopped. It is in the queue because a fix that stalled at four in the morning is
 * invisible otherwise, and low in it because picking it up again is a nudge rather than a
 * judgement.
 */
const STALLED = {
  needs: 'Pick it up again',
  why:   'the agent stopped here and nothing is running',
  score: 45,
};

/**
 * The one stall that is not a stall: code written, no pull request.
 *
 * A fix at `code` has commits on its branch - that is what the stage means - so a stopped agent
 * there has not run out of road, it has arrived at the one step it does not take on its own.
 * Nothing can review it until the PR exists, which makes it worth more than a nudge and less
 * than the things a person is already being waited on for.
 */
const NO_PR = {
  needs: 'Open the pull request',
  why:   'the branch has commits and no PR is open',
  score: 62,
};

/** What a workspace is called in the queue, and where its work is. */
function label(status: WorkspaceStatus, name: string): { what: string; url: string } {
  if (status.pr) {
    return { what: `PR #${ status.pr }`, url: status.links.find((l) => l.label.startsWith('PR'))?.url || '' };
  }
  const issue = status.links.find((l) => l.label.startsWith('Issue'));

  return { what: issue ? issue.label : name, url: issue?.url || '' };
}

/**
 * The workspaces, read through their stages.
 *
 * The agent's own state overrides the stage in one case and one only: a conversation that asked
 * a question is blocked on an answer whatever stage it is at, and that is the most direct claim
 * on a person's attention there is.
 */
function fromWorkspaces(statuses: Record<string, WorkspaceStatus>): PriorityItem[] {
  const out: PriorityItem[] = [];

  for (const [name, status] of Object.entries(statuses || {})) {
    if (!status || status.kind === 'other') {
      continue;
    }

    const { what, url } = label(status, name);
    const base = {
      key: `ws:${ name }`, what, title: status.title || '', workspace: name, url, since: '',
    };

    if (status.agent === 'input') {
      out.push({
        ...base,
        needs: 'Answer the agent',
        why:   'the agent asked something and stopped until it hears back',
        score: 100,
      });
      continue;
    }

    const rule = status.kind === 'fix' ? FIX_NEEDS[status.stage] : REVIEW_NEEDS[status.stage];

    if (rule) {
      // A first look and a second look are different jobs, and the rail already counts the
      // rounds - so a pass that is somebody's third says so rather than reading as a new one.
      const round = status.round > 1 ? ` (round ${ status.round })` : '';

      out.push({
        ...base, needs: `${ rule.needs }${ round }`, why: rule.why, score: rule.score,
      });
      continue;
    }

    // Stalled: a stage that is the agent's to move, with no agent moving it. `finished` is not
    // stalled - it is an agent that got to the end of what it was asked - but at a stage that
    // has not moved on, it is still a thing to look at.
    const working = ['assess', 'code', 'agent'].includes(status.stage);

    if (working && ['idle', 'finished', 'none'].includes(status.agent)) {
      const coded = status.kind === 'fix' && status.stage === 'code' && !status.pr;

      out.push({ ...base, ...(coded ? NO_PR : STALLED) });
    }
  }

  return out;
}

/**
 * The pull requests somebody asked you to review, where no workspace has taken them on.
 *
 * `reviewRequested` is GitHub asking for you by name, which is the strongest claim in this
 * half; a PR you have reviewed and that has since been pushed to is the follow-up look that
 * nobody else can do either.
 */
function fromReviewing(prs: GithubPr[], seen: Set<number>): PriorityItem[] {
  const out: PriorityItem[] = [];

  for (const pr of prs || []) {
    if (seen.has(pr.number) || pr.draft) {
      continue;
    }

    const base = {
      key: `pr:${ pr.key }`, what: `PR #${ pr.number }`, title: pr.title, workspace: '', url: pr.url, since: pr.pushedAt || pr.createdAt || '',
    };
    const pushedSince = pr.reviewedAt && pr.pushedAt && Date.parse(pr.pushedAt) > Date.parse(pr.reviewedAt);

    if (pushedSince) {
      out.push({
        ...base,
        needs: 'Review the new commits',
        why:   `${ pr.author } pushed after your review`,
        score: 58,
      });
    } else if (!pr.reviewedAt) {
      out.push({
        ...base,
        needs: 'Review it',
        why:   pr.reviewRequested ? 'you were asked for a review and have not given one' : 'it is waiting on a review of yours',
        score: pr.reviewRequested ? 56 : 50,
      });
    }
    // A review given, nothing pushed since: it is the author's move, not yours.
  }

  return out;
}

/**
 * Your own pull requests.
 *
 * Approved and unmerged is the cheapest thing in the queue and the most annoying to leave, so
 * it outranks a red build; a red build outranks a draft, because a draft is yours to finish
 * whenever and a red build is blocking a review somebody may already be waiting to give.
 */
function fromMine(prs: GithubPr[], seen: Set<number>): PriorityItem[] {
  const out: PriorityItem[] = [];

  for (const pr of prs || []) {
    if (seen.has(pr.number)) {
      continue;
    }

    const base = {
      key: `mine:${ pr.key }`, what: `PR #${ pr.number }`, title: pr.title, workspace: '', url: pr.url, since: pr.pushedAt || pr.createdAt || '',
    };

    if (pr.approved && !pr.draft) {
      out.push({
        ...base, needs: 'Merge it', why: 'approved and still open', score: 70,
      });
    } else if (pr.checks?.failing) {
      out.push({
        ...base,
        needs: 'Fix the build',
        why:   `${ pr.checks.failing } of ${ pr.checks.total } checks failing`,
        score: 65,
      });
    } else if (pr.draft && pr.checks && !pr.checks.pending && !pr.checks.failing) {
      out.push({
        ...base,
        needs: 'Mark it ready for review',
        why:   'still a draft with a green build',
        score: 40,
      });
    }
  }

  return out;
}

/**
 * The issues assigned to you - but only the ones you have already picked up.
 *
 * An assigned issue is a backlog, and a backlog is not a queue: fifty of them at the bottom of
 * this list would bury everything the list is for. What does belong here is an issue whose
 * board says it is being worked on while nothing is working on it - you moved it and then
 * nothing happened, which is exactly the thing that gets forgotten.
 */
function fromIssues(issues: GithubIssue[], workspaces: Set<string>): PriorityItem[] {
  const out: PriorityItem[] = [];
  const working = /(in progress|working|doing|started)/i;

  for (const issue of issues || []) {
    const name = issue.projectStatus?.name || '';

    if (!working.test(name) || workspaces.has(`issue-${ issue.number }`) || workspaces.has(`lte-issue-${ issue.number }`)) {
      continue;
    }

    out.push({
      key:       `issue:${ issue.key }`,
      what:      `Issue #${ issue.number }`,
      title:     issue.title,
      workspace: '',
      url:       issue.url,
      needs:     'Start the fix',
      why:       `its board says ${ name } and nothing is running`,
      score:     48,
      since:     issue.createdAt || '',
    });
  }

  return out;
}

/**
 * The advisories.
 *
 * Ranked by what GitHub calls their severity, and dropped entirely once Dependabot has opened a
 * pull request for one: the work is then the bump, which is already in this list a few rows
 * down, and having both is the same job twice under two names.
 *
 * The shape is dev-api's grouped one (`/my-work/dependabot`), where one advisory carries every
 * alert it raised - `ghsaId`, `patchedVersion`, `packages`, `prs` - and not github.ts's.
 */
function fromAlerts(alerts: Json[], workspaces: Set<string>): PriorityItem[] {
  const severity: Record<string, number> = {
    critical: 38, high: 35, medium: 30, low: 25,
  };

  return (alerts || [])
    .filter((alert) => !alert.prs?.length)
    .filter((alert) => !workspaces.has(`dependabot-${ (alert.packages?.[0] || alert.slug || '').replace(/^@/, '').replace(/[^a-zA-Z0-9]+/g, '-').toLowerCase() }`))
    .map((alert) => ({
      key:       `alert:${ alert.slug || alert.ghsaId }`,
      what:      `Advisory ${ alert.ghsaId || alert.slug || '' }`,
      title:     alert.title || '',
      workspace: '',
      url:       alert.url || '',
      since:     '',
      needs:     alert.patchedVersion ? 'Take the patch' : 'Decide what to do',
      why:       `${ alert.severity } severity in ${ (alert.packages || []).join(', ') || 'a dependency' }${ alert.patchedVersion ? `, fixed in ${ alert.patchedVersion }` : ', no patch yet' }`,
      // No patch is worse to be told about and less to do about it, so it sits just below one
      // that can simply be taken.
      score:     (severity[String(alert.severity).toLowerCase()] || 25) + (alert.patchedVersion ? 0 : -3),
    }));
}

/**
 * The Dependabot pull requests, at the bottom, because that is where they belong.
 *
 * One reviewed to MERGE is the exception: the work has been done and all that is left is the
 * press, so it sits with the ordinary merges rather than with the bumps.
 */
function fromBotPrs(prs: Json[], reviews: Json): PriorityItem[] {
  return (prs || []).map((pr) => {
    const review = reviews?.[pr.number];
    const green = pr.ci && !pr.ci.failing && !pr.ci.pending;
    const base = {
      key:       `bot:${ pr.number }`,
      what:      `Bump #${ pr.number }`,
      title:     `${ pr.packageName || pr.title }${ pr.fromVersion ? ` ${ pr.fromVersion } → ${ pr.toVersion }` : '' }`,
      workspace: review?.workspace || '',
      url:       pr.url,
      since:     pr.updatedAt || '',
    };

    if (review?.verdict === 'MERGE') {
      return {
        ...base, needs: 'Approve and merge', why: 'reviewed and cleared', score: 68,
      };
    }
    if (review?.verdict === 'STOP') {
      return {
        ...base, needs: 'Read why it was stopped', why: review.reason || 'the review said stop', score: 42,
      };
    }
    if (review) {
      // A review that is running wants nothing yet.
      return null;
    }

    return {
      ...base,
      needs: 'Review the bump',
      why:   green ? 'green build, not reviewed' : (pr.ci?.failing ? `${ pr.ci.failing } checks failing` : 'not reviewed'),
      score: green ? 15 : 10,
    };
  }).filter(Boolean) as PriorityItem[];
}

/**
 * Everything waiting on this person, most pressing first.
 *
 * Deduplicated by pull request: a PR that has a workspace is ranked by its stage, because the
 * stage knows more than GitHub does - it knows whether the agent is mid-thought, whether a
 * review of yours has already gone, and which round this is.
 */
/** How long something has been waiting, in milliseconds; 0 where nothing says. */
function waiting(item: PriorityItem): number {
  const at = Date.parse(item.since || '');

  return Number.isFinite(at) ? Date.now() - at : 0;
}

export function priorityQueue(input: {
  work: GithubWork | null;
  statuses: Record<string, WorkspaceStatus>;
  workspaces: string[];
  alerts: Json[];
  botPrs: Json[];
  botReviews: Json;
}): PriorityItem[] {
  const fromWs = fromWorkspaces(input.statuses);
  // The PR numbers a workspace already speaks for, so GitHub does not say it again in other
  // words. A workspace that wants nothing still counts: it means the work is in hand.
  const claimed = new Set(Object.values(input.statuses || {}).map((s) => s.pr).filter(Boolean));
  const names = new Set(input.workspaces || []);

  return [
    ...fromWs,
    ...fromReviewing(input.work?.reviewing || [], claimed),
    ...fromMine(input.work?.mine || [], claimed),
    ...fromIssues(input.work?.issues || [], names),
    ...fromAlerts(input.alerts || [], names),
    ...fromBotPrs(input.botPrs || [], input.botReviews || {}),
  ].sort((a, b) => b.score - a.score || waiting(b) - waiting(a) || a.what.localeCompare(b.what));
}
