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
  /** Which rule put it here, so a reader can ask why and a weight can be changed. See RULES. */
  rule: string;
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
 * Every rule that can put something in this queue, with what it is worth.
 *
 * One table, named, because the weights are the whole of the ranking and they used to be
 * twenty numbers written into the middle of twenty expressions. Named, they can be shown - the
 * Focus view draws them, with how many things each one is holding right now - and they can be
 * changed without changing this file: `priorityQueue` takes a map of overrides, which is what
 * the weights panel writes.
 *
 * The scores are bands rather than a scale. Nothing is calibrated between them; what matters is
 * that everything in the 90s genuinely cannot move without this person and everything in the
 * 10s could wait until Friday.
 */
export interface PriorityRule {
  /** What it is about, as a line somebody can read in a list of twenty. */
  label: string;
  /** Why it is worth what it is worth. */
  about: string;
  score: number;
}

export const RULES: Record<string, PriorityRule> = {
  'agent-question': {
    label: 'An agent asked you something',
    about: 'It has stopped until it hears back, so nothing else about that work can move.',
    score: 100,
  },
  'review-findings': {
    label: 'Findings waiting for your pass',
    about: 'The agent finished a review and its comments cannot go out until you have been through them.',
    score: 90,
  },
  'fix-feedback': {
    label: 'Review comments to answer',
    about: 'Reviewers asked for changes and nothing has gone back yet.',
    score: 85,
  },
  'review-response': {
    label: 'New commits since your review',
    about: 'The developer answered and pushed; the second look is yours and nobody else\'s.',
    score: 80,
  },
  'fix-draft': {
    label: 'A draft PR to read',
    about: 'The agent finished and the draft is waiting to be read and marked ready.',
    score: 75,
  },
  'mine-approved': {
    label: 'Your PR is approved and open',
    about: 'The cheapest thing in the queue and the most annoying to leave.',
    score: 70,
  },
  'bot-cleared': {
    label: 'A bump your review cleared',
    about: 'Reviewed and cleared; it only wants the button pressed.',
    score: 68,
  },
  'mine-red': {
    label: 'Your PR has a red build',
    about: 'It is blocking a review somebody may already be waiting to give.',
    score: 65,
  },
  'fix-no-pr': {
    label: 'Commits with no pull request',
    about: 'The branch has the work on it and nothing can review it until the PR exists.',
    score: 62,
  },
  'reviewing-pushed': {
    label: 'A PR you reviewed was pushed to',
    about: 'The follow-up look, which nobody else can give.',
    score: 58,
  },
  'reviewing-asked': {
    label: 'You were asked for a review',
    about: 'GitHub asking for you by name.',
    score: 56,
  },
  'review-agent': {
    label: 'A review of yours has not started',
    about: 'The PR is yours to review and no review has run.',
    score: 55,
  },
  'reviewing-open': {
    label: 'A PR waiting on a review of yours',
    about: 'Nobody asked for you by name, but it is yours.',
    score: 50,
  },
  'issue-started': {
    label: 'An issue the board says is in progress',
    about: 'You moved it and then nothing happened, which is the thing that gets forgotten.',
    score: 48,
  },
  'stalled': {
    label: 'An agent stopped mid-stage',
    about: 'Nothing is waiting on an opinion; something has simply stopped.',
    score: 45,
  },
  'bot-stopped': {
    label: 'A bump review said stop',
    about: 'Worth reading why before anything else happens to it.',
    score: 42,
  },
  'mine-draft-green': {
    label: 'Your draft is green',
    about: 'Yours to finish whenever, so it sits under everything somebody else is waiting on.',
    score: 40,
  },
  'advisory-critical': { label: 'A critical advisory', about: 'Ranked by GitHub\'s severity; a patch available is worth more than one that is not.', score: 38 },
  'advisory-high':     { label: 'A high advisory', about: 'As above, one band down.', score: 35 },
  'advisory-medium':   { label: 'A medium advisory', about: 'As above, one band down.', score: 30 },
  'advisory-low':      { label: 'A low advisory', about: 'As above, the bottom band.', score: 25 },
  'bot-green': {
    label: 'A green bump, unreviewed',
    about: 'The bottom of the queue: it can wait, and it is one press when you get there.',
    score: 15,
  },
  'bot-red': {
    label: 'A red bump, unreviewed',
    about: 'Below a green one: it needs looking at before it needs deciding.',
    score: 10,
  },
  manual: {
    label: 'Something you added yourself',
    about: 'A task written in the Focus view rather than read off GitHub; its own weight wins.',
    score: 60,
  },
};

/** The weights in play: what the table says, with anything the person has changed on top. */
export type Weights = Record<string, number>;

let weights: Weights = {};

/** What one rule is worth right now. */
export function weightOf(rule: string): number {
  const over = weights[rule];

  return Number.isFinite(over) ? Number(over) : RULES[rule]?.score ?? 0;
}

/**
 * The stages at which a *fix* wants its person, and what it wants.
 *
 * Read from the rail's own vocabulary (workspace-status.ts): `draft` is a PR written and waiting
 * to be read, `feedback` is reviewers having asked for something. `assess` and `code` are the
 * agent's to get on with, and `merged` is over - neither appears here, which is how they stay
 * out of the queue.
 */
