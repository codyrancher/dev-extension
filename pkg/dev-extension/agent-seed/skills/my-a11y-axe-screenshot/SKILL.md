---
name: my-a11y-axe-screenshot
description: Capture a matched before/after pair of real axe DevTools panel screenshots for an accessibility fix, by driving the extension through the browser sidecar's X session. Use when a fix is silent to a screen reader (an id, a relation, an attribute value) and the evidence has to be the scanner's own output rather than an injected banner.
---

Capture the axe DevTools panel itself, on the pre-fix build and the fixed build, as a pair a reviewer can compare.

Use this when the fix is real but inaudible: an `aria-controls` pointing at an id no element has, an invalid attribute value, a role that fails its containment rule. A screen reader clip of those sounds identical before and after, so the scanner's own output is the evidence. When the announcement genuinely changes, use `my-a11y-screenreader-video` instead, and when both are true use both.

Read `.claude/rules/accessibility.md` first for how `a11y` reaches into the browser sidecar.

## Why this is fiddly, and what not to try

The axe DevTools extension panel is **not a CDP target**. You cannot click it with Playwright, you cannot attach to it, and it does not appear in `/json/list`. The only way in is the sidecar's X session: `xdotool` for input, `xwd` for capture. The `a11y` wrapper covers that:

```bash
a11y screen [WxH]     # show or set the resolution, then report where the pointer can actually reach
a11y focus            # raise and activate the browser window
a11y click X Y        # move, verify the pointer landed, click
a11y shot NAME        # capture the desktop to /workspace/artifacts/a11y/NAME.png
a11y desktop "cmd"    # anything else, with DISPLAY set
```

Two things that will waste an hour if you skip them:

- **Playwright cannot attach while DevTools is open.** `chromium.connectOverCDP` hangs. Close DevTools (`a11y desktop 'xdotool key F12'`) before any script that drives the page, and reopen it after. To reload the page with DevTools open, use real keys (`ctrl+r`), not Playwright.
- **Read every screenshot back before acting on it.** Coordinate clicking is blind. Take the shot, open it with the Read tool, and confirm the click did what you assumed. Chaining three assumed clicks and only then looking is how a session ends up 40 captures deep.

## 1. Geometry first

The most expensive failure in this flow is silent: if the X framebuffer is smaller than the window, the pointer is clamped at the edge and **every click past it lands somewhere else**, which looks exactly like "the button did nothing".

```bash
a11y screen 1600x1000
```

It sets the mode, probes where the pointer can actually reach, and fits the browser window inside those bounds. Believe the `pointer reaches X,Y` line, not the mode. `a11y click` re-checks on every click and tells you when it was clamped.

Landscape matters for a second reason: in a portrait window the DevTools tab bar is narrow and the axe panel hides behind the `»` overflow.

## 2. Confirm the extension is there

```bash
a11y desktop 'grep -ho "\"name\": *\"[^\"]*" ~/.config/chromium/Default/Extensions/*/*/manifest.json'
```

It is preseeded into every project's browser profile alongside Vue devtools, and it survives a container recreate because the profile is a persistent volume. If it is genuinely missing, fall back to injecting `axe-core` (a dashboard dependency, `dashboard/node_modules/axe-core/axe.min.js`) into the page over CDP and rendering the result. Same rule ids, no branded panel, and say in the PR which one produced the screenshot.

## 3. Open the panel

Open DevTools with `F12`, then reach axe. Two routes, in order of reliability:

1. **`Ctrl+]` cycles panels and needs no coordinates.** Click into the DevTools area first so it has keyboard focus, then send it up to ten times.
2. **The `»` overflow menu**, when cycling overshoots. Shot the tab bar, read the `»` position off the image, click it, shot again to find "axe DevTools" in the menu, click that.

The command menu (`Ctrl+Shift+P`) does **not** work: extension panels are not listed in it.

```bash
a11y desktop 'xdotool key F12'; sleep 8
a11y click 1200 500                    # focus inside DevTools, somewhere harmless
a11y desktop 'for i in $(seq 10); do xdotool key ctrl+bracketright; sleep 1; done'
a11y shot panel
```

**First run only**, the panel opens on an onboarding gate: a role dropdown, a terms checkbox, a "Start using axe DevTools" button, then an upsell modal. Work through it one click and one shot at a time. Two traps: a click that only raises the window does not also press the control under it, so a control that ignores you may just need a second click; and a misplaced click on the upsell opens a marketing tab, which you close with `ctrl+w`.

## 4. Scan, and prove the page was in the right state

Click "Scan full page" and give it 30 seconds. Then, before you believe the number, confirm from the pixels that the thing you are testing was actually on screen:

```bash
a11y shot scan-after
# Read the png. Check the URL, and check the component under test is present.
```

axe scans the DOM rather than the viewport, so something below the fold still counts, but something that closed when the page reloaded does not. A Window Manager scan taken after the kubectl shell quietly closed says nothing about the Window Manager, and the total will look plausible anyway.

## 5. The matched pair

The comparison is only worth something if everything except the fix is identical. All of these have to match between the two captures:

- the same URL, down to the fragment
- the same window size and resolution
- the same prerequisite state (the shell open, the wizard on the same step)
- the same panel state (a full-page scan both times, not a scan of a selected element)

Cycle the build under the page rather than moving the page:

```bash
cd /workspace/dashboard
git checkout upstream/master -- <files the fix touches>
# wait for "Compiled successfully in" from the dev server, then a few seconds more
a11y desktop 'xdotool key ctrl+r'; sleep 20      # DevTools is open, so real keys
# re-run the scan, a11y shot scan-before
git checkout HEAD -- <the same files>
git status -s                                     # empty means restored
```

If reopening the prerequisite state needs Playwright, close DevTools first, run the script, then reopen DevTools and get back to the axe panel. Re-verify the state after every reload: reloading closes the Window Manager, and clicking into the page to give it focus can navigate away. Prefer `a11y focus` over clicking into the page.

## 6. Save the finals

```bash
mkdir -p /workspace/screenshots
cp /workspace/artifacts/a11y/scan-before.png /workspace/screenshots/axe-<page>-before.png
cp /workspace/artifacts/a11y/scan-after.png  /workspace/screenshots/axe-<page>-after.png
```

Crop with `ffmpeg -i in.png -vf "crop=W:H:X:Y" out.png` if the capture includes desktop that adds nothing. Keep both halves of a pair at the same size.

The dev-server IP visible in the URL bar does **not** need censoring for a rancher/dashboard PR. It is a private container address.

## 7. Report the numbers honestly

This is where the medium invites overclaiming.

- **Quote the totals as they are, and name the rule.** "7 issues to 6, with `aria-valid-attr-value` eliminated" is the honest reading of a page that has unrelated pre-existing violations. Rounding that to "1 violation to 0" because it reads better is a false claim a reviewer can check in one click.
- **Say what the remaining issues are** if they survive the fix, and why they are out of scope.
- **Caption each pair with the page and the rule**, self-contained, so a reader does not have to reconstruct which screenshot belongs to which defect.
- **Do not let one pair stand in for several fixes.** One before/after per defect.

## Output

- `/workspace/screenshots/axe-<page>-{before,after}.png`, one matched pair per defect.
- The rule id that changed and the exact totals on each side.
- A note of which axe version produced them (the panel prints its axe-core version) and whether it was the extension or injected axe-core.

`my-pr-create` uploads these into the PR. Its notes on asset publishing apply: a fresh attachment URL 404s until the body referencing it is saved, so publish the body with the hrefs and poll afterwards rather than gating the body edit on the href resolving.
