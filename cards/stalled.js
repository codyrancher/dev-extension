/**
 * Something that stopped
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

    id:      'stalled',
    chip:    'Stopped',
    label:   'Something that stopped',
    kind:    'signal',
    lede:    'waited',
    rules:   ['stalled'],
    summary: '{why}',
    /*
     * No `checks`. A stalled item's subject is a workspace or an issue - `what` is `Issue #N`, so
     * `subjectOf` gives `pr: 0` - which makes `readArtifacts` skip `prDetail` and every artifact
     * derived from it. It was a want that could not resolve on this card's own kind of work, and
     * it is the dead want this view keeps re-growing.
     */
    wants:   ['conversation', 'media'],
    actions: [
      { label: 'What happened?', verb: 'ask', prompt: 'The work in {workspace} stopped. Read the end of its conversation and its last output, and tell me what it was doing, why it stopped, and what would get it going again.' },
      { label: 'Open the workspace', verb: 'open' },
      { label: 'Later', verb: 'snooze', hours: 4 },
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
