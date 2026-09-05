---
name: my-a11y-screenreader-video
description: Record a before/after video with real screen reader audio for an accessibility fix, using Orca in the browser sidecar. Captures what Orca says as quotable text first, then muxes its speech onto a scripted screen recording. Use when a fix changes what assistive technology announces, or when asked for a video with audio demonstrating a screen reader.
---

Record what a screen reader actually says, before and after the fix, as a video a reviewer can play.

This is the only evidence that answers "what changes for the person using this page". It is also the most expensive thing in the accessibility toolkit and the easiest to produce dishonestly, so step 1 is deciding whether it is the right medium at all.

Read `.claude/rules/accessibility.md` first. It describes the two layers and how the `a11y` wrapper reaches into the browser sidecar. This skill is the playbook for the audible layer.

## 1. Prove there is something to hear, before recording anything

Most ARIA fixes are silent. `aria-controls` is the standard example: NVDA never announces it, JAWS exposes it on demand, and a before/after clip of that fix sounds identical. Recording one anyway produces a video that implies a difference it does not contain.

Check with the AX tree, which costs one command:

```bash
a11y axtree --url 8005 --role tab --relations --json --save /workspace/artifacts/a11y/ax-before.json
```

Then decide:

| What changed | Evidence to use |
|---|---|
| The role, name, state or position an element reports (`role="tablist"`, a missing label, `aria-selected`) | This skill. The announcement genuinely changes. |
| A relation, an id, an attribute value | `my-a11y-axe-screenshot`, plus an AX tree diff. Nothing is audible. |
| Both, in one PR | Both, each attached to the defect it actually demonstrates. Never let the audible clip stand in for the silent fix. |

If nothing is audible, say so in your summary and stop here. That is the finding, not a failure.

## 2. Turn on the orca tier

```bash
a11y tier            # what is on now
a11y tier orca       # installs Orca, waits for the rebuild
```

Three consequences worth flagging in the conversation before you do it:

- **It recreates the browser container.** Every open tab goes, including any DevTools window. Do this before you set up the scenario, not in the middle of it.
- **First boot installs packages**, a few minutes. `a11y tier` waits, with a 10 minute budget.
- **The orca tier runs the X11 desktop** rather than the Wayland one, because Orca drives libwnck and XInput. Everything else behaves the same.

Then confirm the stack is live:

```bash
a11y status          # tier, what is installed, whether Chromium is on the bus
```

`chromium: launched with --force-renderer-accessibility` and `on the bus: Chromium orca` are the two lines that matter. If Chromium is missing from the bus, `a11y enable` announces an AT and restarts it if it has to.

## 3. Start Orca so its speech is text, not just a wav

```bash
a11y orca start      # starts with --debug-file, so every phrase is logged
```

This is the difference between "the screen reader said X" as a claim and as a quote. Orca writes a `SPEECH OUTPUT:` line for every phrase it sends to the synthesiser, and the wrapper reads them back:

```bash
a11y orca mark       # marker before the interaction you care about
# ... make it speak ...
a11y orca speech     # only what it said since the mark, style noise stripped
```

If Orca was already running from an earlier session it has no speech log. `a11y orca stop` then `a11y orca start`.

Capture the text for both builds before you record anything. If the two are the same, go back to step 1: there is no audible difference and a video will not create one.

## 4. Make it speak

A screen reader says nothing until *platform* focus moves, and this is where most attempts fail:

- **`a11y key` and `a11y type`, never CDP keys.** Playwright's `keyboard.press` moves the page's focus but not the platform focus AT-SPI reports, so Orca stays silent and you conclude the fix does nothing.
- **DOM `.focus()` does raise an AT-SPI focus event**, so `page.evaluate(() => el.focus())` is a legitimate way to land on one specific control. Use it when tabbing to the thing would walk the whole nav chrome first, which it usually does.
- **Tabbing from an arbitrary starting point walks out into the browser UI.** Reset focus to the top of the document first (`document.body.setAttribute('tabindex','-1'); document.body.focus()`), then count your Tabs, or focus the element directly.

Whatever you choose, it has to be the same in the before and after runs, or the two clips are not comparable.

## 5. Record the audio and the video together

Write one Playwright script for `my-browser-record-video`'s `record-script` and run it against both builds. The script must do the focusing in the recorded section, so the frame shows what the audio is describing:

