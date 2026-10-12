module.exports = {

    id:      'draft-pr',
    chip:    'Draft',
    label:   'A draft waiting to be read',
    kind:    'agent',
    lede:    'files',
    rules:   ['fix-draft', 'mine-draft-green'],
    /*
     * No line under the title. The chip says Draft and the first button says "Mark it ready for
     * review", which is what "Read the draft PR and mark it ready" had to say.
     */
    summary: false,
    /*
     * The diff, said rather than inferred.
     *
     * This card asks for `comments` so the change can show what has been said on each line - and
     * `talk` is tested above `files` in the surface ladder, so asking for them silently replaced
     * the whole surface with the comment list. The file tree and the diff disappeared from the
     * card whose entire job is reading a change. Declaring it is what the `surface` field is for.
     */
    surface: 'files',
    wants:   ['files', 'stat', 'checks', 'media', 'live', 'comments'],
    actions: [
      { label: 'Mark it ready for review', verb: 'ready', confirm: true },
      { label: 'Open the pull request', verb: 'url' },
      { label: 'Open the build', verb: 'share', kind: 'dashboard' },
      { label: 'Walk me through it', verb: 'ask', prompt: 'For {what} in {workspace}: walk me through what the agent changed, file by file, and tell me what you would want a human to check before this goes up for review.' },
      /*
       * The other half of reading a draft: having read it, wanting it different.
       *
       * It asks before it changes anything, because the changes are the reader's and the card
       * cannot know them - a prompt that guessed would be an agent rewriting a branch on a
       * hunch. So one question first, then the work, and explicitly not marking it ready: that
       * is the button beside this one and it is the reader's to press.
       */
      { label: 'Request changes', verb: 'ask', prompt: 'For {what} in {workspace}: I want changes before this goes up for review. Ask me what to change, in one question, and wait for the answer. Then make them, a commit each, re-run what you can, and report what is left. Do not mark it ready for review.' },
      { verb: 'snooze', hours: 8 },
    ],
};
