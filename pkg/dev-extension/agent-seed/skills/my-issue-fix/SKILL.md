---
name: my-issue-fix
description: End-to-end workflow for fixing this project's GitHub issue in rancher/dashboard. Assess the issue, record a reproduction video, weigh several candidate root causes and pick the least special-cased one, fix it, prove it with a test and an adversarial self-review, record the fix working, then commit, open a draft PR and work its checklist. Use when asked to fix, solve, or work the issue, and as the prompt the unattended auto-fix run follows.
---

Take this project's issue from "reported" to "draft PR open with its checklist worked". This skill is the spine: it owns the order, the handoffs, and the gates between phases. Each phase's depth lives in its own skill, listed below. Read the phase, invoke the skill it names, and carry its output into the next phase.

The issue number is the trailing `issue-<N>` token in the project name and is recorded in `/workspace/CLAUDE.md`.

## The phases

| # | Phase | Skill | Produces |
|---|---|---|---|
| 1 | Assess | `my-issue-assess` | Expected vs actual, numbered repro procedure, candidate code locations |
| 2 | Reproduce | `my-issue-reproduce` | `/workspace/artifacts/reproduce/` video plus its script, bug confirmed real |
| 3 | Root cause | `my-root-cause-analysis` | Candidate causes with evidence, the chosen one, the file-by-file plan |
| 4 | Fix | (this skill) | The change, looped through a UX review and a code review until both are clean |
| 5 | Refine | `my-code-issue-refinement` | The same diff, looped against the ISSUE by a separate evaluator until it passes |
| 6 | Verify | `my-fix-verify` | Self-review, a test that fails without the fix, edge cases and side effects swept |
| 7 | Demonstrate | `my-fix-demonstrate` | `/workspace/artifacts/verify/` video showing the same path now correct |
| 8 | Commit | `my-commit-create` | Commit on branch `issue-<N>` |
| 9 | PR | `my-pr-create` (calls `my-pr-fill-template`) | Draft PR upstream with both videos embedded |
| 10 | Checklist | `my-pr-checklist` | Every checklist item worked, ticked or explained |

## The gates

Do not step past these. They are the phases that stop a plausible-but-wrong diff from reaching a reviewer, and they are the ones under time pressure you will want to skip.

- **Reproduce before you change anything.** The bug you can trigger is often narrower, wider, or different from the bug as reported. Fix what actually happens. If it does not reproduce, do not guess: report the steps you ran, what you saw instead, and what you would need to try again.
- **At least two candidate causes before any edit.** The first explanation that fits the symptom is usually a symptom-level explanation. Phase 3 exists to kill the fix you thought of in the first thirty seconds.
- **A test that fails without the fix.** Proven by reverting the source and watching it go red, not asserted. If there is genuinely no seam, precise manual test instructions in the PR are the substitute, and you say so.
- **The self-review happens before the commit exists.** That is what makes going back to phase 3 cheap.

## Phase 4: the fix itself

The plan from phase 3 names every file and the change to each. Do not execute it alone. Every task in that plan gets **three agents**, and they loop until both reviewers are out of findings.

| Agent | Owns | Brief |
|---|---|---|
| **Developer** | The only one who edits | Implement the task from the phase 3 plan, then fix everything the two reviewers raise. Runs the scoped checks below after every round and reports the working diff. |
| **UX reviewer** | The experience | Scrutinise the change as a user meets it, not as a diff. Is it the simplest thing that solves the issue? Would someone who has never seen this screen understand it immediately? Does it behave like the rest of Rancher, in both themes, at keyboard and screen-reader level? Keep pushing until it is simple, obvious, consistent, and genuinely right, not merely acceptable. |
| **Code reviewer** | The code | Scrutinise the diff. Does it use the patterns already in this repo, or invent a new one? What can be deleted, reused, or collapsed into an existing helper or component? What else calls this code, and what breaks. Hunt for the regression the developer did not think of. |

Rules that keep the loop honest:

- **Only the developer writes.** Both reviewers are read-only: they read the working tree, run the UI, and return findings. This is also what stops three agents fighting over one checkout.
- **Work the plan's tasks one at a time.** Parallel developers in the shared checkout collide. If two tasks are genuinely independent and you want them concurrent, give each its own `git -C /workspace/dashboard worktree add`.
- **Both reviewers see the same diff, at the same time, and run in parallel.** Neither waits for the other.
- **Findings come back ranked, with the reason.** "Rename this" is not a finding. "This duplicates `<X>`, which already handles the empty case" is.
- **The developer answers every finding**: fix it, or say why it is wrong or out of scope. Silently dropping one ends the loop early on a false clean.

