/**
 * A review you have already given, pushed to
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

    id:    'review-pushed',
    chip:  'Pushed since',
    label: 'A review you have already given, pushed to',
    kind:  'review',
    /*
     * The commits that arrived after your review, which is the whole subject. `commits` would be
     * every commit on the branch - the number the first review already covered.
     */
    lede:    'fresh',
    rules:   ['reviewing-pushed'],
    summary: '{why}',
    /*
     * The commits rather than the diff, and they are the surface by name: `files` sits above
     * `commits` on the ladder, so asking for both would have drawn the whole pull request again,
     * which is the fault this card exists to stop. The diff of any one of them is a press away on
     * GitHub, and the review workspace is what the primary makes.
     */
    wants:   ['commits', 'stat', 'checks'],
    surface: 'commits',
    actions: [
      { label: 'Start a review workspace', verb: 'review' },
      { label: 'What changed since?', verb: 'ask', prompt: 'For {what} ({title}): I have already reviewed this once and {why}. Read only the commits pushed after my review and tell me what they changed, whether they answer what I asked for, and what is still open.' },
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
