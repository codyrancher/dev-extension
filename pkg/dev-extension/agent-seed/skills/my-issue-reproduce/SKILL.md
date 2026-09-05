---
name: my-issue-reproduce
description: Record a video that reproduces this project's original issue. Identifies the issue from the project context, brings the sidecars up, iterates against the live Rancher UI until the bug triggers, then captures one clean scripted recording into /workspace/artifacts/reproduce. Use when asked to reproduce the issue or produce a reproduction video.
---

Record a video that reproduces the original issue. The final video will end up in `/workspace/artifacts/reproduce`.

## Identify the issue

- The issue number is in the project name (`issue-<N>`) and in `/workspace/CLAUDE.md`. For `pr-<N>` projects, use the PR's linked issue (`gh pr view <N> -R rancher/dashboard --json closingIssuesReferences`, or the `Fixes #` reference in the PR body).
- Fetch the issue (`gh issue view <N> -R rancher/dashboard`) and extract the reproduction steps, expected vs actual behavior, and any version/setup notes. If the issue has no usable repro steps, derive them from the description and say so in your summary.

## Reproduce and record

1. `wait-for-sidecars` — the browser (CDP) and Rancher must be reachable before any recording.
2. Follow the record-browser-video skill's workflow: **iterate first against the live UI** (no recording) until you can reliably trigger the bug, then capture the exact sequence as a Playwright script, then do one clean `record-script` run. Never record while still exploring.
3. The recording must show the actual buggy behavior clearly — end the script a beat after the bug is visible so the viewer sees it (a `page.waitForTimeout(1500)` at the end is fine).

## Output

- Put the final video and its script in `/workspace/artifacts/reproduce/`:
  - `mkdir -p /workspace/artifacts/reproduce`
  - video: `reproduce-issue-<N>.webm`, script: `reproduce-issue-<N>.mjs`
- If the issue does NOT reproduce (already fixed, environment-dependent, etc.), still save your best-attempt recording and state plainly in the summary that it did not reproduce and why you think so.
- Finish with a short summary: the issue, the steps the video shows, whether it reproduced, and the video path.
