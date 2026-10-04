/**
 * Your own pull request is red
 *
 * A card, whole: what it claims, what it reads, what it shows and what its buttons do. Ported from
 * the definition that used to be compiled into the bundle, where a card was a declaration in one
 * file and one of eleven hard-wired bodies in another - so a card somebody wanted to change was
 * neither of them.
 *
 * Plain CommonJS. It imports nothing: `api.vue` is the Vue drawing the page, and `require` reaches
 * anything in the extension. See components/focus/card-api.ts for what the api carries.
 */
module.exports = {

    id:    'red-pr',
    chip:  'Build failing',
    label: 'Your own pull request is red',
    kind:  'signal',
    /*
     * The other half of what 'my-pr' used to be. Same subject, opposite first move: nothing here
     * offers a merge, because the queue's own line about this work is "Fix the build".
     */
    lede:    'checks',
    rules:   ['mine-red'],
    summary: '{why}',
    /*
     * `logs` is the failing output itself: the window out of one failing job's log around the
     * thing that looks like the failure. It is opt-in because it costs a check-run read plus a
     * streamed log tail, and six other cards want `checks` for the badge on their fact line and
     * should not pay for it; see `CardArtifacts.report`. This is the one card whose whole subject
     * is the failure, so it is the one card that asks.
     */
    wants:   ['checks', 'logs', 'stat', 'files'],
    /*
     * The failures, not the diff. The card's subject is "6 of 46 checks failing" and its 173px
     * surface was "What it changed, first 40 of 45 files" - a diff you cannot work out three red
     * e2e suites from. The names and their own one-line reports are already fetched (`ciOf`), and
     * the ladder had no rung for them, so `files` always won. The diff is one press away on
     * "Open it".
     *
     * And the names turned out not to be the answer either: `e2e-test (admin, @adminUser,
     * @explorer2)` is a label, not a reason. The surface draws what the check printed now - the
     * assertion and the frames under it, marked - with the other failures as chips above it and
     * the whole log a press away. See CheckList.
     */
    surface: 'checks',
    /*
     * `Fix it` first, because the card's own summary line is the imperative "Fix the build - 6 of
     * 46 checks failing". FocusCard derives the primary purely from this order, so with the
     * diagnosis first the 44px kind-coloured button was the question and the one thing that
     * changes anything sat in the 32px ghost slot every other card uses for its optional aside.
     * The card said one thing and weighted the other.
     */
    actions: [
      { label: 'Fix it', verb: 'ask', prompt: 'For {what}: work out what the failing checks are complaining about and make the smallest change that fixes them. Run what you touched. Stop and tell me if the failure is not mine.' },
      { label: 'Why is it red?', verb: 'ask', prompt: 'For {what}: read the failing checks and tell me what is actually broken, whether it is mine, and the smallest change that would fix it.' },
      { label: 'Open it', verb: 'url' },
      { label: 'Later', verb: 'snooze', hours: 6 },
    ],

  /*
   * The body.
   *
   * `CardSurface` is the dispatch the shell used to hold, and it reads the `surface` declared
   * above - so this card draws exactly what it drew before. The moment it wants something none of
   * the eleven surfaces are, this line is where it says so, and it can compose the same pieces
   * they do.
   */
  template: '<CardSurface :api="api" />',

  setup(api) {
    return { api };
  },
};
