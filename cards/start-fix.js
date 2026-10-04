module.exports = {

    id:      'start-fix',
    chip:    'Issue to fix',
    label:   'An issue to pick up',
    kind:    'issue',
    lede:    'waited',
    rules:   ['issue-started'],
    summary: '{why}',
    /*
     * `comments`, because the issue's evidence is in them.
     *
     * #13888's body is one sentence - "There is clearly a margin error. Check the screenshot." -
     * and the screenshot is in MSpencer87's comment. The card printed "2 comments" in its section
     * head, offered no control that opened them, and "Read it all" opened the same one sentence:
     * the card asking you to commit a workspace to an issue withheld the only evidence it had.
     * They come off the same query as the body, so this costs no extra round trip.
     */
    wants:   ['body', 'comments'],
    /*
     * And the words stay the surface. `talk` sits above the prose on the ladder, so asking for the
     * comments would have replaced the issue with its replies - which is the reason a card gets to
     * name its own subject. The comments are a control on the facts line, where the recordings are.
     */
    surface: 'said',
    actions: [
      { label: 'Start the fix', verb: 'fix' },
      { label: 'Open the issue', verb: 'url' },
      { label: 'Is this well specified?', verb: 'ask', prompt: 'For {what} ({title}): read the issue and tell me whether it says enough to be fixed, what is missing, and where in the codebase it probably lives.' },
      { verb: 'snooze', hours: 24 },
    ],
};
