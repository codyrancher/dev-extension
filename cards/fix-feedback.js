module.exports = {

    id:      'fix-feedback',
    chip:    'Comments to answer',
    label:   'Review comments to answer',
    // A review, not agent work. The chip is the first thing read on a card, and `agent` said this
    // was something an agent was doing - when what it is is a human reviewer waiting on you.
    kind:    'review',
    lede:    'comments',
    rules:   ['fix-feedback'],
    summary: '{why}',
    wants:   ['comments', 'stat', 'checks', 'media'],
    // Answering a review is two jobs and they are not the same act: replying to what was said,
    // and changing the code it was said about. Both are offered because a reviewer's comment is
    // usually one or the other and you can tell which from reading it, which is what this card is
    // for.
    actions: [
      { label: 'Draft the replies', verb: 'ask', prompt: 'For {what} in {workspace}: go through every review comment that has not been answered, and for each one draft a reply. Say which ones need a code change and which are answered by explaining. Do not push anything.' },
      { label: 'Make the changes', verb: 'ask', prompt: 'For {what} in {workspace}: make the changes the review asked for, one commit per comment, and leave the replies for me to send. Stop and ask if a comment is ambiguous rather than guessing.' },
      { label: 'Open the workspace', verb: 'open' },
      { label: 'Open the pull request', verb: 'url' },
      { verb: 'snooze', hours: 8 },
    ],
};
