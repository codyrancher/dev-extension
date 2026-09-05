---
name: my-pr-checklist
description: Work every item in the rancher/dashboard PR template checklist rather than ticking it blind. Does the work each item asks for where that is possible (self review, tests, light and dark mode, accessibility, the three global roles), ticks only what is genuinely true, and reports which items only the user can satisfy. Use after opening a PR, or when asked to complete, fill out, or go through a PR's checklist.
---

The checklist is a set of instructions, not a formality. Each unticked box names work someone has to do. Go through them one at a time, do the ones you are capable of, and leave the rest unticked with a stated reason. A ticked box you did not earn is worse than an unticked one: it tells the reviewer a check happened when it did not.

Read the current state first, since the PR body may already have items filled in:

```bash
gh pr view <PR> -R rancher/dashboard --json body -q .body
```

## The items, and what each one actually requires

**`The PR is linked to an issue and the linked issue has a Milestone, or no issue is needed`**

Confirm the body contains `Fixes #<N>` and that GitHub picked it up, then check the issue itself has a milestone.

```bash
gh pr view <PR> -R rancher/dashboard --json closingIssuesReferences
gh issue view <N> -R rancher/dashboard --json milestone,labels
```

Tick if both are true. If the issue has no milestone, leave it unticked and say so: setting it is the user's call.

**`The PR has a Milestone`**

The user's to set. Leave unticked, mention it. This is one of the two boxes that keeps the `Description` CI job red; see below.

**`The PR template has been filled out`**

Every section carries real content: the summary, what changed, technical notes, what to test, what could regress, and the media. "N/A" is acceptable only where it is genuinely not applicable, and never for "areas that should be tested". Fill anything thin, then tick.

Technical notes is the exception. A bare `Nothing notable.` is the correct content there unless something was surprising, unintuitive or unconventional, so do not treat it as thin and do not pad it to make this item feel earned. See `my-pr-fill-template` for the bar.

This is the one item on the list you can tick by simply asserting it, so do not. It is a gate with four conditions, and each is checkable. Run the checks, then tick, and if one fails, fix the body rather than the tick. They are the three rules in `my-pr-fill-template` ("The three rules") plus the render check, because this is the item that catches a body which is complete but unusable:

- **Runnable.** Can a reviewer get to the changed screen using only what is in the body? If the change needs CRDs, a chart, or a fixture, the install command and the manifest are in "Areas or cases that should be tested". No fixture means the reviewer cannot see the change at all, so this item is not satisfied no matter how much prose is above it. Every setup step you list must be load-bearing: a step that changes nothing costs you the reviewer's trust in the rest of the body, so verify each against the code path before ticking.
- **Terse.** **Authored prose under 450 words**, where authored prose is the body minus fenced code blocks, minus the `<details>`/`<summary>` tags, and minus the 9 verbatim checklist lines. Count it with the script in `my-pr-fill-template` ("The three rules", rule 1) and check it against that skill's per-section table, whose rows are per-section ceilings that sum to less than 450. Do not eyeball it and do not count the whole body: the fixed costs alone run to several hundred words, so a whole-body cap is unsatisfiable rather than strict. If the count is over, the cut is almost always lines that restate the diff.
- **Media.** Before and after, walking the same path, whenever the change is visible at all. Two videos or two screenshots; one of each is fine. Each needs a caption naming what to look at, and the after says "the same walk". Nothing to show is a claim you have to justify, not a default.
- **Renders correctly.** Run the GFM render check in `my-pr-create` ("Verify the published body") and confirm one task list of exactly 9 items with `p-wrapped=0`. A source-level `grep -c` does not catch the loose-list bug.

**`The PR has been self reviewed`**

Only tick this if `my-fix-verify` actually ran over this diff. If it did not, run it now before ticking. If it turns up something real, fix it and push rather than ticking over the top of it.

**`The PR has a reviewer assigned`**

The user's to set. Leave unticked, mention it. The other of the two boxes keeping `Description` red.

**`The PR has automated tests or clear instructions for manual tests and the linked issue has appropriate QA labels, or tests are not needed`**

Two halves, both yours:

- Tests: there should be a test that fails without the fix, proven in `my-fix-verify`. If the fix genuinely had no test seam, write the manual test instructions into "Areas or cases that should be tested" at the same detail as the reproduction procedure: numbered steps, concrete UI targets, and the observation that distinguishes pass from fail.
- QA labels: check what the issue carries (`gh issue view <N> -R rancher/dashboard --json labels`). You can add a label you are confident about; if it is a judgement call, say which label you think it needs and leave it to the user.

Tick when the tests-or-instructions half is genuinely satisfied, and note separately if the labels are outstanding.

**`The PR has reviewed with UX and tested in light and dark mode, or there are no UX changes`**

If the diff touches no template, style, or user-visible string, tick it as "no UX changes" and say that.

Otherwise actually load the affected screen in both themes and look. Toggle via the user avatar menu > Preferences > Theme.

```bash
node /workspace/browser.mjs --new-tab goto https://<project>-rancher/...
```

Capture a `my-browser-screenshot` of each theme and attach them if anything shifted. Watch specifically for literal colours that do not adapt, insufficient contrast in dark mode, and borders that vanish against the dark background. Tick the "tested in light and dark mode" half; the "reviewed with UX" half is a human review, so name it as outstanding unless there are no UX changes.

**`The PR has been reviewed in terms of Accessibility`**

Do the review, do not assume. For every interactive element in the diff:

