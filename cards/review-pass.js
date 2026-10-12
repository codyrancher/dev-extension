module.exports = {

    id:      'review-pass',
    chip:    'Agent review',
    label:   'Findings waiting for your pass',
    kind:    'review',
    rules:   ['review-findings', 'review-response', 'review-agent'],
    // No headline number and no line under the title: the body is the findings themselves.
    summary: false,
    /*
     * No `checks`. The whole want produced one badge - `7 passed` - on a card whose job is to
     * judge two agent findings, in a strip reading "28 FILES / +3738 ADDED / -317 REMOVED / 7
     * passed". The CI tally is not what the pass is about, and it cost a check-runs call on every
     * turn of the deck to a review card. No `stat` either: the size of what was reviewed is not
     * drawn on this card.
     */
    /*
     * `pr` and `issue` join the two that draw the pass itself: this card now has three tabs and
     * they are three views of one subject. Both come off the `prDetail` the notes already read,
     * so the only new call is the issue's own body, and only on a pull request that names one.
     */
    /*
     * `files` is the fourth: the change itself, in the viewer the draft card reads a change in.
     * It comes off that same `prDetail`. Not `stat` and not `comments`, which the viewer would
     * take: both also draw on the facts row, and this card's was cleared on purpose.
     */
    wants:   ['notes', 'media', 'pr', 'issue', 'files'],
    /*
     * The pass is the surface, said rather than inferred: `notes` is the only thing here the
     * ladder would have picked anyway, and a card that names its subject cannot have it quietly
     * outranked by an artifact somebody adds to `wants` later.
     */
    surface: 'pass',
    /*
     * The first card with a body of its own rather than the default `<CardSurface />`.
     *
     * Four views of one pull request: the review waiting on you, the issue it is for, the change
     * as GitHub states it, and the change as code. They were never all on the card - the review
     * was the whole body, and judging it meant leaving to read what it was supposed to do.
     *
     * `CardTabs` is in CARD_COMPONENTS, so this is a composition rather than a new surface, and
     * the next card that wants tabs writes these six lines instead of touching the shell.
     */
    setup(api) {
      const { computed } = api.vue;

      /* Unwrapped here, because a ref *inside* an object is not unwrapped in a template. */
      const issue = computed(() => api.artifacts.value.issue);
      const pr = computed(() => api.artifacts.value.pr);
      const files = computed(() => api.artifacts.value.files || []);

      /*
       * Comments always; the others only when there is something behind them.
       *
       * A tab that opens on "nothing here" is worse than no tab: it is a place the eye has to
       * go to learn there was nothing to learn. A pull request with no `Fixes` has no Issue
       * tab at all, and the strip is two.
       */
      const tabs = computed(() => [
        { id: 'comments', label: 'Comments', count: api.notes.value.length },
        ...(issue.value ? [{ id: 'issue', label: 'Issue' }] : []),
        ...(pr.value ? [{ id: 'pr', label: 'PR' }] : []),
        ...(files.value.length ? [{ id: 'diffs', label: 'Diffs' }] : []),
      ]);

      return {
        api, tabs, issue, pr,
      };
    },
    template: `
      <CardTabs :tabs="tabs">
        <template #comments><CardSurface :api="api" /></template>
        <template #issue><GithubIssue v-if="issue" :issue="issue" /></template>
        <template #pr><GithubPr v-if="pr" :pr="pr" /></template>
        <template #diffs><CardSurface surface="files" :api="api" /></template>
      </CardTabs>
    `,
    actions: [
      /*
       * The four ways a pass ends, each one a call rather than a conversation.
       *
       * They were `ask` prompts - "use the my-pr-review-submit skill for {what}: approve it" -
       * which put a model, a skill lookup and a transcript between a button and one POST. The
       * call was always available: `submitReview` resolves each finding's evidence, posts the
       * review with its event and stamps what it sent. The agent decided nothing and could
       * fail at it.
       *
       * `withComments: false` on the first is the difference between the two approvals: an
       * approval with nothing said, which is the one case GitHub takes with no comments at all.
       * Findings left unsent stay in the workspace - they are drafts, and a button called
       * Approve should not delete them - and the card says how many did.
       *
       * Shown only once every finding is decided (`allKept`), and `Post the review` is gone.
       *
       * It did the same job as `Leave comments` with a worse name - it posted the kept findings
       * with no verdict - and it was the one button of the five that was live while findings
       * were still pending, which `submitReview` refuses anyway. So: judge them all, then
       * choose how the review ends. Until then the card's question is which ones matter.
       *
       * In the row rather than behind `Finish the review`. They were one control with four
       * answers in a menu, which is a decision you have to open something to find - and the
       * question this card asks is which of the four you want. Every one confirms, because all
       * four are public the moment they land.
       */
      { label: 'Approve', verb: 'finish', confirm: true, when: 'allKept', event: 'APPROVE', withComments: false },
      { label: 'Approve with comments', verb: 'finish', confirm: true, when: 'allKept', event: 'APPROVE', withComments: true },
      { label: 'Leave comments', verb: 'finish', confirm: true, when: 'allKept', event: 'COMMENT', withComments: true },
      { label: 'Ask for changes', verb: 'finish', confirm: true, when: 'allKept', event: 'REQUEST_CHANGES', withComments: true },
      { verb: 'snooze', hours: 8 },
    ],
};
