module.exports = {

    id:      'describe-pr',
    chip:    'No description',
    label:   'It does not say what it does',
    kind:    'signal',
    lede:    'files',
    rules:   ['mine-thin'],
    summary: '{why}',
    /*
     * The diff, said rather than inferred.
     *
     * This card asks for `comments` so the change can show what has been said on each line - and
     * `talk` is tested above `files` in the surface ladder, so asking for them silently replaced
     * the whole surface with the comment list. The file tree and the diff disappeared from the
     * card whose entire job is reading a change. Declaring it is what the `surface` field is for.
     */
    surface: 'files',
    wants:   ['body', 'stat', 'files', 'commits', 'comments'],
    actions: [
      { label: 'Write the description', verb: 'describe', confirm: true },
      { label: 'Open it on GitHub', verb: 'url' },
      { label: 'Draft it for me first', verb: 'ask', prompt: 'For {what}: read the diff and the commits and draft the pull request description - what it changes, why, and what a reviewer should check. Show it to me, do not post it.' },
      { verb: 'snooze', hours: 12 },
    ],
};
