---
name: my-fix-demonstrate
description: Record the "after" video proving a rancher/dashboard fix works, by replaying the exact reproduction script against the fixed build so the before and after videos are directly comparable. Saves into /workspace/artifacts/verify. Use once a fix is in place and verified, or whenever asked to show, demonstrate, or record proof that the issue is resolved.
---

Record one clean video that walks the same path the bug walked and shows it not happening. This is the counterpart to `my-issue-reproduce`: same steps, same route, different outcome. That symmetry is the whole point, since a reviewer compares the two videos side by side and any difference in the path makes the comparison worthless.

## 1. Start from the reproduction script, do not write a new one

`my-issue-reproduce` left its Playwright script next to its video:

```bash
ls /workspace/artifacts/reproduce/          # reproduce-issue-<N>.webm and reproduce-issue-<N>.mjs
mkdir -p /workspace/artifacts/verify
cp /workspace/artifacts/reproduce/reproduce-issue-<N>.mjs /workspace/artifacts/verify/fixed-issue-<N>.mjs
```

Copy it, then change as little as possible:

- **Keep every navigation and interaction step identical.** Same selectors, same order, same waits.
- **Change only the ending.** The repro script ended by showing the broken state. The verify script ends by showing the correct one: highlight the element that is now right, and hold the frame a beat (`await page.waitForTimeout(1500)`) so the viewer registers it.
- **Re-point any assertion** that asserted the bug so it now asserts the fix. If the script has no assertion, add one: a video that would look identical whether or not the fix landed proves nothing.

If a step no longer works because the fix legitimately changed the flow (a control moved, a dialog now appears), keep the change minimal and call it out in your summary. An unexplained divergence between the two videos reads as a different test, not a fix.

## 2. Record against the fixed build

Follow the `my-browser-record-video` skill's workflow. The rules that matter here:

```bash
wait-for-sidecars browser
node /workspace/browser.mjs record-script \
  /workspace/artifacts/verify/fixed-issue-<N>.mjs \
  /workspace/artifacts/verify/fixed-issue-<N>.webm
```

- **The dev server must be serving your branch.** Confirm the change is actually live in the browser before recording, not just present on disk. Recording the unfixed build is the single most common way this phase produces a misleading video.
- **Iterate first, record once.** Run the script until it completes cleanly end to end, then do the final capture. Never record while still adjusting steps.
- **Reset state between runs** if the script creates or mutates Rancher resources, or randomise names, so the final run starts from the same state the repro run did.

## 3. Check the video before you rely on it

Watch it, or at minimum confirm it is non-trivial and non-empty:

```bash
ls -la /workspace/artifacts/verify/fixed-issue-<N>.webm
ffprobe -v error -show_entries format=duration,size -of default=noprint_wrappers=1 \
  /workspace/artifacts/verify/fixed-issue-<N>.webm
```

A near-zero duration or a few-kilobyte file means `startRecording()` never fired or the sidecar was not up. Re-record rather than shipping it.

**Censor the dev IP** before this reaches a public PR. If `192.168.x.x`, `10.x.x.x`, or `172.16.x.x` is visible anywhere (URL bar, form fields, summary screens), run the `my-video-censor-ip` skill over both the before and after videos.

## 4. When a video is the wrong medium

Some fixes are a single static difference: a label, a colour, an aria attribute, a column alignment. A 20 second video of a correct label is worse evidence than one annotated still. In that case use `my-browser-screenshot` with the changed area highlighted, or `my-browser-screenshot-comparison` for a genuine before and after panel, and say in your summary why you chose a screenshot.

Recording a video anyway "because the process says so" is not thoroughness.

An accessibility fix picks its medium the same way, but from a different menu, because a normal screen recording shows nothing either way. Use `my-a11y-axe-screenshot` when the fix is silent to a screen reader (an id, a relation, an attribute value) and `my-a11y-screenreader-video` when it genuinely changes what gets announced. `.claude/rules/accessibility.md` covers how to tell which one you have.

## Output

- `/workspace/artifacts/verify/fixed-issue-<N>.webm` and its `.mjs` script, or the screenshot equivalent.
- A summary naming: what the video shows step by step, the exact moment the fixed behaviour is visible, any step that had to diverge from the repro script and why, and confirmation that the recording ran against the branch build rather than master.

These paths are what `my-pr-create` uploads into the PR's Screenshot/Video section, alongside `/workspace/artifacts/reproduce/`.
