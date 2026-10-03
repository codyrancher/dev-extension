/**
 * Findings waiting for your pass.
 *
 * The first card moved out of the bundle, and deliberately the one with the most going on: it
 * reaches all three of the shell's own setters, forwards four events past the shell, and composes
 * a surface rather than drawing one. If the api is wrong anywhere, it is wrong here.
 *
 * This is a plain CommonJS module. It imports nothing - `api.vue` is the Vue drawing the page,
 * and `api.components` holds the surfaces, because a second copy of Vue in one page is the fault
 * that makes composables silently dead in a UMD-loaded extension. See card-api.ts.
 */
module.exports = {
  id:    'review-pass',
  label: 'Findings waiting for your pass',

  /*
   * What to read for this card. Same names focus-artifacts.ts uses.
   *
   * No `checks`: the whole want produced one badge - `7 passed` - on a card whose job is to judge
   * two agent findings, and it cost a check-runs call every time the card reached the top.
   */
  wants: ['notes', 'stat', 'media'],

  /*
   * The pass itself. One component, because the shell already has it and a card from a ConfigMap
   * is not a reason to have a second one.
   *
   * `kept` and `select` go to the shell rather than past it: the first gates this card's own
   * primary button, the second is what the evidence strip above the body follows. The other four
   * go straight through to the page.
   */
  /*
   * A real root element, not `<ReviewPass>` itself.
   *
   * The shell puts `class="card__bundle"` on whatever this draws, and a class on a component
   * falls through to that component's own root - which for ReviewPass is behind a `v-if`. With no
   * findings yet it renders a comment node, the class lands nowhere, and the body looks like it
   * never drew. A card's module owns an element of its own, so the shell's class has somewhere to
   * go on every render rather than most of them.
   */
  template: `
    <div class="from-configmap" data-card="review-pass">
      <ReviewPass
        :notes="notes"
        @kept="keeping"
        @select="selected"
        @expand="expand"
        @resolve="resolve"
        @ask="discuss"
      />
    </div>
  `,

  setup(api) {
    const { computed } = api.vue;

    return {
      notes: computed(() => api.notes.value || []),

      keeping:  (count) => api.shell.keeping(count),
      selected: (note) => api.shell.selected(note),

      expand:  (payload) => api.emit('expand', payload),
      resolve: (payload) => api.emit('resolve', payload),
      discuss: (payload) => api.emit('discuss', payload),
    };
  },

  /*
   * The buttons, which the module owns now.
   *
   * `Post the review` stays gated on something being kept - every one of these cards arrives at
   * `0 of 2 decided · 0 to post`, and ungated the button posted nothing and then dismissed the
   * card. The gate is the shell's (`when: 'anyKept'`, fed by `keeping` above), so a module gets
   * it by naming it rather than by reimplementing it.
   */
  actions() {
    return [
      {
        label: 'Post the review', verb: 'post', confirm: true, when: 'anyKept',
      },
      {
        label:  'Which ones matter?',
        verb:   'ask',
        prompt: 'For {what} in {workspace}: go through the findings the review agent produced and tell me which are worth filing and which are noise, with a line of reasoning each. Do not file anything.',
      },
      { label: 'Open the review', verb: 'open' },
      { label: 'Later', verb: 'snooze', hours: 8 },
    ];
  },
};
