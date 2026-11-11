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
 * Whether a GitHub login is on the person's team: $TEAM, which dev-api gives every script run from
 * the list on the Automations page (PUT /automations/team). The agent is started only for work a
 * teammate asked for; for anyone else the workspace is made and the rest is left to the person.
 * No team set is everyone, which is what these did before there was one.
 */
const ON_TEAM = `on_team() {
  [ -z "\${TEAM:-}" ] && return 0
  case " $(printf '%s' "$TEAM" | tr 'A-Z' 'a-z') " in *" $(printf '%s' "$1" | tr 'A-Z' 'a-z') "*) return 0 ;; esac
  return 1
}`;

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
# Started only when its author is on my team ($TEAM); otherwise the workspace is made and left.
set -eu
field() { node -p "String(process.argv[1].split('.').reduce((o, k) => o?.[k], require(process.env.EVENT_FILE).payload) ?? '')" "$1"; }
${ ON_TEAM }
REPO=$(field repo)
PR=$(field number)
WHO=$(field author)
if [ -z "$PR" ] || [ -z "$REPO" ]; then
  echo "No pull request to review: this runs on a pull request's event. To try it by hand, open one on Events and use 'Run an automation on this'." >&2
  exit 2
fi
if on_team "$WHO"; then
  START=1
  echo "Reviewing $REPO#$PR, @$WHO's."
else
  START=0
  echo "Making the workspace for $REPO#$PR and starting no review: @$WHO is not on my team."
fi
BODY=$(node -p "JSON.stringify({ title: require(process.env.EVENT_FILE).payload.title || '' })")
OUT=$(curl -sS --fail-with-body --max-time 1700 -X POST -H 'Content-Type: application/json' -d "$BODY" "$DEV_API/my-work/pr/$PR/review?repo=$REPO&start=$START") || { echo "$OUT" >&2; exit 1; }
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
# Started only when the PR's author is on my team ($TEAM); otherwise the workspace is made and left.
set -eu
field() { node -p "String(process.argv[1].split('.').reduce((o, k) => o?.[k], require(process.env.EVENT_FILE).payload) ?? '')" "$1"; }
${ ON_TEAM }
REPO=$(field repo)
PR=$(field number)
HEAD=$(field head)
WHO=$(field author)
if [ -z "$PR" ] || [ -z "$REPO" ]; then
  echo "No pull request to review: this runs on a review request or a push. To try it by hand, open one of those on Events and use 'Run an automation on this'." >&2
  exit 2
fi
if on_team "$WHO"; then
  START=1
  echo "Reviewing the new commits on $REPO#$PR up to \${HEAD:-its head}: $(field commitsSince) since my last review."
else
  START=0
  echo "Making sure $REPO#$PR has its workspace and starting no review: @$WHO is not on my team."
fi
OUT=$(curl -sS --fail-with-body --max-time 1700 -X POST "$DEV_API/my-work/pr/$PR/review-again?repo=$REPO&head=$HEAD&start=$START") || { echo "$OUT" >&2; exit 1; }
printf '%s' "$OUT" | ${ SAY_NOTE }
`;

/**
 * The conditions that go with it: not my own, not a draft, commits since my review, and my review
 * wanted again - asked for by name, or dismissed (a repository that dismisses stale approvals does
 * that on the push itself, and nobody asks: the approval no longer counts, which is the same thing).
 */
export const REVIEW_NEW_COMMITS_CONDITION = "!p.draft\n!p.roles.author\np.roles.requested || p.myReview?.state === 'DISMISSED'\np.newCommits";

/**
 * "Address the feedback", for a review asking for changes on a pull request of mine: the developer
 * workspace's button, through dev-api (POST /workspaces/{ws}/address-feedback). The event's
 * workspace is the one whose stage holds the PR. The prompt goes into the workspace's own
 * conversation - typed in, or resumed with it - and never into one waiting on my answer.
 */
export const ADDRESS_FEEDBACK_SCRIPT = `#!/bin/sh
# Address the review feedback on a pull request of mine: the developer workspace's "Address the
# feedback" button, through dev-api. Only for a reviewer on my team ($TEAM); anyone else's
# review is left for me.
set -eu
field() { node -p "String(process.argv[1].split('.').reduce((o, k) => o?.[k], require(process.env.EVENT_FILE).payload) ?? '')" "$1"; }
${ ON_TEAM }
REPO=$(field repo)
PR=$(field number)
WHO=$(field review.author)
WS=\${EVENT_WORKSPACE:-}
if [ -z "$PR" ] || [ -z "$REPO" ] || [ -z "$WS" ]; then
  echo "No developer workspace to address feedback in: this runs on a review of a pull request that has one. To try it by hand, open one on Events and use 'Run an automation on this'." >&2
  exit 2
fi
if ! on_team "$WHO"; then
  echo "@$WHO is not on my team, so their review of $REPO#$PR is left for me in $WS; nothing was sent to the agent."
  exit 0
fi
echo "Addressing @$WHO's review of $REPO#$PR in $WS."
OUT=$(curl -sS --fail-with-body --max-time 1700 -X POST "$DEV_API/workspaces/$WS/address-feedback?pr=$PR&repo=$REPO") || { echo "$OUT" >&2; exit 1; }
printf '%s' "$OUT" | ${ SAY_NOTE }
`;

/** My pull request, a review asking for changes, and a workspace that holds the work. */
export const ADDRESS_FEEDBACK_CONDITION = "p.roles.author\np.review.state === 'changes_requested'\nworkspace";
