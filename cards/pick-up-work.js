/**
 * Work nobody has taken
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

    id:      'pick-up-work',
    chip:    'Pick up work',
    label:   'Work nobody has taken',
    kind:    'issue',
    lede:    'pool',
    rules:   ['pick-up'],
    summary: '{why}',
    wants:   ['pool'],
    /*
     * The 44px kind-coloured primary was `Open the search on GitHub` - pure navigation, on a card
     * whose real act is `Take it and start` on one of the rows below it. That is the fault the
     * ask-reviewers card's own comment says it fixed ("answered it with go and do it by hand
     * somewhere else"). The question is the one thing this card can do for you that the list
     * cannot; the search falls into the footer's navigation with the rest of the places to go.
     */
    actions: [
      { label: 'What should I pick up?', verb: 'ask', prompt: 'Look at the open unassigned issues in rancher/dashboard. Tell me which three are worth picking up next and why, given what I have been working on, and which are too vague to start.' },
      { label: 'Open the search on GitHub', verb: 'url' },
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
