module.exports = {

    id:      'describe-pr',
    chip:    'No description',
    label:   'It does not say what it does',
    kind:    'signal',
    lede:    'files',
    rules:   ['mine-thin'],
    summary: '{why}',
    wants:   ['body', 'stat', 'files', 'commits'],
    actions: [
      { label: 'Write the description', verb: 'describe', confirm: true },
      { label: 'Open it on GitHub', verb: 'url' },
      { label: 'Draft it for me first', verb: 'ask', prompt: 'For {what}: read the diff and the commits and draft the pull request description - what it changes, why, and what a reviewer should check. Show it to me, do not post it.' },
      { verb: 'snooze', hours: 12 },
    ],
};
