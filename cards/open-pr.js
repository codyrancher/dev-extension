module.exports = {

    id:      'open-pr',
    chip:    'No pull request',
    label:   'Work with no pull request',
    kind:    'agent',
    lede:    'commits',
    rules:   ['fix-no-pr'],
    summary: '{why}',
    wants:   ['commits', 'files', 'stat', 'media', 'live', 'comments'],
    actions: [
      /*
       * Not "Open the pull request", which is what four other cards call a `url` nav to a pull
       * request that exists. This one creates one. On dot7 the chip directly above it reads "NO
       * PULL REQUEST" and the 44px kind-coloured primary read "Open the pull request", so the card
       * contradicted itself - and the five words that are a quiet link on draft-pr, bump,
       * fix-feedback and review-asked were an irreversible publish here.
       */
      { label: 'Put it up for review', verb: 'create-pr', confirm: true },
      { label: 'Open the workspace', verb: 'open' },
      { label: 'Is it ready to show?', verb: 'ask', prompt: 'For the branch in {workspace}: read the commits and the diff, and tell me whether this is ready to put up as a pull request - what is unfinished, what is debug left in, and what the description should say.' },
      { verb: 'snooze', hours: 8 },
    ],
};
