/**
 * The steps the team's bug-triage process runs a bug through, and the skill that is each one.
 *
 * Its own module, with nothing imported into it, because both halves of the product need it and
 * they are on opposite sides of an import: `jira.ts` reads the queue through dev-api, and
 * `reviews.ts` starts the conversations. Putting the table in either one made the other import
 * it and the two imported each other.
 *
 * The same table dev-api holds (see its `TRIAGE_ACTIONS`), because the two have to agree about
 * what `/my-work/jira/<KEY>/run/<step>` is called.
 *
 * `needsTools` is the harness's `needsProject` under the name that is true here. In the harness
 * a step that only read Jira ran in the harness's own CLI container, which had the token and the
 * API; this extension's agent pod has neither, so every step runs in the bug's own workspace and
 * what differs is whether the step has to drive the product - reproducing and fixing want a
 * Rancher and a browser up, reading a report and chasing a reporter want only Jira.
 *
 * @typedef {{ skill: string, label: string, states: string[], needsTools: boolean }} TriageAction
 * @type {Record<string, TriageAction>}
 */
export const TRIAGE_ACTIONS = {
  review: {
    skill: 'my-jira-bug-review', label: 'Review', states: ['New'], needsTools: false,
  },
  reproduce: {
    skill: 'my-jira-bug-reproduce', label: 'Reproduce', states: ['In Triage'], needsTools: true,
  },
  unstick: {
    skill: 'my-jira-bug-stuck', label: 'Unstick', states: ['Waiting for Reporter'], needsTools: false,
  },
  fix: {
    skill:      'my-jira-bug-fix',
    label:      'Fix',
    states:     ['To Prioritize', 'Prioritized', 'Needs Sign Off', 'In Development', 'Eng PR Review'],
    needsTools: true,
  },
};

/**
 * The step this bug is waiting on, read off its own status.
 *
 * The queue's own `action` is right for the four filters that are one status each and wrong for
 * "All Team Bugs", which is every unresolved bug in the team's mixed states - so a row in that
 * queue gets the step its status asks for rather than the queue's. A status no step covers (To
 * Test, QA Working, Blocked, anything downstream) answers with nothing, which is the honest
 * answer: those are not this team's triage steps.
 *
 * @param {string} status
 * @returns {string}
 */
export function actionForStatus(status) {
  return Object.keys(TRIAGE_ACTIONS).find((id) => TRIAGE_ACTIONS[id].states.includes(status)) || '';
}

/**
 * The step to offer on one row: the bug's own status first, then the queue's.
 *
 * @param {{ status: string }} bug
 * @param {{ action: string | null }} category
 * @returns {string}
 */
export function actionForBug(bug, category) {
  return actionForStatus(bug.status) || category.action || '';
}

/**
 * One bug's workspace name. `sure-<n>`, which is what dev-api's `workspaceForJira` looks for.
 *
 * @param {string} key
 * @returns {string}
 */
export function jiraWorkspaceName(key) {
  return key.toLowerCase();
}

/**
 * Where a bug is in the team's process, from the status its ticket carries.
 *
 * Jira has two dozen statuses and the process has five positions, so this is a narrowing, not a
 * rename: everything from To Prioritize to QA Working is one position here - "it has left our
 * triage" - because every step this team owns is behind it and nothing downstream is a step
 * anybody opens this page to take.
 *
 * `bug-` on every id because these share a namespace with a fix's stages and a review's, and
 * `review` was taken by a step of a different process entirely.
 *
 * @param {string} status
 * @param {string | null} [resolution]
 * @returns {'bug-new'|'bug-triage'|'bug-waiting'|'bug-prioritized'|'bug-done'}
 */
export function jiraStageOf(status, resolution = null) {
  // A resolution is what makes a bug finished, whatever the status column calls it. A ticket
  // Jira marks "Rejected" or "Duplicate" is done with, and its status alone does not say so.
  if (resolution || ['Closed', 'Resolved', 'Done', 'Rejected'].includes(status)) {
    return 'bug-done';
  }
  if (status === 'New') {
    return 'bug-new';
  }
  if (status === 'In Triage') {
    return 'bug-triage';
  }
  if (status === 'Waiting for Reporter') {
    return 'bug-waiting';
  }

  // To Prioritize, Prioritized, Needs Sign Off, In Development, Eng PR Review, To Test, QA
  // Working, Blocked - and anything this instance adds later. Reproduced and handed on.
  return 'bug-prioritized';
}

