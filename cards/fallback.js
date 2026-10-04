module.exports = {

  id:      'fallback',
  label:   'Anything with no card of its own',
  kind:    'signal',
  rules:   [],
  summary: '{why}',
  actions: [
    { label: 'Open it', verb: 'url' },
    { label: 'What is this?', verb: 'ask', prompt: 'Tell me what {what} is and what it is waiting on from me.' },
    { verb: 'snooze', hours: 12 },
  ],
};
