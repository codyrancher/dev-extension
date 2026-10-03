/**
 * Findings waiting for your pass
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

    id:      'review-pass',
    chip:    'Agent review',
    label:   'Findings waiting for your pass',
    kind:    'review',
    lede:    'findings',
    rules:   ['review-findings', 'review-response', 'review-agent'],
    summary: '{why}',
    /*
     * No `checks`. The whole want produced one badge - `7 passed` - on a card whose job is to
     * judge two agent findings, in a strip reading "28 FILES / +3738 ADDED / -317 REMOVED / 7
     * passed". The size of what was reviewed is context for a pass; the CI tally is not what the
     * pass is about, and it cost a check-runs call on every turn of the deck to a review card.
     */
    wants:   ['notes', 'stat', 'media'],
    /*
     * The pass is the surface, said rather than inferred: `notes` is the only thing here the
     * ladder would have picked anyway, and a card that names its subject cannot have it quietly
     * outranked by an artifact somebody adds to `wants` later.
     */
    surface: 'pass',
    actions: [
      /*
       * Gated, because it arrives ungateable. Every one of these cards is `0 of 2 decided · 0 to
       * post` on arrival, and this button posted nothing and then dismissed the card. See
       * `anyKept`.
       */
      { label: 'Post the review', verb: 'post', confirm: true, when: 'anyKept' },
      /*
       * Before `Open the review`, because the first visible action is the primary. With the post
       * gated and a nav next, the 44px kind-coloured button on arrival was `Open the review` - a
       * link dressed as the decision, which is the fault 'open-pr' and 'pick-up-work' were both
       * fixed for. At nought decided the first move is reading them; the link stays, in the quiet
       * slot the footer has for links.
       */
      { label: 'Which ones matter?', verb: 'ask', prompt: 'For {what} in {workspace}: go through the findings the review agent produced and tell me which are worth filing and which are noise, with a line of reasoning each. Do not file anything.' },
      { label: 'Open the review', verb: 'open' },
      { label: 'Later', verb: 'snooze', hours: 8 },
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
