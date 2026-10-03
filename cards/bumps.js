/**
 * The dependency bumps, together
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

    id:    'bumps',
    chip:  'Bumps',
    label: 'The dependency bumps, together',
    kind:  'issue',
    /*
     * One card for every bump nobody has reviewed; see `fromBotPrs`, which collapses them. The
     * bumps that have been reviewed keep their own card, because a verdict is a subject.
     */
    lede:    'bumps',
    rules:   ['bot-pile'],
    summary: '{why}',
    wants:   ['bumps'],
    /*
     * The question first, because on a pile with no merge in it the question is the work.
     *
     * `Merge the green ones` is gated (see `when`) and the first visible action is the primary, so
     * on the live pile - `0 of 9 ready to merge`, one green and that one a major - the card now
     * offers reading the risky ones at 44px instead of a confirm-then-fail. When something is
     * genuinely mergeable the merge is first again and this drops back beside it.
     */
    actions: [
      { label: 'Merge the green ones', verb: 'merge-green', when: 'mergeable', confirm: true },
      { label: 'Is any of them risky?', verb: 'ask', prompt: 'Look at the open Dependabot pull requests on rancher/dashboard. For each one, say whether the jump crosses a major and whether anything in this repository uses what changed, and name the ones you would not merge without reading.' },
      { label: 'Open them on GitHub', verb: 'url' },
      { label: 'Later', verb: 'snooze', hours: 24 },
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
