module.exports = {

    id:      'stalled',
    chip:    'Stopped',
    label:   'Something that stopped',
    kind:    'signal',
    lede:    'waited',
    rules:   ['stalled'],
    summary: '{why}',
    /*
     * No `checks`. A stalled item's subject is a workspace or an issue - `what` is `Issue #N`, so
     * `subjectOf` gives `pr: 0` - which makes `readArtifacts` skip `prDetail` and every artifact
     * derived from it. It was a want that could not resolve on this card's own kind of work, and
     * it is the dead want this view keeps re-growing.
     */
    wants:   ['conversation', 'media'],
    actions: [
      { label: 'What happened?', verb: 'ask', prompt: 'The work in {workspace} stopped. Read the end of its conversation and its last output, and tell me what it was doing, why it stopped, and what would get it going again.' },
      { label: 'Open the workspace', verb: 'open' },
      { verb: 'snooze', hours: 4 },
    ],
};
