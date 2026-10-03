/**
 * Nobody is looking at it
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

    id:      'ask-reviewers',
    chip:    'No reviewers',
    label:   'Nobody is looking at it',
    kind:    'review',
    /*
     * How long it has been open and unasked. On the live deck that is 928 days, and it was an 18px
     * pill in the card's top-right corner: the entire story of this card, set smaller than its own
     * provenance line.
     */
    lede:    'waited',
    rules:   ['mine-unasked'],
    summary: '{why}',
    /*
     * No `files`. The card's job is finding a reviewer, not reviewing - and `files` is tested above
     * `reviewers` in the surface ladder, so asking for it would replace the candidate rows with a
     * diff of a change you are not reading. The size of it is already on the facts strip.
     */
    wants:   ['reviewers', 'stat', 'checks', 'body'],
    /*
     * The per-person `Ask` is on the candidate rows, one press each, and it is the real act here -
     * see CardReviewers and `requestReviewers` in Focus.vue. What is left for the footer is the
     * question to ask when the card has no candidate to offer, which is the honest first move in
     * that case; "Open it on GitHub" was the primary, so the card whose whole job is to answer
     * "who should review this" answered it with 'go and do it by hand somewhere else'.
     */
    /*
     * The act the card is named for is the 44px button, and the question is the aside.
     *
     * It was the other way round: `Ask` was a 32px ghost on each candidate row while `Who should
     * review this?` - which sends an agent off to think about it - was the primary. On the card
     * whose whole job is to get somebody asked, the biggest control deferred and the smallest one
     * decided. Gated on there being a candidate (see `suggested`), because with none the question
     * genuinely is the first move - which is the state the per-row press cannot cover either.
     */
    actions: [
      { label: 'Ask the ones it found', verb: 'ask-all', when: 'suggested', confirm: true },
      { label: 'Who should review this?', verb: 'ask', prompt: 'For {what}: look at which files it changes and who has worked on them lately, and tell me who to ask for a review and what to say to them.' },
      { label: 'Open it on GitHub', verb: 'url' },
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
