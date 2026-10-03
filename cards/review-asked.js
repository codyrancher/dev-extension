/**
 * A review somebody asked you for
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

    id:    'review-asked',
    chip:  'Review asked',
    label: 'A review somebody asked you for',
    kind:  'review',
    /*
     * How long it has waited, not how many files it has.
     *
     * The lede is meant to be the one fact nothing else on the card says. `files` was not: the
     * surface's own header reads "What it changed, first 40 of 157 files" 150px below a 36px "157
     * files changed", while the 294 days this one has been waiting was an 11px pill. One number
     * once, and the largest type on the screen gets the one that is only written there.
     */
    lede:    'waited',
    /*
     * No `reviewing-pushed`. It is built with `needs: 'Review the new commits'` and a `newSince`,
     * and it was drawn by this card - which asks for `files` and `stat` and so showed the whole
     * pull request: 157 files, +13,281 lines, "first 40 of 157 files", with nothing marking what
     * arrived after your review. The one thing the card's own line promised was the one thing its
     * surface did not distinguish, so the second review was the first review again. Two different
     * jobs, two cards; see 'review-pushed'.
     */
    rules:   ['reviewing-asked', 'reviewing-open'],
    summary: '{why}',
    /*
     * No `live`. `fromReviewing` sets `workspace: ''` for all three of these rules, `liveOf`
     * answers `[]` for an empty workspace, and `openTheBuild` then has neither a live entry nor a
     * workspace to ask `previewState` about - so "Open the build" always fell through to "Nothing
     * is serving a build for this yet", measured dead on all seven of these cards in the live
     * deck. The want was fetched and discarded for the whole rule family. The card's own primary
     * is what makes the thing that button wanted; until it has been pressed there is nothing to
     * open, and an offer that cannot be taken is worse than no offer.
     */
    wants:   ['files', 'stat', 'checks', 'body'],
    actions: [
      { label: 'Start a review workspace', verb: 'review' },
      { label: 'Open the pull request', verb: 'url' },
      { label: 'What changed?', verb: 'ask', prompt: 'For {what} ({title}): read the diff and tell me in five lines what it changes, what it touches that I should be careful about, and what I should check by hand.' },
      { label: 'Later', verb: 'snooze', hours: 12 },
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
