module.exports = {

    id:      'manual',
    chip:    'Yours',
    label:   'Something you wrote down',
    kind:    'issue',
    rules:   ['manual'],
    summary: '{why}',
    wants:   [],
    actions: [
      { label: 'Done', verb: 'done' },
      { label: 'Think it through with me', verb: 'ask', prompt: 'I have this on my list: "{title}" — {why}. Ask me whatever you need to, then tell me the first concrete step.' },
      { verb: 'snooze', hours: 24 },
    ],
};
