module.exports = {

    id:      'agent-stopped',
    chip:    'Agent stopped',
    label:   'An agent you were waiting on has stopped',
    kind:    'agent',
    lede:    'waited',
    rules:   ['agent-stopped'],
    summary: '{why}',
    // Its last report, which is what a skill ends with, and whatever it left in the workspace's
    // artifacts. Both are the answer to "what did it do" - the question this card exists to ask.
    // Served from the watcher's own read when it has one; see turnFromSnapshot.
    wants:   ['conversation', 'media'],
    actions: [
      { label: 'Open the conversation', verb: 'open' },
      { label: 'What did it do?', verb: 'ask', prompt: 'The agent in {workspace} finished and stopped. Read the last few turns of its conversation and tell me, in five lines, what it did, what it changed, and what it thinks is left.' },
      { label: 'Carry on', verb: 'ask', prompt: 'You finished the last thing in {workspace}. Pick up from there: say what you would do next and start it.' },
      { verb: 'snooze', hours: 4 },
      { verb: 'done' },
    ],
};
