---
name: my-ci-fix
description: Fix the CI failures a PR's own change caused, in this project's checkout, then commit and push so the build re-runs. Ends in one word — FIXED or CANNOT — for the rerun loop to act on. Use when triage has already decided the failures belong to this PR.
---

Triage already decided these failures are ours. Your job is to make them stop,
in this project's checkout, and push — the push is what re-runs CI, so nothing
else has to trigger it.

## Scope

Fix **the failures you were given** and nothing else. This runs unattended in a
loop, so an unrelated refactor lands on a real PR with nobody reading it. If you
notice something else worth doing, say so at the end instead of doing it.

## The work

```bash
cd /workspace/dashboard
git status && git log --oneline -3        # know where you are before changing anything
```

1. **Reproduce it locally first.** Run the failing spec, the failing type check,
   the failing lint — whatever the failure text names. A fix for a failure you
   never reproduced is a guess.
2. **Fix the cause, not the symptom.** Deleting an assertion, skipping a spec or
   loosening a type to make CI green is not a fix; if that is the only option,
   the answer is CANNOT and say why.
3. **Verify the same way CI did.** Re-run what failed, and the neighbouring
   suite if the change could reach it.
4. **Commit and push** to the PR's branch — `my-commit-create` writes the
   message. One commit, describing the fix, not "fix CI".

If the failure is not reproducible locally, or the fix needs a decision that is
not yours to make (an API change, a product question, a dependency bump), stop
and answer CANNOT with the reason.

## Answer

One or two lines saying what you changed and how you verified it — or, for
CANNOT, what is in the way — as its own message. Then, alone on the last line,
exactly one word:

```
FIXED
```

or

```
CANNOT
```

Nothing after it. The loop reads that line to decide whether to wait for CI or
hand the PR back to a human.
