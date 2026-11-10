/**
 * Scripts the Automations page offers as templates, kept here so the template and any definition
 * made from it say the same thing.
 */

/**
 * "Review the new commits", for a pull request reviewed before and asked for again: the
 * workspace's button, through dev-api (POST /my-work/pr/{n}/review-again). The event is on stdin
 * and in $EVENT_FILE; node rather than jq to read it, because node is certain to be there.
 */
export const REVIEW_NEW_COMMITS_SCRIPT = `#!/bin/sh
# Review the new commits on a pull request I reviewed before and am asked to review again:
# what the workspace's "Review the new commits" button does, through dev-api.
set -eu
field() { node -p "String(require(process.env.EVENT_FILE).payload.$1 ?? '')"; }
REPO=$(field repo)
PR=$(field number)
HEAD=$(field head)
echo "Reviewing the new commits on $REPO#$PR up to \${HEAD:-its head}: $(field commitsSince) since my last review."
curl -sS --fail-with-body --max-time 1700 -X POST "$DEV_API/my-work/pr/$PR/review-again?repo=$REPO&head=$HEAD"
echo
`;

/** The conditions that go with it: asked by name, not my own, not a draft, and commits since my review. */
export const REVIEW_NEW_COMMITS_CONDITION = '!p.draft\n!p.roles.author\np.roles.requested\np.newCommits';
