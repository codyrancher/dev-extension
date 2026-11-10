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

/**
 * What "Address the feedback" sends (workspace-rail.ts, `answerFeedback`), as a template: the
 * rail's default, and dev-api's when an automation sends it and nobody has edited the prompt.
 */
export const ANSWER_FEEDBACK_TEMPLATE = 'Use the my-pr-address-feedback skill to address the review feedback on {{ repo }} PR {{ pr }}: read every comment left since the last push, answer each one or change the code, re-verify, and push. Report what you changed and what you answered.';

/** `{{ name }}` placeholders filled from `vars`; one with nothing to fill it is left as written. */
export function expandTemplate(template, vars) {
  return String(template || '').replace(/\{\{\s*([a-zA-Z]+)\s*\}\}/g, (whole, name) => (Object.hasOwn(vars, name) ? String(vars[name]) : whole));
}
