module.exports = {

    id:      'pick-up-work',
    chip:    'Pick up work',
    label:   'Work nobody has taken',
    kind:    'issue',
    lede:    'pool',
    rules:   ['pick-up'],
    summary: '{why}',
    wants:   ['pool'],
    /*
     * The 44px kind-coloured primary was `Open the search on GitHub` - pure navigation, on a card
     * whose real act is `Take it and start` on one of the rows below it. That is the fault the
     * ask-reviewers card's own comment says it fixed ("answered it with go and do it by hand
     * somewhere else"). The question is the one thing this card can do for you that the list
     * cannot; the search falls into the footer's navigation with the rest of the places to go.
     */
    actions: [
      { label: 'What should I pick up?', verb: 'ask', prompt: 'Look at the open unassigned issues in rancher/dashboard. Tell me which three are worth picking up next and why, given what I have been working on, and which are too vague to start.' },
      { label: 'Open the search on GitHub', verb: 'url' },
      { verb: 'snooze', hours: 24 },
    ],
};
