---
name: my-loop-code-pr
description: Review your own PR against yourself — a validator subagent runs my-pr-full-review, an implementer subagent fixes the real findings, looping until a review comes back with nothing. Use when a PR is open and you want it clean before a human reads it, or when asked to loop, harden or self-review a PR until the review is quiet.
---

Two agents, looping, until a full review of our own PR yields nothing.

Spin up two subagents. One is the **implementer**, responsible for fixing what
the review finds. The other is the **validator**, which runs `my-pr-full-review`
against our own code exactly as it would against someone else's. They loop until
the validator finishes a review with no issues left standing.

## Before the first round

This needs a PR to review. `pr-<N>` projects already have one, and the number is
in the project name. If the work is only committed locally, run `my-pr-create`
first, then come back.

```bash
PR=<number>
API="$CLAUDE_HARNESS_API/my-work/pr/$PR"
curl -s "$API" | jq '{title: .meta.title, files: [.files[].path], pending: (.localComments | length)}'
```

Clear out anything already pending before you start. A comment left over from an
earlier review will be counted as a finding of this one.

## The two roles

**The validator** never edits. It runs `my-pr-full-review` on the PR and nothing
else: demo the change, demo the issue it fixes, review the diff, then verify
every comment it filed. That verify phase is what makes this loop worth running,
it is the step that kills confident wrong findings before the implementer wastes
a round on them. The validator reports the comments that survived and stops.

**The implementer** makes changes. Each round it gets the surviving comments and
answers every one of them, in the diff or in a sentence:

- A **real issue** gets fixed. Bugs, missed edge cases, a regression the change
  introduces, an accessibility or permissions hole, a test that should exist.
- An issue it rejects gets a one-line reason, and that comment is deleted with an
  `Edit:` on top saying what was checked and why the claim did not hold. It does
  not argue in a reply and leave the comment standing.
- It does not grade its own work and it does not file comments.

Roles stay apart across the whole loop. The moment the agent that wrote the code
is the one deciding whether the review was right, this is worth nothing.

## The loop

1. Validator runs `my-pr-full-review`. It reports the pending comments that
   survived verification.
2. **Zero surviving comments means done.** Stop and report.
3. Otherwise hand those comments to the implementer, which fixes the real ones,
   deletes the rejected ones with an `Edit:` note, and commits.
4. Clear the pending comments that were addressed, so the next review starts from
   an empty slate and only new findings count.
5. Go again.

Round one is the expensive one, it records both demos. On later rounds the demos
are still valid unless the fix changed what the UI does, so the validator can run
`my-pr-review` plus `my-pr-comment-verify` on their own and skip the recordings.
Say which you did.

**Evidence goes stale the moment the implementer commits.** A before/after pair
is only worth something if everything except the fix is identical between the two
captures, so any screenshot or recording of a file this round touched has to be
recaptured, not carried forward. That applies hardest to the a11y evidence, where
the "before" side is produced by reverting the fix under a running dev server:

```bash
cd /workspace/dashboard
git checkout upstream/master -- <files the fix touches>
# wait for "Compiled successfully in", then a few seconds more
# ... capture ...
git checkout HEAD -- <the same files>
git status -s        # empty means the tree is restored
```

Confirm from the page itself that the build is the one you think it is before
each take. A capture of the wrong build is the most common way this loop produces
a confident wrong result, and it is invisible afterwards.

If the PR is an accessibility fix, settle the tier once, in round one, before any
agent opens a page. `a11y tier orca` recreates the browser container, so flipping
it mid-loop destroys whatever the other agent is doing.

Cap it at **four rounds**. Stop early and say so if the same finding survives two
rounds: that means the two agents disagree about what the code should be, and
that is a call for the person running this, not something to iterate at.

## Running the agents

```
Agent(subagent_type: "general-purpose", description: "validate",
      prompt: "Run the my-pr-full-review skill on PR <N>. You are reviewing, not
               editing. Report the pending comments that survived verification.")

Agent(subagent_type: "general-purpose", description: "implement",
      prompt: "<PR number> <surviving comments> Fix the real ones. For any you
               reject, put an Edit: on the comment saying what you checked, then
               delete it. Do not file comments.")
```

Never both at once. The validator reads the working tree the implementer is
writing to, so a round is strictly sequential.

## Finish

Report: how many rounds, what got fixed, what the implementer rejected and why,
and whether the last review was genuinely clean or you hit the cap. Then say
plainly that these comments were never submitted, the PR is still where it was,
and the human reviews it next.
