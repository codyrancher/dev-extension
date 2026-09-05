---
name: my-pr-demo-issue
description: Record a video that demonstrates the original issue a pull request fixes, by reproducing the bug against a build WITHOUT the fix. Saves into /workspace/artifacts/demo-issue. Use when asked to show the problem a PR solves, and as part of my-pr-full-review.
---

The counterpart to `my-pr-demo-changes`: that one shows the fix working, this one shows what was broken. Together they're the before and after.

## 1. Find the issue

```bash
PR=<number>
curl -s "$CLAUDE_HARNESS_API/my-work/pr/$PR" | jq '{title: .meta.title, body: .meta.body}'
```

The PR body names it (`Fixes #7535`). Read that issue for the reported steps:

```bash
gh issue view <n> --repo rancher/dashboard --json title,body,comments
```

If the PR fixes no issue, or the issue has no user-visible symptom (a crash in CI, a type error, a refactor), **stop and say so**. There is nothing to reproduce.

## 2. Reproduce it against code WITHOUT the fix

This is the part that's easy to get wrong: the project's checkout is the PR branch, which *has* the fix, so the bug will not reproduce there. Get to unfixed code first — check out the PR's base branch (`git -C /workspace/dashboard checkout <baseRef>`) or stash the change — and let the dev server rebuild before you record.

`my-issue-reproduce` covers the iteration loop; this skill is that, scoped to the issue this PR claims to fix.

## 3. Record the clean run

Once you can trigger it reliably, record one scripted pass into `/workspace/artifacts/demo-issue/`, then `my-video-censor-ip` it.

Put the branch back the way you found it when you're done — the review still has to run against the PR.

## Finish

Report the video path and the exact trigger. If it does NOT reproduce on the base branch, that's a finding worth more than the video: say so plainly, because it means the PR may be fixing something other than what the issue describes.
