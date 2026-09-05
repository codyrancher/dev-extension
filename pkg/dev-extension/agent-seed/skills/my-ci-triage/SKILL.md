---
name: my-ci-triage
description: Decide whether a PR's own change caused its CI failures, or whether the failures are infrastructure, flake or pre-existing breakage on the base branch. Ends in one word — OURS or FLAKE — for the rerun loop to act on. Use when asked to triage, diagnose or attribute a red build on a pull request.
---

You are answering one question about one PR: **did this PR's change cause the
failures, or would they have happened anyway?** You do not fix anything here.
Something else acts on your answer, so it has to be a verdict, not an essay.

## What you were handed

The prompt names the PR and lists each failing check with the failure text the
harness pulled out of the job — the assertion, the spec, the stack. Read all of
it before deciding. You can pull more yourself:

```bash
curl -s "$CLAUDE_HARNESS_API/my-work/pr/<number>/ci" | jq .          # what is red
curl -s "$CLAUDE_HARNESS_API/my-work/pr/<number>/ci/<checkId>" | jq . # one failure in full
curl -s "$CLAUDE_HARNESS_API/my-work/pr/<number>" | jq '.files[].path'  # what the PR touches
```

## How to decide

**OURS** — the failure points at something this PR changed. A test that covers a
file in the diff. A type error in a touched file. A snapshot the change
invalidates. An import that no longer resolves. A lint rule the new code trips.
The connection has to be concrete: name the file in the diff and the failure
that references it.

**FLAKE** — the failure has no relationship to the diff. Infrastructure (a
runner dying, a registry timeout, a container that would not start), a test that
fails the same way on master, a timeout in a suite the change cannot reach, a
network error. Also FLAKE when the same spec is retried and passes.

When it is genuinely ambiguous, prefer **FLAKE**: a rerun costs minutes, and a
wrong OURS sends an agent editing code to chase someone else's breakage. Say in
your reason that you were not sure.

## Answer

One or two lines naming the single most important piece of evidence — the spec
and the file in the diff it points at, or why the failure cannot be ours — as
its own message. Then, alone on the last line, exactly one word:

```
OURS
```

or

```
FLAKE
```

Nothing after it.
