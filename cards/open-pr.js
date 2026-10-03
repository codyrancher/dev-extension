/**
 * Work with no pull request
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

    id:      'open-pr',
    chip:    'No pull request',
    label:   'Work with no pull request',
    kind:    'agent',
    lede:    'commits',
    rules:   ['fix-no-pr'],
    summary: '{why}',
    wants:   ['commits', 'files', 'stat', 'media', 'live'],
    actions: [
      /*
       * Not "Open the pull request", which is what four other cards call a `url` nav to a pull
       * request that exists. This one creates one. On dot7 the chip directly above it reads "NO
       * PULL REQUEST" and the 44px kind-coloured primary read "Open the pull request", so the card
       * contradicted itself - and the five words that are a quiet link on draft-pr, bump,
       * fix-feedback and review-asked were an irreversible publish here.
       */
      { label: 'Put it up for review', verb: 'create-pr', confirm: true },
      { label: 'Open the workspace', verb: 'open' },
      { label: 'Is it ready to show?', verb: 'ask', prompt: 'For the branch in {workspace}: read the commits and the diff, and tell me whether this is ready to put up as a pull request - what is unfinished, what is debug left in, and what the description should say.' },
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