const FIX_NEEDS: Record<string, { needs: string; why: string; rule: string }> = {
  feedback: {
    needs: 'Answer the review comments',
    why:   'reviewers asked for changes and nothing has gone back yet',
    rule:  'fix-feedback',
  },
  draft: {
    needs: 'Read the draft PR and mark it ready',
    why:   'the agent finished and the draft is waiting to be read',
    rule:  'fix-draft',
  },
};

/** The same for a *review*: the stages where the reviewer is the one holding things up. */
const REVIEW_NEEDS: Record<string, { needs: string; why: string; rule: string }> = {
  findings: {
    needs: 'Go through the agent\'s findings',
    why:   'the agent has finished and its findings are waiting for your pass',
    rule:  'review-findings',
  },
  response: {
    needs: 'Review the new commits',
    why:   'the developer answered your review and pushed',
    rule:  'review-response',
  },
  agent: {
    needs: 'Start the review',
    why:   'the PR is yours to review and no review has run',
    rule:  'review-agent',
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
  rule:  'stalled',
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
  rule:  'fix-no-pr',
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
        rule:  'agent-question',
        score: weightOf('agent-question'),
      });
      continue;
    }

    const rule = status.kind === 'fix' ? FIX_NEEDS[status.stage] : REVIEW_NEEDS[status.stage];

    if (rule) {
      // A first look and a second look are different jobs, and the rail already counts the
      // rounds - so a pass that is somebody's third says so rather than reading as a new one.
      const round = status.round > 1 ? ` (round ${ status.round })` : '';

      out.push({
        ...base, needs: `${ rule.needs }${ round }`, why: rule.why, rule: rule.rule, score: weightOf(rule.rule),
      });
      continue;
    }

    // Stalled: a stage that is the agent's to move, with no agent moving it. `finished` is not
    // stalled - it is an agent that got to the end of what it was asked - but at a stage that
    // has not moved on, it is still a thing to look at.
    const working = ['assess', 'code', 'agent'].includes(status.stage);

    if (working && ['idle', 'finished', 'none'].includes(status.agent)) {
      const coded = status.kind === 'fix' && status.stage === 'code' && !status.pr;

      const which = coded ? NO_PR : STALLED;

      out.push({
        ...base, ...which, score: weightOf(which.rule),
      });
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
        rule:  'reviewing-pushed',
        score: weightOf('reviewing-pushed'),
      });
    } else if (!pr.reviewedAt) {
      out.push({
        ...base,
        needs: 'Review it',
        why:   pr.reviewRequested ? 'you were asked for a review and have not given one' : 'it is waiting on a review of yours',
        rule:  pr.reviewRequested ? 'reviewing-asked' : 'reviewing-open',
        score: weightOf(pr.reviewRequested ? 'reviewing-asked' : 'reviewing-open'),
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
        ...base, needs: 'Merge it', why: 'approved and still open', rule: 'mine-approved', score: weightOf('mine-approved'),
      });
    } else if (pr.checks?.failing) {
      out.push({
        ...base,
        needs: 'Fix the build',
        why:   `${ pr.checks.failing } of ${ pr.checks.total } checks failing`,
        rule:  'mine-red',
        score: weightOf('mine-red'),
      });
    } else if (pr.draft && pr.checks && !pr.checks.pending && !pr.checks.failing) {
      out.push({
        ...base,
        needs: 'Mark it ready for review',
        why:   'still a draft with a green build',
        rule:  'mine-draft-green',
        score: weightOf('mine-draft-green'),
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
      rule:      'issue-started',
      score:     weightOf('issue-started'),
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
  const band = (severity: string) => `advisory-${ ['critical', 'high', 'medium', 'low'].includes(severity) ? severity : 'low' }`;

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
      rule:      band(String(alert.severity).toLowerCase()),
      // No patch is worse to be told about and less to do about it, so it sits just below one
      // that can simply be taken.
      score:     weightOf(band(String(alert.severity).toLowerCase())) + (alert.patchedVersion ? 0 : -3),
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
        ...base, needs: 'Approve and merge', why: 'reviewed and cleared', rule: 'bot-cleared', score: weightOf('bot-cleared'),
      };
    }
    if (review?.verdict === 'STOP') {
      return {
        ...base, needs: 'Read why it was stopped', why: review.reason || 'the review said stop', rule: 'bot-stopped', score: weightOf('bot-stopped'),
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
      rule:  green ? 'bot-green' : 'bot-red',
      score: weightOf(green ? 'bot-green' : 'bot-red'),
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
  /** What the person has changed a rule to be worth; see RULES. */
  weights?: Weights;
  /** Tasks written by hand rather than read off anything. See focus.ts. */
  extra?: PriorityItem[];
}): PriorityItem[] {
  // Set for the length of this call: every rule reads it through weightOf, and passing a map
  // down eight functions to be consulted once each is noise in all eight.
  weights = input.weights || {};
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
    ...(input.extra || []),
  ].sort((a, b) => b.score - a.score || waiting(b) - waiting(a) || a.what.localeCompare(b.what));
}
