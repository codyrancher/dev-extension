/**
 * A security advisory
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

    id:      'advisory',
    chip:    'Advisory',
    label:   'A security advisory',
    kind:    'signal',
    lede:    'severity',
    rules:   ['advisory-critical', 'advisory-high', 'advisory-medium', 'advisory-low'],
    summary: '{why}',
    wants:   ['advisory'],
    /*
     * Two first moves, and which one it is depends on whether a patch exists. Taking the patch was
     * offered unconditionally, including on the advisory whose own summary line reads "low
     * severity in elliptic, no patch yet" - and its prompt sends an agent to run my-dependabot-fix
     * and open a pull request for a version nobody has published. Where there is no patch the
     * decision is what to do instead, which is a different question and now a different button.
     */
    actions: [
      { label: 'Take the patch', verb: 'ask', when: 'patched', prompt: 'Use the my-dependabot-fix skill for {what}: take the patch, run what the change touches, and open the pull request.' },
      { label: 'What are the options?', verb: 'ask', when: 'unpatched', prompt: 'For {what}: there is no patched version yet. Tell me what this repository actually uses from the affected package, whether the vulnerable path is reachable from our code, and what the options are - pin, replace, vendor a fix, or wait.' },
      { label: 'Open the advisory', verb: 'url' },
      { label: 'Later', verb: 'snooze', hours: 48 },
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