```js
// /workspace/videos/a11y-demo.mjs
export default async function ({ page, startRecording, say, point, pause, waitFor, settle }) {
  const BASE = 'https://<dev-server>:8005';

  // Setup, not recorded.
  await page.goto(`${ BASE }/c/local/fleet/fleet.cattle.io.helmop/create`, { waitUntil: 'domcontentloaded' });
  await waitFor('ul.steps');
  await settle();
  await page.evaluate(() => { document.body.setAttribute('tabindex', '-1'); document.body.focus(); });

  startRecording();
  await pause(600);
  await say('Focus moves to the wizard step list');
  await page.evaluate(() => {
    const ul = document.querySelector('ul.steps');
    ul.scrollIntoView({ block: 'center' });
    ul.focus();
  });
  await point('ul.steps', 'What the screen reader announces');
  await pause(1200, { ack: true });
}
```

Then, per build:

```bash
a11y orca mark
a11y record start
node /workspace/browser.mjs record-script /workspace/videos/a11y-demo.mjs /workspace/videos/after-a11y.webm
a11y record stop          # prints the wav path under /workspace/artifacts/a11y
a11y orca speech          # what it said during that take, as text
```

`a11y record start` unloads PulseAudio's suspend-on-idle, so the wav runs at wall clock and keeps its silence. That is what makes the next step work.

## 6. Mux the speech onto the video

The audio capture starts before the video does, because `record-script` defers frames until `startRecording()`. Both stop together, so **the tail of the audio is the part that lines up**:

```bash
cd /workspace/videos
DUR=$(ffprobe -v error -show_entries format=duration -of csv=p=0 after-a11y.webm)
ffmpeg -hide_banner -loglevel error -y \
  -sseof -"$DUR" -i /workspace/artifacts/a11y/speech-<timestamp>.wav \
  -i after-a11y.webm \
  -map 1:v -map 0:a -c:v copy -c:a aac -shortest after-a11y-with-speech.mp4
```

Trimming from the start instead (`-ss 0`) puts the announcement after the video has ended.

## 7. The before build

Same script, same focus path, source reverted:

```bash
cd /workspace/dashboard
git checkout upstream/master -- <the files your fix touches>
# wait for the dev server to say "Compiled successfully in", then a few seconds more
```

Record, mux, then restore:

```bash
git checkout HEAD -- <the same files>
git status -s        # empty means the tree matches the commit again
```

**Confirm the running build is the one you think it is.** Check the actual page (`document.querySelector('[role="tablist"]')`, the resolved id, whatever the fix changed) before each take. A recording of the wrong build is the single most common way this phase produces a misleading result, and it is invisible afterwards.

## 8. Check what you produced

```bash
for f in before-a11y-with-speech.mp4 after-a11y-with-speech.mp4; do
  echo "$f: $(ffprobe -v error -show_entries format=duration -of csv=p=0 $f)s \
streams=$(ffprobe -v error -show_entries stream=codec_type -of csv=p=0 $f | tr '\n' ',')"
done
ffmpeg -hide_banner -i after-a11y-with-speech.mp4 -af volumedetect -f null - 2>&1 | grep mean_volume
```

One video and one audio stream, a duration that matches the take, and a mean volume that is not silence. Then compare the two `a11y orca speech` transcripts and make sure the clips match them.

The dev-server IP in the overlay URL bar does **not** need censoring for a rancher/dashboard PR. It is a private container address. `my-video-censor-ip` is for genuinely sensitive strings.

## 9. What to say in the PR

- **Quote the announcement, both sides.** "`Metadata Chart Values Target details Advanced.` then `clickable.`" becoming "`Metadata page tab.`" is the finding. The video is the proof of it, not a substitute for stating it.
- **Name the screen reader.** Orca is not NVDA. Rancher users are overwhelmingly on NVDA, JAWS and VoiceOver, which have materially different heuristics. Orca audio is indicative, not authoritative, and authoritative NVDA testing cannot happen in this container at all.
- **Attach each clip to the defect it demonstrates.** A PR fixing three things gets three before/after pairs, each in the medium that shows its difference. One audible clip captioned to imply it covers the silent fixes is the failure mode to avoid.
- **Make the caption self-contained.** A reader should not have to open another section to know what they are listening to.

## Output

- `/workspace/videos/{before,after}-a11y-with-speech.mp4`, plus the `.mjs` that recorded them.
- The `a11y orca speech` transcript for each take.
- `/workspace/artifacts/a11y/ax-{before,after}.json` from step 1, which is the silent half of the same argument.

`my-pr-create` uploads these to GitHub user-attachments so they embed inline. Its notes on asset publishing apply: a fresh attachment URL 404s until the body referencing it is saved, so publish the body first and poll afterwards rather than gating on the href resolving.
