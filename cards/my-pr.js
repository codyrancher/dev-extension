/**
 * Your own pull request, approved
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

    id:    'my-pr',
    chip:  'Approved',
    label: 'Your own pull request, approved',
    kind:  'signal',
    /*
     * `mine-approved` only.
     *
     * It claimed `mine-red` as well, and `mine-red` is built with `needs: 'Fix the build'` and
     * `why: 'N of M checks failing'` (priority.ts) - so on a red pull request the card's own two
     * lines said the build was broken while the big kind-coloured primary said "Merge it", two
     * presses from a write to GitHub. The label claimed more than the data supported. They are
     * two different jobs with two different first moves, so they are two cards; see 'red-pr'.
     */
    lede:    'checks',
    rules:   ['mine-approved'],
    summary: '{why}',
    /*
     * Who approved it and what is still being said on it, which are the two things a person
     * checks before merging their own work - and the merge was justified by nothing but the
     * summary line 'approved and still open'. Both come off the single `prDetail` call this
     * card already makes (`reviewersOf` reads `detail.meta.approvedBy`, `commentsOf` the same
     * response), so neither costs a request.
     */
    wants:   ['checks', 'stat', 'files', 'reviewers', 'comments'],
    actions: [
      { label: 'Merge it', verb: 'merge', confirm: true },
      { label: 'Open it', verb: 'url' },
      { label: 'Anything left to answer?', verb: 'ask', prompt: 'For {what}: it is approved and still open. Read the review threads and tell me whether anything was asked that has not been answered, and whether you would merge it as it stands.' },
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
