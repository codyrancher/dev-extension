---
name: my-pr-demo-changes
description: Record a video that demonstrates what a pull request changes, driving the PR's own build in the project's Rancher through the browser sidecar. Saves into /workspace/artifacts/demo-changes. Use when asked to demo, show or record the changes in a PR, and as part of my-pr-full-review.
---

Show the change working. A reviewer who watches thirty seconds of the new behaviour understands the diff faster than by reading it.

Runs inside the project container, against the project's own Rancher and browser sidecars — the same tools every other skill here uses.

## 1. Work out what there is to see

```bash
PR=<number>
curl -s "$CLAUDE_HARNESS_API/my-work/pr/$PR" \
  | jq '{title, body: .meta.body, files: [.files[].path]}'
```

Read the diff and decide whether the change is **demonstrable in the UI at all**:

- A visible behaviour change (a form, a table, a validation, an error state) — demo it.
- A change only visible under a specific setup (a cluster in a particular state, a feature flag, a role) — set that up first, or say why you can't.
- Pure refactor, test-only, CI config, docs — **there is nothing to show**. Say so and stop. Do not record thirty seconds of an unchanged page to have a video.

## 2. Drive it

Bring the sidecars up if they aren't (`$CLAUDE_HARNESS_API/sidecars/start/$HARNESS_PROJECT`), then use `my-browser-record-video` for the capture itself.

The recording should be scripted, not exploratory: get the browser to the starting point first, start recording, perform the smallest sequence that shows the new behaviour, stop. No hunting through menus on camera, no dead time.

Where the change is a *difference*, show the difference — the old behaviour then the new one, or the failing input then the passing one.

## 3. Save it

Into `/workspace/artifacts/demo-changes/`. Run `my-video-censor-ip` over it before it goes anywhere near GitHub — the dev IP is in the URL bar of every frame.

## Finish

Report the path of the video and, in two sentences, what it shows. If the change isn't demonstrable, report that instead — that's a legitimate outcome, not a failure.
