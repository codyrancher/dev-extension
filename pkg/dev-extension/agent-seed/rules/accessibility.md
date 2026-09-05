# Accessibility tooling

For an accessibility bug, "the linter stopped complaining" is not evidence.
What you can show instead is the tree assistive technology actually consumes,
and — when it is audible — what it says. Two layers do that, and they answer
different questions.

## Layer 1: Chromium's own AX tree (nothing to install)

```bash
a11y axtree --url /dashboard/about --role tab --relations
a11y axtree --grep "View Licenses" --relations --json --save /workspace/artifacts/ax-before.json
```

`axtree` reads `Accessibility.getFullAXTree` over CDP: Chromium's computed
accessibility tree, which is literally what it hands to an AT. Use it first,
always, and use it for before/after evidence:

- A relation whose IDREF does not resolve **is not in this tree at all**. So
  `controls: []` before the fix and `controls: ["step-container-basics"]` after
  it is the finding, stated at the layer that matters, and axe cannot show it.
- A name that never resolved comes out empty here even when the markup looks
  right.
- The role is the one Chromium *mapped*, not the one you authored.

Save a dump before the change and after it, and diff them. That is the whole
argument for most ARIA fixes, and it costs one command.

## Layer 2: the Linux AT stack in the browser sidecar

Higher fidelity: it exercises Chromium's ATK bridge (the same channel a Linux
screen reader reads) and it can produce audio. It is **off by default** because
the packages are large and most projects never need them. Turn it on per
project:

```bash
a11y tier              # what is on now
a11y tier atspi        # AT-SPI bridge: read the tree an AT reads
a11y tier speech       # + espeak-ng, speech-dispatcher, parec/sox capture
a11y tier orca         # + the Orca screen reader
```

Changing the tier **recreates the browser container** and its first boot spends
a few minutes installing (`a11y tier` waits for it, with a 10 minute budget).
Whatever was open in the browser is gone afterwards, so do this before you set
up the scenario, and say so in the conversation if someone may be watching the
browser tab. The setting is also on the project's **Sidecars** tab in the
portal.

Then:

```bash
a11y status                          # what is installed, and whether Chromium is exporting
a11y enable                          # announce an AT, start the registry, restart the browser if needed
a11y tree --relations --role tab     # the AT-SPI tree, relations included
a11y say "tab list, Metadata, tab, selected, 1 of 5"   # espeak-ng to a wav
a11y record start                    # capture what the desktop plays
a11y orca start                      # a real screen reader in the session, with its speech logged
a11y orca mark                       # marker in the speech log, before the interaction
a11y orca speech                     # what Orca has said since the mark, as text
a11y key Tab Tab Return              # real key presses — what makes Orca announce something
a11y record stop                     # prints the wav path
```

And, for anything that only exists on the desktop (an extension panel, a native
menu, a screenshot of either):

```bash
a11y screen 1600x1000                # set the resolution, then report the real pointer bounds
a11y focus                           # raise and activate the browser window
a11y click 626 411                   # move, check the pointer landed there, click
a11y shot scan-after                 # the whole desktop to artifacts/a11y/scan-after.png
a11y desktop 'xdotool key F12'       # anything else, with DISPLAY set
```

Six things worth knowing before you rely on them:

- **`a11y enable` may restart the browser.** Chromium decides whether to export
  a tree when it starts, so if it started before an AT announced itself the
  only fix is a restart, and that closes open tabs. It only does this when
  Chromium is genuinely absent from the bus.
- **`a11y key` exists because CDP keys are not enough.** Synthesised CDP input
  moves the page's focus but not the platform focus AT-SPI reports, and a
  screen reader says nothing until focus actually moves. Drive the keyboard
  through `a11y key` / `a11y type` when you want Orca to speak.
- **The `orca` tier switches the desktop to X11.** Orca drives libwnck and
  XInput, which fail immediately on this image's rootless Xwayland, so
  selecting that tier runs the sidecar's X11 desktop instead of the Wayland
  one. Everything else works the same; it is another reason not to reach for
  the top tier by default.
- **Recordings keep silence.** `record start` unloads PulseAudio's
  suspend-on-idle, so the wav runs at wall-clock and lines up with a screen
  recording rather than collapsing to just the noisy parts.
- **Orca's speech is available as text.** `orca start` launches it with a debug
  file, and `orca mark` / `orca speech` read back the `SPEECH OUTPUT` lines for
  one interaction. Quote those in a PR: an audio clip alone is a claim nobody
  can check without headphones.
- **The pointer is bounded by the framebuffer, not by the mode.** If the two
  disagree, every click past the edge silently lands somewhere else and reads
  as "the button did nothing". `a11y screen` probes the real bound and fits the
  window inside it; `a11y click` re-checks on every click. Playwright also
  cannot attach over CDP while DevTools is open, so close it first or drive the
  page with real keys.

Files land in `/workspace/artifacts/a11y`, which is the same directory the
sidecar sees as `/artifacts` — a recording made over there is readable here
immediately. Mux it onto a screen recording with the `ffmpeg` in this
container:

```bash
ffmpeg -i artifacts/demo-changes/demo-changes.mp4 -i artifacts/a11y/speech-*.wav \
       -c:v copy -shortest artifacts/demo-changes/with-speech.mp4
```

## Producing the evidence

Two skills own the end-to-end capture, including the before/after build cycle
and what the PR is allowed to claim:

- `my-a11y-screenreader-video` for the audible half: Orca speech as quotable
  text, then muxed onto a scripted recording.
- `my-a11y-axe-screenshot` for the silent half: the real axe DevTools panel,
  captured as a matched before/after pair.

## Three things to be honest about in a PR

- **`aria-controls` is close to inaudible.** NVDA does not announce it at all
  by default; JAWS exposes it on demand. A before/after audio clip of an
  `aria-controls` fix sounds identical. Its value is that the relation becomes
  programmatically determinable and the ARIA becomes valid — which the AX tree
  shows and audio cannot.
- **Orca is not NVDA.** Rancher users are overwhelmingly on NVDA, JAWS and
  VoiceOver, which have materially different heuristics. Orca audio is
  indicative, not authoritative; authoritative NVDA testing means driving real
  NVDA on Windows, which cannot run in this container at all. Say which one
  produced any clip you attach.
- **Say what changed audibly, if anything.** Adding `role="tablist"` turns
  "list, 9 items" into "tab list, selected, 1 of 5" — that is a real audible
  difference and worth recording. Do not let a recording of that improvement
  imply it demonstrates a different, silent fix in the same PR.

## How this is wired, when something looks broken

- The AT stack has to live in the browser sidecar: AT-SPI, X and PulseAudio are
  session-local, and this container shares only the sidecar's *network*
  namespace, not its desktop.
- This container has no docker socket and no sudo, so `a11y` reaches into that
  container through the harness API
  (`POST $CLAUDE_HARNESS_API/projects/$HARNESS_PROJECT/sidecars/browser/exec`,
  see `sidecars.md`). If `a11y status` errors, check `$CLAUDE_HARNESS_API` is
  set — a non-interactive shell has it empty (`project-environment.md`).
- `a11y tree` failing with "Chromium is not on the accessibility bus" means
  either the tier is off, or nothing has claimed to be an AT yet. `a11y enable`
  does the latter; Chromium only exports its tree once something has.
