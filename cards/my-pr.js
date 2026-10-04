module.exports = {

    id:    'my-pr',
    chip:  'Approved',
    label: 'Your own pull request, approved',
    kind:  'signal',
    /*
     * `mine-approved` only.
     *
     * It claimed `mine-red` as well, and `mine-red` is built with `needs: 'Fix the build'` and
     * `why: 'N of M checks failing'` (priority.ts) - so on a red pull request the card's own two
     * lines said the build was broken while the big kind-coloured primary said "Merge it", two
     * presses from a write to GitHub. The label claimed more than the data supported. They are
     * two different jobs with two different first moves, so they are two cards; see 'red-pr'.
     */
    lede:    'checks',
    rules:   ['mine-approved'],
    summary: '{why}',
    /*
     * Who approved it and what is still being said on it, which are the two things a person
     * checks before merging their own work - and the merge was justified by nothing but the
     * summary line 'approved and still open'. Both come off the single `prDetail` call this
     * card already makes (`reviewersOf` reads `detail.meta.approvedBy`, `commentsOf` the same
     * response), so neither costs a request.
     */
    wants:   ['checks', 'stat', 'files', 'reviewers', 'comments'],
    actions: [
      { label: 'Merge it', verb: 'merge', confirm: true },
      { label: 'Open it', verb: 'url' },
      { label: 'Anything left to answer?', verb: 'ask', prompt: 'For {what}: it is approved and still open. Read the review threads and tell me whether anything was asked that has not been answered, and whether you would merge it as it stands.' },
      { verb: 'snooze', hours: 6 },
    ],
};
