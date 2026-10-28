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
