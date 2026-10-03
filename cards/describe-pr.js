/**
 * It does not say what it does
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

    id:      'describe-pr',
    chip:    'No description',
    label:   'It does not say what it does',
    kind:    'signal',
    lede:    'files',
    rules:   ['mine-thin'],
    summary: '{why}',
    wants:   ['body', 'stat', 'files', 'commits'],
    actions: [
      { label: 'Write the description', verb: 'describe', confirm: true },
      { label: 'Open it on GitHub', verb: 'url' },
      { label: 'Draft it for me first', verb: 'ask', prompt: 'For {what}: read the diff and the commits and draft the pull request description - what it changes, why, and what a reviewer should check. Show it to me, do not post it.' },
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
