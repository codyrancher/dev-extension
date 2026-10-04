module.exports = {

    id:      'answer-agent',
    chip:    'Agent waiting',
    label:   'An agent is waiting on you',
    kind:    'question',
    lede:    'waited',
    rules:   ['agent-question'],
    summary: '{why}',
    wants:   ['conversation', 'media'],
    actions: [
      { label: 'Open the conversation', verb: 'open' },
      { label: 'Summarise what it asked', verb: 'ask', prompt: 'The agent in {workspace} has stopped and is waiting on an answer. Read the last few turns of its conversation and tell me, in three lines, what it is asking and what the options are.' },
      { verb: 'snooze', hours: 4 },
    ],
};
