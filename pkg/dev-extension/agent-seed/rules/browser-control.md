# Browser Control (Playwright over CDP)

You can drive the browser sidecar (Chromium running alongside this project) via Playwright CDP. The debugging endpoint is exposed at `$CLAUDE_BROWSER_CDP` (already set in `.bashrc`). A helper script lives at `/workspace/browser.mjs`:

```bash
# take a full-page screenshot
node /workspace/browser.mjs screenshot https://{{projectName}}-rancher /workspace/shot.png

# record a video (default 10s, VP9 webm) — auto-injects an overlay showing
# the URL (bottom bar), a cursor dot tracking the pointer, click ripples,
# and keystroke badges so the webm reflects input actions
node /workspace/browser.mjs record https://{{projectName}}-rancher /workspace/repro.webm 15000

# navigate the active tab (preserves user's session/cookies)
node /workspace/browser.mjs goto https://{{projectName}}-rancher/dashboard/c/local/explorer

# evaluate JS in the active tab
node /workspace/browser.mjs eval "document.title"

# --new-tab: open a fresh tab for this command and auto-close it on exit
# (instead of stomping on whatever tab the user has open)
node /workspace/browser.mjs --new-tab goto https://github.com/...
```

The helper connects to the *existing* browser tab by default, so you inherit whatever the user is currently looking at (including logged-in session). Use this for:
- Reproducing issues step-by-step and recording the repro
- Capturing before/after screenshots for PRs (paste into the "Screenshot/Video" section of the PR template)
- Inspecting DOM state when debugging

**Always pass `--new-tab` for transient/automated work** (scraping, github uploads, background checks). The user often has tabs open they're working in — reusing them navigates them away. With `--new-tab`, a fresh page is created for the command and closed when it exits.

For richer automation, import `playwright-core` directly in a script — the helper is just a thin wrapper. When using `playwright-core` directly, do the same thing: `await ctx.newPage()` for transient work, and `await page.close()` when done.
