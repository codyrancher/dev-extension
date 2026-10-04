module.exports = {

    id:    'review-pushed',
    chip:  'Pushed since',
    label: 'A review you have already given, pushed to',
    kind:  'review',
    /*
     * The commits that arrived after your review, which is the whole subject. `commits` would be
     * every commit on the branch - the number the first review already covered.
     */
    lede:    'fresh',
    rules:   ['reviewing-pushed'],
    summary: '{why}',
    /*
     * The commits rather than the diff, and they are the surface by name: `files` sits above
     * `commits` on the ladder, so asking for both would have drawn the whole pull request again,
     * which is the fault this card exists to stop. The diff of any one of them is a press away on
     * GitHub, and the review workspace is what the primary makes.
     */
    wants:   ['commits', 'stat', 'checks'],
    surface: 'commits',
    actions: [
      { label: 'Start a review workspace', verb: 'review' },
      { label: 'What changed since?', verb: 'ask', prompt: 'For {what} ({title}): I have already reviewed this once and {why}. Read only the commits pushed after my review and tell me what they changed, whether they answer what I asked for, and what is still open.' },
      { verb: 'snooze', hours: 12 },
    ],
};
