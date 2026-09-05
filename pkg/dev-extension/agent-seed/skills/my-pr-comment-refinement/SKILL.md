---
name: my-pr-comment-refinement
description: Rewrite a pending PR review comment into three one-line answers — how it impacts the user, why we should care to fix it, and a video or screenshot demonstrating the impact and how to reproduce it. Use after a review files comments, before a human reads them, or whenever asked to refine, tighten or rework a review comment.
---

A review comment that only describes the code makes the author work out whether it matters. This step does that work for them: every comment ends up answering three questions, one line each, with evidence attached.

You are given one comment id. Work only on that one.

```bash
PR=<number>; ID=<comment id>
curl -s "$CLAUDE_HARNESS_API/my-work/pr/$PR" \
  | jq --argjson id "$ID" '.localComments[] | select(.id == $id)'
```

## The shape

Rewrite the body to exactly this, nothing before it and nothing after:

```
**User impact:** Saving a cluster with no name silently does nothing, the form just sits there.
**Why fix it:** The user has no way to tell the save failed, so they retry and file a bug.
**Repro:** Cluster Management > Create, leave Name empty, click Create: [[attach:silent-save.webm]]
```

One line per section. If a line needs a second sentence to be true, keep it, but never a paragraph, and never a fourth section.

## Answering each line

**How does this impact the user.** Describe what the person using Rancher sees, not what the code does. **If it doesn't impact the user, say so outright** and move the real cost to the next line:

```
**User impact:** None, this is invisible to the user.
```

That is an honest answer, not a reason to pad. A comment whose impact is genuinely none survives only when the second line carries real weight (a correctness bug that hasn't surfaced yet, a security or performance problem, a trap the next person to touch this file walks into). If neither line lands, the comment was a nit. Delete it:

```bash
curl -s -X DELETE "$CLAUDE_HARNESS_API/my-work/pr/$PR/comments/$ID"
```

**"Invisible to a sighted user" is not "no user impact."** An accessibility
finding impacts the person using a screen reader, and that is the user the line
has to describe: what assistive technology announces, or fails to announce, at
the moment they reach the control. `a11y axtree` settles it in one command and
costs nothing:

```
**User impact:** A screen reader reaches the wizard steps as "clickable" with no role, so there is no way to tell it is a step list.
```

Only write "None" when nothing consumes the change, AT included.

**Why we should care to fix it.** The cost of leaving it in, in this PR's terms: bug reports, data the user loses, a role that can't complete the task, work the next change inherits. Not a restatement of line one. If the fix is a one-liner, that belongs here too, in the same sentence.

**Demonstrate it.** This line is the reproduction, and it carries the evidence:

- Name the clicks, in order, so the author can follow them without watching first. Screen names and field labels, not prose.
- Highlight the part that matters so the author doesn't hunt for it.
- **When the impact is none**, there is nothing to film. Prove it in code instead: a failing test, a console snippet, or a permalink to the path that breaks, and say plainly that it isn't reachable from the UI yet.

### Pick the medium by what actually changed

The wrong medium doesn't just fail to help, it implies a difference the file
doesn't contain. Decide before you record:

| What the comment is about | Evidence |
|---|---|
| Something visible on screen | `my-browser-screenshot` for one state, `my-browser-record-video` for a sequence |
| The role, name, state or position an element reports to AT | `my-a11y-screenreader-video` — the announcement genuinely changes |
| A relation, an id, an attribute value | `my-a11y-axe-screenshot` plus an `a11y axtree` diff — **nothing is audible** |
| Both, in one comment | Both, each attached to the defect it actually demonstrates |

Most ARIA findings are silent. `aria-controls` is the standard example: a
before/after screen reader clip of it sounds identical, so recording one is a
claim the audio doesn't support. Check with `a11y axtree --relations` first, and
if nothing is audible say so in the line rather than filming it anyway. An
unresolved IDREF is absent from the AX tree entirely, which is a cleaner finding
than any screenshot: `controls: []` before, `controls: ["step-container-basics"]`
after.

### Claim exactly what the evidence shows

- **Quote axe totals as they are and name the rule.** "7 issues to 6, with
  `aria-valid-attr-value` eliminated" is the honest reading of a page carrying
  unrelated pre-existing violations. Rounding it to "1 to 0" because it reads
  better is a false claim the author can disprove in one click.
- **Quote the announcement on both sides** when the evidence is audio. The
  quote is the finding; the video is proof of it, not a substitute for stating it.
- **Name the screen reader.** Orca is not NVDA, and Rancher users are
  overwhelmingly on NVDA, JAWS and VoiceOver. Orca output is indicative, not
  authoritative, and the line should not imply otherwise.
- **One piece of evidence per comment.** Never let a clip captured for another
  finding stand in for this one because it's already recorded.
- The dev-server IP in a screenshot or URL bar does **not** need censoring for a
  rancher/dashboard PR, it's a private container address. Run genuinely
  sensitive strings — a customer hostname, a public address — through
  `my-video-censor-ip` before attaching. Submitting the review publishes these.

### Capturing is serial

There is one browser sidecar per project: one X session, one DevTools, one AT
bus. If several refinement agents run at once, only one may drive it at a time,
and the rest wait. Two specific collisions to expect:

- **Playwright can't attach while DevTools is open.** `connectOverCDP` hangs, so
  an axe capture blocks every scripted recording for as long as the panel is up.
- **`a11y tier orca` recreates the browser container** and takes every open tab
  with it. If a comment needs Orca, that decision belongs to whoever is
  sequencing the run, before anyone opens a page.

A comment that needs no new capture is not affected. Refine it and finish.

## Write it back

```bash
curl -s -X PUT "$CLAUDE_HARNESS_API/my-work/pr/$PR/comments/$ID" \
  -H 'Content-Type: application/json' -d '{
    "body": "**User impact:** …\n**Why fix it:** …\n**Repro:** Cluster Management > Create, leave Name empty, click Create: [[attach:silent-save.webm]]",
    "attachments": [
      {"path": "/workspace/artifacts/review/silent-save.webm",
       "caption": "the save does nothing and the form stays put"}
    ]
  }'
```

- `path` is yours (`/workspace/...`), resolved inside this project; anything outside it is refused.
- `[[attach:<filename>]]` is replaced by the real embed at submit time. Leave the marker out and the file is appended to the end instead.
- Never upload to GitHub yourself. The harness uploads when the human submits the review, which is the same moment the comment becomes public.
- `"attachments": []` clears them.

## House style

These override anything the original comment did:

- No em dashes. Use a comma, a colon, or a second sentence.
- No preamble, no restating the diff, no "great catch" or "fine if you prefer".
- Drop file paths, symbol locations and line refs. The comment is already pinned to the line.
- Keep the original's technical claim intact. This step rewrites how it reads, it does not soften a real problem into a suggestion. If refining it exposes that the claim is wrong, put an `Edit:` at the top saying what you found and then delete it if nothing useful is left.
- PR-level comments (`"level":"pr"`) are context for the whole review, not findings. Leave them alone.

## Finish

One line: what the comment claims, what its user impact turned out to be, and what evidence you attached, or that you deleted it and why.
