/**
 * Anything with no card of its own
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

  id:      'fallback',
  label:   'Anything with no card of its own',
  kind:    'signal',
  rules:   [],
  summary: '{why}',
  actions: [
    { label: 'Open it', verb: 'url' },
    { label: 'What is this?', verb: 'ask', prompt: 'Tell me what {what} is and what it is waiting on from me.' },
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
