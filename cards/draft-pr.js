/**
 * A draft waiting to be read
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

    id:      'draft-pr',
    chip:    'Draft',
    label:   'A draft waiting to be read',
    kind:    'agent',
    lede:    'files',
    rules:   ['fix-draft', 'mine-draft-green'],
    summary: '{why}',
    wants:   ['files', 'stat', 'checks', 'media', 'live'],
    actions: [
      { label: 'Mark it ready for review', verb: 'ready', confirm: true },
      { label: 'Open the pull request', verb: 'url' },
      { label: 'Open the build', verb: 'share', kind: 'dashboard' },
      { label: 'Walk me through it', verb: 'ask', prompt: 'For {what} in {workspace}: walk me through what the agent changed, file by file, and tell me what you would want a human to check before this goes up for review.' },
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
