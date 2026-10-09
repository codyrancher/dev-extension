module.exports = {

    id:      'review-pass',
    chip:    'Agent review',
    label:   'Findings waiting for your pass',
    kind:    'review',
    rules:   ['review-findings', 'review-response', 'review-agent'],
    // No headline number and no line under the title: the body is the findings themselves.
    summary: false,
    /*
     * No `checks`. The whole want produced one badge - `7 passed` - on a card whose job is to
     * judge two agent findings, in a strip reading "28 FILES / +3738 ADDED / -317 REMOVED / 7
     * passed". The CI tally is not what the pass is about, and it cost a check-runs call on every
     * turn of the deck to a review card. No `stat` either: the size of what was reviewed is not
     * drawn on this card.
     */
    wants:   ['notes', 'media'],
    /*
     * The pass is the surface, said rather than inferred: `notes` is the only thing here the
     * ladder would have picked anyway, and a card that names its subject cannot have it quietly
     * outranked by an artifact somebody adds to `wants` later.
     */
    surface: 'pass',
    actions: [
      /*
       * Gated, because it arrives ungateable. Every one of these cards is `0 of 2 decided · 0 to
       * post` on arrival, and this button posted nothing and then dismissed the card. See
       * `anyKept`.
       */
      { label: 'Post the review', verb: 'post', confirm: true, when: 'anyKept' },
      /*
       * Before `Open the review`, because the first visible action is the primary. With the post
       * gated and a nav next, the 44px kind-coloured button on arrival was `Open the review` - a
       * link dressed as the decision, which is the fault 'open-pr' and 'pick-up-work' were both
       * fixed for. At nought decided the first move is reading them; the link stays, in the quiet
       * slot the footer has for links.
       */
      { label: 'Which ones matter?', verb: 'ask', prompt: 'For {what} in {workspace}: go through the findings the review agent produced and tell me which are worth filing and which are noise, with a line of reasoning each. Do not file anything.' },
      { label: 'Open the review', verb: 'open' },
      { verb: 'snooze', hours: 8 },
    ],
};
