/**
 * Scripts the Automations page offers as templates, kept here so the template and any definition
 * made from it say the same thing.
 */

/**
 * What a script prints from dev-api's answer: its `note` (one sentence on what happened), else the
 * answer as it came. The run's row shows a script's last line, so this is that line.
 */
const SAY_NOTE = `node -e 'let s="";process.stdin.on("data",(d)=>s+=d).on("end",()=>{try{const r=JSON.parse(s);console.log(r.note||s.trim())}catch{console.log(s.trim())}})'`;

/**
 * "Review the pull request", for one I am asked to review: My Work's Review button, through dev-api
 * (POST /my-work/pr/{n}/review). The pr-<number> workspace is made if it is not there, on the
 * Rancher the latest workspace uses, prepared, and the my-pr-full-review skill started in a
 * conversation in it. A review conversation that is open is left alone. When only a dashboard can
 * start it (a new workspace needs a Rancher token and none works from here), dev-api queues it and
 * the next open dashboard starts it.
 */
export const REVIEW_PR_SCRIPT = `#!/bin/sh
# Review a pull request I am asked to review: what My Work's Review button does, through dev-api.
set -eu
field() { node -p "String(require(process.env.EVENT_FILE).payload.$1 ?? '')"; }
REPO=$(field repo)
PR=$(field number)
if [ -z "$PR" ] || [ -z "$REPO" ]; then
  echo "No pull request to review: this runs on a pull request's event. To try it by hand, open one on Events and use 'Run an automation on this'." >&2
  exit 2
fi
echo "Reviewing $REPO#$PR."
BODY=$(node -p "JSON.stringify({ title: require(process.env.EVENT_FILE).payload.title || '' })")
OUT=$(curl -sS --fail-with-body --max-time 1700 -X POST -H 'Content-Type: application/json' -d "$BODY" "$DEV_API/my-work/pr/$PR/review?repo=$REPO") || { echo "$OUT" >&2; exit 1; }
printf '%s' "$OUT" | ${ SAY_NOTE }
`;

/** Asked to review it by name, not my own, not a draft, and not reviewed by me before. */
export const REVIEW_PR_CONDITION = '!p.draft\n!p.roles.author\np.roles.requested\n!p.roles.reviewer';

/**
 * A definition saved when "Review the pull request" was an action of its own, as the script that
 * does the same - so one written before still runs, and opens in the editor as what it is now.
 */
export function withoutReviewAction(def) {
  if (def?.action !== 'review') {
    return def;
  }

  return {
    ...def, action: 'script', script: REVIEW_PR_SCRIPT, timeoutSec: Math.max(Number(def.timeoutSec) || 0, 1800),
  };
}

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
if [ -z "$PR" ] || [ -z "$REPO" ]; then
  echo "No pull request to review: this runs on a review request or a push. To try it by hand, open one of those on Events and use 'Run an automation on this'." >&2
  exit 2
fi
echo "Reviewing the new commits on $REPO#$PR up to \${HEAD:-its head}: $(field commitsSince) since my last review."
OUT=$(curl -sS --fail-with-body --max-time 1700 -X POST "$DEV_API/my-work/pr/$PR/review-again?repo=$REPO&head=$HEAD") || { echo "$OUT" >&2; exit 1; }
printf '%s' "$OUT" | ${ SAY_NOTE }
`;

/** The conditions that go with it: asked by name, not my own, not a draft, and commits since my review. */
export const REVIEW_NEW_COMMITS_CONDITION = '!p.draft\n!p.roles.author\np.roles.requested\np.newCommits';
