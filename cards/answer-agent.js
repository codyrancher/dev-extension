/**
 * An agent is waiting on you
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

    id:      'answer-agent',
    chip:    'Agent waiting',
    label:   'An agent is waiting on you',
    kind:    'question',
    lede:    'waited',
    rules:   ['agent-question'],
    summary: '{why}',
    wants:   ['conversation', 'media'],
    actions: [
      { label: 'Open the conversation', verb: 'open' },
      { label: 'Summarise what it asked', verb: 'ask', prompt: 'The agent in {workspace} has stopped and is waiting on an answer. Read the last few turns of its conversation and tell me, in three lines, what it is asking and what the options are.' },
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