A round is: developer implements or applies findings → both reviewers review the new diff → developer answers. Repeat.

**Stop when both reviewers return clean on a diff that has not changed since they read it.** A clean verdict on the first round is suspicious, so a reviewer reporting no findings has to say what it checked. If the same disagreement survives three rounds, stop looping, keep the developer's version, and record the dispute in the phase 4 notes for the final report rather than churning.

If the fix turns out to be at the wrong altitude, whether the developer feels it while writing or a reviewer's finding is really an argument about which fix this should have been, that is phase 3 talking. Go back rather than patching around it.

## Phase 5: refine against the issue

Run `my-code-issue-refinement` on the working tree before anything is committed.

Phase 4's reviewers judge the change on its own terms — is it good code, is it a
good experience. Neither of them is holding the issue. This phase closes that
gap: a separate evaluator reads the diff **against the issue text**, point by
point, and keeps it looping until every claim in the issue has a hunk that
answers it and the change is simpler and more consistent than what it replaced.

It runs here, and not later, for the same reason the self-review does: before
the commit exists, going back is still cheap. A refinement finding that arrives
after the PR is open costs a force-push and a reviewer's second read.

It refines; it does not test. A PASS here is not evidence that anything runs —
that is phase 6.

Conventions this repo enforces, and which both reviewers hold the change to:

- **No user-facing strings in code.** Labels go in `assets/translations/en-us.yaml`, referenced as `t('path.to.key')`. `yarn lint-l10n` checks the shell translations parse.
- **Accessibility counts as correctness.** Many of these issues are a11y issues. Interactive elements need a real accessible name, keyboard reachability, and correct roles.
- **Both themes.** Rancher ships light and dark. Use existing CSS variables, never literal colours.
- **Follow the neighbours.** A fix that looks unlike the two or three components already solving the same shape of problem gets rejected on that alone.
- **Keep the diff to the issue.** If you spot a second bug, note it for the PR description instead of fixing it here.
- **Never use em dashes** in code, comments, or anything else you write.

While iterating, scope the checks so the loop stays fast (see the project-environment rule for why `yarn lint` and `yarn test` are the wrong form here):

```bash
./node_modules/.bin/eslint --max-warnings 0 <changed files>
npx jest --ci <path or pattern>
```

## Handoffs that break if you get them wrong

- **Phase 1's repro procedure is what phase 2 records and what phase 7 replays.** All three must walk the same path, or the before and after videos are not comparable and the verification proves nothing.
- **Phase 3's blast-radius list is phase 6's regression checklist.** Write it down when you find it; reconstructing it later never produces the same list.
- **Phase 7's script is a copy of phase 2's script** with only the ending changed. Do not write a fresh one.
- **Both media directories feed phase 9.** `my-pr-create` uploads from `/workspace/artifacts/reproduce/` and `/workspace/artifacts/verify/`, plus any `/workspace/screenshots/`. Run `my-video-censor-ip` over both videos first if the dev IP is visible anywhere in frame.

## Running unattended

Nobody will answer a question. When two readings of the issue lead to materially different fixes, pick the one the issue text best supports, state the assumption, and continue.

If a phase genuinely cannot complete (the issue does not reproduce, the root cause sits in a dependency you cannot change, the fix needs a product decision), stop at that phase and write up what you found. A confident wrong fix costs the reviewer far more than an honest "here is what I learned and where I got stuck". Stopping early is a valid outcome; a fabricated one is not.

The PR stays a **draft**. The user promotes it.

## Report at the end

Whatever happened, close with:

- The root cause in one sentence, and the candidates you rejected with why.
- The change in one or two sentences.
- What the UX review and the code review pushed back on, how many rounds it took, and anything the loop ended still disagreeing about.
- What you verified, separating what you exercised in the running UI from what you checked by reading code.
- The test that covers it, and confirmation it fails without the fix.
- Anything you were unsure about, and anything you deliberately left out of scope.
- The PR link, and what is left for the user on the checklist.

If you stopped early, say at which phase and what would unblock it.
