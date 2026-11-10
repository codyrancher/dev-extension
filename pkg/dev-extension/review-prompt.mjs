/**
 * What a review conversation opens with: My Work's Review button's words, and dev-api's when an
 * automation starts one. One sentence, kept in one place so both start the same review.
 *
 * Prose, not `/my-pr-full-review`: it works as claude's launch prompt and typed into a running pane,
 * where a leading `/` is swallowed as an unknown CLI command. `$CLAUDE_HARNESS_API` is set in every
 * workspace to the in-cluster API, which answers the harness's routes.
 */
export function reviewPrompt(pr, repo = 'rancher/dashboard') {
  return `Use the my-pr-full-review skill to review ${ repo } PR #${ pr } — harness portal context, file through $CLAUDE_HARNESS_API/my-work/pr/${ pr }.`;
}

/**
 * What a second pass opens with: the workspace's "Review the new commits" button's words
 * (workspace-rail.ts, `reviewAgain`), and dev-api's when an automation asks for one.
 */
export function reviewAgainPrompt(pr, repo = 'rancher/dashboard') {
  return `Use the my-pr-review-new-commits skill on ${ repo } PR #${ pr } - the developer pushed new commits or replied since your review was submitted. File through $CLAUDE_HARNESS_API/my-work/pr/${ pr }.`;
}
