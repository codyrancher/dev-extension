---
name: my-browser-screenshot
description: Take a single annotated screenshot of a page with a labeled header bar, the page URL, red highlight rectangles, and optional text badges pointing at what matters. Same visual language as my-browser-screenshot-comparison but one panel instead of two. Use when you need to show the state of one page rather than compare two, for example evidence in a PR review comment, an issue reproduction, or a bug report.
---

Capture one page through the browser sidecar and composite it with a header bar and red annotations, so the reader can see at a glance what they are looking at and where to look.

Use `my-browser-screenshot-comparison` instead when you have two deployments to put side by side (master vs your branch). Use this skill when there is only one thing to show.

## When to use

- A PR review comment where a screenshot makes the problem obvious. The `my-pr-review` skill asks for the important bits highlighted and notated, which is exactly what `--note` produces.
- Evidence that a bug reproduces, or that a fix works, when a video would be overkill.
- Documenting the current state of a screen in an issue or a summary.

## Running it

```bash
node /workspace/.claude/skills/my-browser-screenshot/my-browser-screenshot.mjs \
  --path /dashboard/c/local/explorer/configmap \
  --title "issue-16755" \
  --subtitle "cluster explorer" \
  --wait-for ".sortable-table" \
  --note ".sortable-table thead th:nth-child(3)=sort arrow points the wrong way" \
  --output /workspace/screenshots/bug.png
```

### Flags

| Flag | Purpose |
|---|---|
| `--url URL` | Full URL to capture |
| `--path PATH` | Path appended to `SCREENSHOT_BASE_URL`, or to `https://$RANCHER_HOST_NAME` |
| `--title TEXT` | Bold header text (default: current branch in `/workspace/dashboard`) |
| `--subtitle TEXT` | Muted text in parentheses after the title |
| `--highlight SELECTOR` | Red outline around matching element(s), repeatable |
| `--note SELECTOR=TEXT` | Red outline plus a labeled badge, repeatable |
| `--wait-for SELECTOR` | Wait for this element instead of `networkidle` (needed for dev servers) |
| `--scroll-to SELECTOR` | Scroll this element into view before capturing |
| `--full-page` | Capture the whole scrollable page instead of just the viewport |
| `--viewport WxH` | Viewport size (default: `1280x720`) |
| `--no-url` | Omit the URL line from the header |
| `--output PATH` | Output file (default: `/workspace/screenshots/screenshot.png`) |

Either `--url` or `--path` is required. Everything else has a sensible default.

### Environment variables

| Variable | Purpose | Default |
|---|---|---|
| `SCREENSHOT_BASE_URL` | Base URL that `--path` is appended to | `https://$RANCHER_HOST_NAME` |
| `SCREENSHOT_LABEL` | Default for `--title` | current git branch |
| `CLAUDE_BROWSER_CDP` | Browser sidecar CDP endpoint | `http://localhost:9222` |

`RANCHER_HOST_NAME` lives in `/workspace/.env`, so `--path` works with no setup once that file is sourced.

## Output format

- Page image at the viewport width (1280 by default)
- A 52px header bar above it: bold title, muted subtitle in parentheses, page URL in monospace underneath
- Red outline rectangles (2px border, 4px padding) around every highlighted or noted element
- For `--note`, a red badge with white text sitting just above the outline, flipped below when it would collide with the header, and nudged inward when it would run off the right edge
- Default total size: 1280 x 772. With `--full-page` the height grows to the document height.

## Workflow

1. **Bring the browser up first.** Run `wait-for-sidecars` before capturing. The script talks to the browser sidecar over CDP and fails immediately if it is not listening.

2. **Find selectors for what you want to point at.** This is the step that decides whether the screenshot is useful. Verify a selector matches and where it sits before you rely on it:

   ```bash
   node /workspace/browser.mjs eval "document.querySelector('.my-selector')?.getBoundingClientRect()"
   ```

3. **Capture with `--note` for anything that needs explaining, `--highlight` for anything that just needs pointing at.** A note carries the sentence you would otherwise have to write underneath the image. Prefer one or two notes: a screenshot covered in badges is as hard to read as one with none.

4. **Read the output back to check it.** Open it with the `Read` tool. Confirm the outlines landed on the right elements and no badge covers something important. Adjust and re-run if not.

## Getting the framing right

- **The element is below the fold.** The default capture is the 1280x720 viewport, so anything further down is cropped and its highlight is dropped. The script warns when this happens (`N highlight(s) fell outside the captured area`). Fix it with `--scroll-to SELECTOR` to bring that element into view, or `--full-page` to capture the entire document.
- **Dev servers never go idle.** Webpack and Vite hold a websocket open for HMR, so `networkidle` never resolves and the capture hangs until it times out. Pass `--wait-for` with a selector that means the page is ready (`.sortable-table`, `[data-testid='header']`).
- **SPAs need a real wait selector.** `--wait-for body` resolves before Vue has mounted, so selectors match nothing and you get an empty-looking page. Wait for something the app itself renders.
- **A selector that matches nothing is a warning, not an error.** The script says which selector missed and still writes the image, so check the output for warnings rather than assuming a clean exit means clean annotations.

## Notes on selectors

- `--note` splits on the first `=` that is outside brackets and quotes, so attribute selectors work unchanged: `--note "input[type=password]=this field keeps focus after submit"`.
- Every matching element gets its own outline. A selector matching six table rows draws six rectangles and six copies of the badge, so target precisely (`tbody tr:nth-child(3)`) rather than broadly.
- Prefer IDs, `data-testid` attributes, or structural selectors over generated class names, which change between builds.

## Sharing the result

Screenshots land in `/workspace/screenshots/` by default. The `my-pr-create` skill uploads files from there to GitHub `user-attachments` so they embed inline in a PR body, and `my-pr-review` uses them inside review comments.