- It has an accessible name, from visible text, `aria-label`, or `aria-labelledby`, and that name comes from a translation key rather than a literal string.
- It is reachable and operable by keyboard: focusable, has a visible focus ring, and responds to Enter or Space. A `div` with a click handler is not.
- Its role is correct, and any `aria-*` reference (`aria-controls`, `aria-describedby`, `aria-labelledby`) points at an id that actually exists on the page.
- State is exposed: `aria-expanded` on disclosures, `aria-selected` on tabs, `aria-invalid` plus a linked message on invalid fields.
- Nothing conveys meaning by colour alone.

Tab through the affected screen in the live UI. Tick when you have done this and state what you checked. If the diff genuinely contains no interactive markup, say that instead.

When the PR *is* the accessibility fix, a tick is not enough and the checks above are the wrong tool: dump Chromium's own AX tree either side of the change (`a11y axtree`, see `.claude/rules/accessibility.md`), then attach evidence in the medium that shows the difference. `my-a11y-axe-screenshot` for a fix a screen reader cannot hear, `my-a11y-screenreader-video` for one it can.

**`The PR has considered, and if applicable tested with, the three Global Roles Admin, Standard User and User Base`**

"Considered" is always yours. State whether the changed code path is gated by RBAC at all, and how you determined that.

"Tested" is yours when the change is role-sensitive: create a standard user, log in as them, and walk the same screen.

```bash
# admin credentials are in /workspace/.env
set -a; . /workspace/.env; set +a
```

Only tick this box if you actually exercised the change as more than one role. Considering it and finding no RBAC involvement is worth telling the user, but it does not belong in the technical notes unless what you found was surprising, and it is not the same claim as testing it.

## Applying the result

Edit the body in place, preserving every section and every checklist line. Tick by turning `- [ ]` into `- [x]`, and do not reword or drop the items you are leaving unticked.

Three formatting invariants to **preserve** while you are in there. They are not defects in the upstream template: `.github/pull_request_template.md` at HEAD already ships all 9 items as `- [ ]`, one per line, contiguous, with zero `- []`. They break when a hand edit reintroduces them, so check the file rather than assuming either way.

- `- []` (no space) renders as literal text, not a checkbox. Every one stays `- [ ]`.
- The items are long. Do not wrap them to make the source readable; a wrapped line splits the list item and the second half renders as a stray paragraph.
- No blank line between any two of the 9 items. One makes Markdown render the list *loose*, wrapping every item in a `<p>` and visibly stretching the spacing between checkboxes.

```bash
gh pr view <PR> -R rancher/dashboard --json body -q .body > /tmp/pr-body.md
# edit /tmp/pr-body.md
gh pr edit <PR> -R rancher/dashboard --body-file /tmp/pr-body.md
gh pr view <PR> -R rancher/dashboard --json body -q .body | grep -c '^- \[[ x]\] '   # expect 9
```

That `grep` proves the source, not the render. Finish with the GFM render check in `my-pr-create` ("Verify the published body") and confirm one task list, `li=9`, `p-wrapped=0`.

### The `Description` CI job stays red, and that is correct

`.github/workflows/valid-pr.yaml` runs a job named **`Description`** that fails while **any** box in the body is `[ ]`. Leaving `The PR has a Milestone` and `The PR has a reviewer assigned` unticked, which this skill requires, therefore turns that job red. **That is the expected terminal state of a draft you hand over.** It goes green when the user sets the milestone and the reviewer and ticks those two boxes. Say so in your report so nobody reads the red X as your bug.

**Never tick a box to turn `Description` green.** A ticked box you did not earn is worse than an unticked one, and doing it to satisfy a CI check is that failure with a motive attached.

The script greps the whole body for `\[.\]`, one character between the brackets, so a stray `[ ]` anywhere - prose, a fenced block, the fixture YAML - fails the job just as an unticked item would. Check before you finish:

```bash
gh pr view <PR> -R rancher/dashboard --json body -q .body | grep -n '\[.\]' | grep -v '^[0-9]*:- \[[ x]\] '
```

**Do not append your evidence to the body.** The temptation after doing this work is a "Notes on the checklist" appendix explaining how each box was earned. It doubles the length of the PR for content aimed at the user, not at a reviewer. At most four short lines survive into the body, and only for things a reviewer acts on: which items are the user's, and any finding that changes how the change should be reviewed. Everything else goes in the report below.

**Where those lines go: above `### Checklist`, or below it as plain paragraphs. Never as `- ` bullets below it.** A `- ` bullet one blank line under the last `- [x]` is not a new list - Markdown absorbs it into the task list, so nine checkboxes plus three notes render as a 12-item loose list and every checkbox on the page gets stretched apart. The boxes still tick, which is why this ships unnoticed. Plain paragraphs terminate the list cleanly and cost no extra words.

If working an item required a code change (a missing aria-label, a hardcoded colour, a new test), commit and push it, then re-run the affected checks. Do not describe the fix in the checklist and leave it unwritten.

The PR stays a **draft**. The user promotes it.

## Report

Per item, one line: ticked and what you did to earn it, or unticked and why. Close by listing exactly what is left for the user, which is normally the milestone, the reviewer, the UX review sign-off, and any QA label that needed a judgement call.

State plainly that the `Description` CI job is red *because* the milestone and reviewer boxes are honestly unticked, and that it turns green when the user does those two things. Otherwise the first thing they see is a failing check with no explanation.