/**
 * Which part a person is playing in this bug's workspace, for the nav's grouping.
 *
 * Two of them, because the process asks two different things. Reviewing a new report and
 * chasing a stuck one are both reading and writing on the ticket - no product in front of you.
 * Reproducing means running the thing: a Rancher, a browser, the version the customer named.
 * Fixing is ordinary development and groups with it.
 *
 * @param {string} action
 * @returns {string}
 */
export function roleForStep(action) {
  if (action === 'fix') {
    return 'developer';
  }

  return action === 'reproduce' ? 'jira-reproducer' : 'jira-reviewer';
}

/**
 * The runbook's compound moves, each as the set of edits it is.
 *
 * Here rather than in the panel because both ends of the product need them: the rail offers them
 * as buttons on the Actions row and the panel is where one is filled in and sent, and a second
 * copy of the wording is a second thing to keep in step with the document.
 *
 * Straight off the document: the wording of the comments is the wording it gives, because these
 * are what a customer reads and the team has already settled how they should sound. A preset
 * fills the form in; nothing is sent until Apply, so every part of it can still be changed or
 * taken out - which is the point of filling a form in rather than firing a button.
 */
export const TRIAGE_MOVES = [
  {
    id:      'to-triage',
    label:   'Reviewed - move to In Triage',
    short:   'Move to In Triage',
    when:    ['New'],
    about:   'The report makes sense and an engineer should try to reproduce it. Sets the team, puts it on the triage owner and says so on the ticket.',
    edits:   (o) => ({
      toStatus: 'In Triage',
      team:     o.defaults.team,
      assignee: o.defaults.assignee,
      comment:  'Thank you for the bug report, we\'ve moved this to "In Triage" and an engineer will be taking a look to try and reproduce the bug. We\'ll update you soon and let you know if further information is required',
    }),
  },
  {
    id:    'need-more',
    short: 'Ask the reporter',
    label: 'Ask the reporter for more',
    when:  ['New', 'In Triage'],
    about: 'Not enough here to go on. Moves it to Waiting for Reporter - say what is needed in the comment.',
    edits: () => ({
      toStatus: 'Waiting for Reporter',
      comment:  'Thanks for the report. Before we can look into this we need a little more from you:\n\n- ',
    }),
  },
  {
    id:    'reproduced',
    short: 'Reproduced',
    label: 'Reproduced - move to To Prioritize',
    when:  ['In Triage'],
    about: 'It happens. Record anything extra you found in the comment; the GitHub issue is filed separately and carries nothing from this ticket.',
    edits: () => ({
      toStatus: 'To Prioritize',
      comment:  'We have reproduced this and it is now with the team to prioritize.',
    }),
  },
  {
    id:    'cannot-reproduce',
    short: 'Could not reproduce',
    label: 'Could not reproduce',
    when:  ['In Triage'],
    about: 'Moves it to Waiting for Reporter. Say what you tried and what would help - the version you used, the steps you followed.',
    edits: () => ({
      toStatus: 'Waiting for Reporter',
      comment:  'We have tried to reproduce this and could not. So that we can try again, could you review the steps to reproduce and update them with any more detail that would help - in particular:\n\n- ',
    }),
  },
  {
    id:    'not-ours',
    short: 'Another team',
    label: 'Not a UI bug',
    when:  ['New', 'In Triage'],
    about: 'Set Rancher Team to whoever it belongs to and take UI off it. The doc says to raise it with Gary or Neil if you are not sure which team that is.',
    edits: () => ({ team: '' }),
  },
  {
    id:    'duplicate',
    short: 'Duplicate',
    label: 'Duplicate of another bug',
    when:  ['New', 'In Triage'],
    about: 'Links this to the bug it duplicates and rejects it, with the duplicate said plainly in the comment.',
    edits: () => ({
      resolution: 'Duplicate',
      comment:    'This is a duplicate of ',
      links:      [{ type: 'Duplicate', key: '' }],
    }),
  },
  {
    id:    'already-fixed',
    short: 'Already fixed',
    label: 'Already fixed in a newer version',
    when:  ['New', 'In Triage'],
    about: 'Sets the fix version to the release it was fixed in and resolves it, saying which version that is.',
    edits: () => ({
      resolution: 'Fixed',
      comment:    'This has already been fixed and the fix is in ',
    }),
  },
];
