module.exports = {

    id:      'draft-pr',
    chip:    'Draft',
    label:   'A draft waiting to be read',
    kind:    'agent',
    lede:    'files',
    rules:   ['fix-draft', 'mine-draft-green'],
    summary: '{why}',
    wants:   ['files', 'stat', 'checks', 'media', 'live', 'comments'],
    actions: [
      { label: 'Mark it ready for review', verb: 'ready', confirm: true },
      { label: 'Open the pull request', verb: 'url' },
      { label: 'Open the build', verb: 'share', kind: 'dashboard' },
      { label: 'Walk me through it', verb: 'ask', prompt: 'For {what} in {workspace}: walk me through what the agent changed, file by file, and tell me what you would want a human to check before this goes up for review.' },
      { verb: 'snooze', hours: 8 },
    ],
};
