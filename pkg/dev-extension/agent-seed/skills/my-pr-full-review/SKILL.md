---
name: my-pr-full-review
description: The complete review pass the harness portal's "Review / Respond" button runs — demo the change, demo the issue it fixes, review the diff, verify every comment the review filed, then refine each one into its final shape before a human reads it. Runs everything that can overlap in parallel and reports the run's phase back to the portal. Use when asked for a full review of a PR.
---

Five jobs, three of which don't depend on each other. Run them that way.

You are inside the project's container, so everything the project has — its checkout, its Rancher, its browser sidecar, its skills — is available to you and to every agent you spawn. Keep it that way: spawn subagents here rather than reaching outside.

```bash
PR=<number>          # from the prompt
API="$CLAUDE_HARNESS_API/my-work/pr/$PR"
curl -s "$API" | jq '{title: .meta.title, body: .meta.body, files: [.files[].path], existing: (.reviewComments | length)}'
```

Tell the portal where you are as you go — the button spins on this, and a silent agent looks like a hung one:

```bash
curl -s -X POST "$API/review-run" -H 'Content-Type: application/json' \
  -d '{"state":"running","note":"Recording the change and reviewing the diff"}'
```

## Phase 1 — three agents at once

Spawn these together and let them run concurrently. None of them needs anything from the others.

| Agent | Skill | Notes |
|---|---|---|
| Demo the change | `my-pr-demo-changes` | skips itself if the change isn't visible in the UI |
| Demo the issue | `my-pr-demo-issue` | needs the base branch, so it works on a worktree or restores the branch after |
| Review the diff | `my-pr-review` | files pending comments through the harness, never submits |

**Decide the a11y tier before you spawn anything.** If this PR is an
accessibility fix whose evidence will need Orca, run `a11y tier orca` now.
It recreates the browser container and takes every open tab with it, so doing it
later kills whatever the demo agents are part-way through. `a11y tier` on its own
reports what's already on, and if the answer is "nothing audible changed" the
tier stays where it is.

Three cautions:

- The demo-issue agent checks out unfixed code. If it does that in the shared checkout while the review is reading files, they'll fight — give it its own worktree (`git -C /workspace/dashboard worktree add`) or run it after the review finishes. Decide up front and say which you chose.
- Only the review may file comments. The demo agents produce videos and report paths.
- Both demo agents drive the one browser sidecar. They can plan, read the diff and write their scripts concurrently, but the actual recordings are serial, and a `record-script` run fails outright if another agent has DevTools open.
- **The demos belong in a PR-level comment, not on a line.** Once both
  recordings exist, file one comment with no path (`"level":"pr"`) carrying
  both, with a sentence on what each shows. It becomes the draft review's body —
  the top of the PR — which is where a reviewer looks for "what am I about to
  read". Pinning a demo to a line makes it read as a change request against
  code that is fine.

## Phase 2 — verify every comment the review filed

When the review agent returns, take the comments it created:

```bash
curl -s "$API" | jq '[.localComments[] | select(.status == "pending") | {id, path, line, body}]'
```

Spawn **one `my-pr-comment-verify` agent per comment, all in parallel** — they touch different comments and nothing shared. Each proves its claim with a recording or screenshot and attaches it, or puts an `Edit:` on top explaining why the claim didn't hold.

The one thing they do share is the browser sidecar, so the same rule as Phase 3 applies: agents proving a claim from the code, a test or the AX tree run concurrently, and agents that need to drive the page queue up behind each other.

If the review filed no comments, say so and skip this phase. That's a clean bill of health, not a failure.

## Phase 3 — refine every comment that survived

Verification decides whether a comment is *true*. This phase decides whether it
is *worth the author's time*, and it runs on every comment still standing.

Take the survivors, skipping any the verify phase deleted:

```bash
curl -s "$API" | jq '[.localComments[] | select(.status == "pending" and .level != "pr") | {id, path, line, body}]'
```

Spawn **one `my-pr-comment-refinement` agent per comment**, in parallel for
every comment that needs no new capture. Each rewrites its comment into the
three one-line answers: what the user sees, why we should care to fix it, and
the reproduction with the video or screenshot attached.

**Comments that need a fresh capture run one at a time.** There is a single
browser sidecar per project, so its X session, DevTools and AT bus are a shared
resource: an axe capture holds DevTools open and hangs every `connectOverCDP`
until it closes. Sort the comments into "needs the browser" and "doesn't",
parallelise the second group, and queue the first. A comment whose honest answer is "no user impact" and whose second
line carries no weight is deleted there, so this phase can legitimately end with
fewer comments than it started with.

Two things it must not touch:

- The PR-level comment. That is context for the whole review, not a finding, and
  the filter above already excludes it.
- The technical claim. Refinement changes how a comment reads, never whether it
  stands. A claim that only falls apart under rewriting was a verify-phase miss,
  so say so rather than quietly softening it.

Evidence the verify phase already attached carries over. Don't re-record it.

## Phase 4 — hand back

Attach the two videos where they belong: the change demo and the issue demo are context for the *whole* PR, so put them in the review's summary rather than on a line comment.

Then close the run out:

```bash
curl -s -X POST "$API/review-run" -H 'Content-Type: application/json' \
  -d '{"state":"complete","note":"3 comments filed, verified and refined · change + issue demos recorded"}'
```

Use `"state":"failed"` with a one-line reason if you couldn't finish — a run that dies silently leaves the portal spinning forever.

## Finish

A short summary for the user: what the change does, whether it does what the issue asked, how many comments you filed, how many survived verification and refinement, and where the videos are. Then stop — the comments are pending, and the user approves each one and submits the review themselves.
