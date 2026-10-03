/**
 * A dependency bump
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

    id:      'bump',
    chip:    'Bump',
    label:   'A dependency bump',
    kind:    'issue',
    lede:    'checks',
    rules:   ['bot-cleared', 'bot-stopped', 'bot-green', 'bot-red'],
    summary: '{why}',
    /*
     * No `files`. `facts` is tested above `files` in the surface ladder - rightly, from → to →
     * crosses-a-major is what a bump is decided on - so a bump always drew CardFacts and the
     * patches it had fetched were never looked at. That is a pull request's worth of diff
     * payload read and thrown away on every turn of the deck to a bump card.
     */
    wants:   ['bump', 'stat', 'checks'],
    actions: [
      { label: 'Merge it', verb: 'merge', confirm: true },
      { label: 'Open the pull request', verb: 'url' },
      { label: 'Is it safe?', verb: 'ask', prompt: 'For {what}: read the changelog between the two versions and the diff, and tell me whether anything in this repository uses what changed. Say plainly whether you would merge it.' },
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
