module.exports = {

    id:      'bump',
    chip:    'Bump',
    label:   'A dependency bump',
    kind:    'issue',
    lede:    'checks',
    rules:   ['bot-cleared', 'bot-stopped', 'bot-green', 'bot-red'],
    summary: '{why}',
    /*
     * No `files`. `facts` is tested above `files` in the surface ladder - rightly, from → to →
     * crosses-a-major is what a bump is decided on - so a bump always drew CardFacts and the
     * patches it had fetched were never looked at. That is a pull request's worth of diff
     * payload read and thrown away on every turn of the deck to a bump card.
     */
    wants:   ['bump', 'stat', 'checks'],
    actions: [
      { label: 'Merge it', verb: 'merge', confirm: true },
      { label: 'Open the pull request', verb: 'url' },
      { label: 'Is it safe?', verb: 'ask', prompt: 'For {what}: read the changelog between the two versions and the diff, and tell me whether anything in this repository uses what changed. Say plainly whether you would merge it.' },
      { verb: 'snooze', hours: 24 },
    ],
};
