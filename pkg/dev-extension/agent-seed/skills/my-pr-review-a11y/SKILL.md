---
name: my-pr-review-a11y
description: The accessibility pass of a rancher/dashboard PR review. Walks every component the diff touches through the states a page-load scan never sees (open, highlighted, hovered, focused, removed, light and dark), measures it with a11y-probe.mjs, and files pending WCAG 2.2 comments with measured numbers. Called by my-pr-review for any diff that renders UI; use on its own when asked for an accessibility review of a PR.
---

The team reviews against **WCAG 2.2 AA**, and what gets missed is rarely what a scanner reports at page load. rancher/dashboard#19128 is the model for this skill: five findings from reviewing the cluster switcher redesign (#18884), every one of them invisible to an axe run on the page as it loads, and every one likely to be flagged in a VPAT. Your job is to find that class of problem in the PR in front of you, prove each one, and file it the way `my-pr-review` files everything else.

Scope is **what the PR adds or changes**. Accessibility debt already on master is not this PR's problem; `cypress/e2e/tests/accessibility/baseline.json` lists what is already accepted.

## 0. Is there anything to review?

```bash
PR=<number>
curl -s "$CLAUDE_HARNESS_API/my-work/pr/$PR" | jq -r '.files[].path'
```

In scope: `.vue` templates, anything rendering markup, `.scss`/`.css` (colour, focus, size, motion), theme tokens under `shell/assets/styles/`, i18n strings used as labels, keyboard handlers, and `pkg/rancher-components`. Out of scope: tests, CI, docs, types, store logic with no rendered output. **If nothing is in scope, say so in one line and stop.** That is a result, not a failure.

## 1. Read the diff against the catalogue

For each changed component, go through every entry below. Each one is a real finding from #18884/#19128 or its close relatives. Write down every candidate with its file and line; step 2 decides which are true.

### A. Nested interactive content (4.1.2 Name, Role, Value)
An interactive element inside another: `<i role="button" tabindex="0">` inside the row's `<button>` (#19128), a link in a clickable card, a checkbox inside a `role="option"`. Assistive tech flattens or drops the inner control, and a click on it also activates the outer one.
*Look for:* `role="button|link|checkbox|switch|tab|option|menuitem"`, `tabindex="0"`, `@click` on an element whose ancestor is a `<button>`, `<a>`, `summary` or an interactive role.
*Fix:* make them siblings inside a non-interactive wrapper, each with its own name.

### B. Every pointer action reachable by keyboard (2.1.1 Keyboard)
- `@click`/`@mousedown` on a `div`, `span` or `i` with no `tabindex`, no role and no key handler.
- **Composite widgets that do not own all their items.** In #18884 the fixed `local` row sat in a listbox the combobox did not control, and `rows` filtered it out, so arrow keys and Tab skipped the cluster most people switch to. For every combobox, listbox, menu, tree or grid in the diff, list the items a mouse user can reach, then check the keyboard model reaches the same set (`aria-controls`/`aria-owns` covers them, the arrow-key handler iterates them).
- Hover-only affordances (a pin, a delete icon) with no focus equivalent.

### C. Keyboard features nobody can discover (2.1.1, and a VPAT usability risk)
An action that only exists as a shortcut, where the shortcut is only announced to screen readers (visually hidden text, `aria-keyshortcuts` with nothing on screen). #19128: keyboard users cannot pin a cluster unless they already know the shortcut. Not every instance is a strict WCAG failure; say which it is. Suggest a visible hint (a footer, a tooltip, an entry in the component's help).

### D. Focus when the DOM changes under it (2.4.3 Focus Order, 4.1.3 Status Messages)
- **Removing the element that has focus.** Unpinning removed the focused row, focus fell to `<body>`, and nothing was announced (#19128). For every `v-if`, list filter, delete, unpin, dismiss or close in the diff, ask where focus goes. It should go to the next or previous item, or to a heading or the trigger, with an `aria-live` announcement ("local unpinned").
- Closing a popup, flyout, dialog or slide-in must return focus to its trigger (`RcDropdown`'s `returnFocus`, `@shell/composables/focusTrap`).
- Async results (search counts, "no results", loading, errors) need a live region, which the repo already uses (`aria-live="polite"` in `ClusterSwitcher.vue`, `NamespaceFilter.vue`).

### E. Contrast in every state and both themes (1.4.3 Contrast, 1.4.11 Non-text Contrast)
Text needs 4.5:1, or 3:1 when large (at least 24px, or at least 18.66px bold). Icons, control borders and focus rings need 3:1. #19128: `var(--muted)` subtitles on a highlighted row were **4.3:1 in light mode** (`#6F6F8B` on `#F1F1F1`) and **3.9:1 in dark** (`#8f8f9c` on `#31343B`).
*Where it hides:* backgrounds built with `color-mix(... transparent)`, `rgba()` or `opacity`, which axe files as "incomplete" rather than failing; `:hover`, `.active`, `.highlighted` and `.selected` states; and the other theme. **Never eyeball contrast and never trust a resting-state scan.** Measure it (step 2).

### F. ARIA that promises a pattern the widget does not implement (4.1.2, 1.3.1)
`aria-haspopup="listbox"` on a trigger whose panel is not a listbox (#19128: it behaves like a dialog). `role="menu"` without arrow-key navigation, `role="listbox"` without `aria-selected` and roving focus or `aria-activedescendant`, or `aria-expanded` that never changes. Check the pattern against the W3C APG (<https://www.w3.org/WAI/ARIA/apg/patterns/>). When the panel holds mixed controls (search, buttons, links), the honest role is usually `dialog`.
*Also:* `aria-controls`, `aria-labelledby` and `aria-describedby` pointing at an id that a `v-if` has not rendered. The relation silently disappears.

### G. Meaning carried by colour, or status that vanishes (1.4.1 Use of Color, 1.3.1)
A state shown only as a colour, and styling that silently fails. In #18884 `stateColor` was a class name bound as `style="color: text-info"`; the browser dropped it, and a Pending cluster showed **no status at all**. Check that every status has text or an accessible name, not just a colour.

### H. Names and labels (1.1.1, 2.5.3 Label in Name, 4.1.2)
Icon-only buttons and links need an accessible name, localised through `t()`. Inputs need a label. An `aria-label` must contain the visible text. Decorative icons need `aria-hidden="true"`.

### I. New in WCAG 2.2
- **2.5.8 Target Size (Minimum):** new click targets under 24×24 CSS px (the pin was 14×14) unless spaced so a 24px circle around each does not overlap another.
- **2.4.11 Focus Not Obscured:** a sticky header, flyout or toast covering the focused element.
- **2.5.7 Dragging Movements:** any new drag-and-drop needs a single-pointer alternative.

### J. Focus visible (2.4.7)
`outline: none` or `outline: 0` with no `:focus-visible` replacement, on anything focusable the diff adds or restyles.

## 2. Prove it in the running PR build

A candidate becomes a comment only after it is shown in the page. The workspace dev server runs the PR branch at `https://localhost:8005` (`dev-server status`); sign the browser in with `node /workspace/bin/rancher-login.mjs` if it isn't already.

**Enumerate the states first.** For each changed component write the list: closed, open, empty, loading, error, one item, many items, row highlighted by keyboard, row hovered, control focused, item removed (unpin, delete, dismiss), light and dark. Most of #19128 only exists in one of those.

Then measure each state with the probe. It drives the component into the state, then checks contrast (with backgrounds composited, real hover and focus), nested interactive content, broken relations, `aria-haspopup` against the role of what it controls, accessible names from Chromium's own AX tree, 2.2 target size, where focus goes after each key, and axe-core scoped to the component, **including axe's "incomplete" results**. It runs every state in both themes:

```bash
PROBE=/workspace/.claude/skills/my-pr-review-a11y/a11y-probe.mjs
node $PROBE --goto 'https://localhost:8005/dashboard/c/local/explorer' \
  --steps 'click:[data-testid="top-level-menu"]; wait:.cluster-switcher' \
  --scope '.cluster-switcher' \
  --hover '.cluster-switcher .row' \
  --focus '.cluster-switcher button, .cluster-switcher [tabindex="0"]' \
  --keys 'Tab,ArrowDown,ArrowDown,Enter' \
  --json /workspace/artifacts/review/a11y/cluster-switcher-open.json
```

`--steps` reaches the state (`click:`, `hover:`, `focus:`, `key:`, `type:`, `wait:`, `sleep:`). Run the probe once per state; a removal state is a `--keys` walk that ends on the key that removes the item. Each theme reloads the page and reaches the state again, so the themes don't leak styling into each other. Your own theme preference is never changed.

What it cannot decide, you check by hand, and your comment should say that is how it was checked:

- **B** Walk the composite with the arrow keys (`--keys 'ArrowDown,ArrowDown,...'`, one press per item) and compare the `activedescendant`/focus sequence against the items on screen. An item the walk never lands on is the finding.
- **C** The shortcut: is there anything on screen that tells a sighted keyboard user it exists?
- **F** Pattern conformance beyond the role: does the keyboard model match the APG pattern the role promises?
- **G** Colour-only meaning: read the template and the rendered page, not the numbers.
- An `undecidable` contrast (a background image or gradient): screenshot it and measure with the eyedropper, or say so.

For anything audible, the tools in `.claude/rules/accessibility.md` apply: `a11y axtree --relations` for before/after trees, and Orca for what is actually announced. `my-a11y-axe-screenshot` captures the real axe panel as evidence.

## 3. What earns a comment

Everything in `my-pr-review` applies: no nits, one to two sentences, a real problem, a permalink, a fix when one is easy. For accessibility specifically:

- **Measured, not asserted.** "`var(--muted)` on the highlighted row is 4.3:1 in light (`#6F6F8B` on `#F1F1F1`) and 3.9:1 in dark; 1.4.3 needs 4.5:1" beats "contrast looks low".
- **Cite the success criterion** (WCAG 2.2 number), and say plainly when a finding is a usability or VPAT risk rather than a strict failure (C usually is).
- **Only what the PR changes.** Existing debt on unchanged lines stays out, even when the probe reports it.
- **One comment per defect, anchored where the fix goes:** the template line with the nested control, the SCSS line with the colour, the handler that removes the row.
- **Attach the evidence** the probe or a capture produced (`attachments` with a `[[attach:…]]` marker), exactly as `my-pr-review` describes. Never upload anything to GitHub yourself.
- Don't repeat what a reviewer already raised (`reviewComments` in the GET).

Examples in the shape to aim for, taken from #19128:

> `TopLevelMenu.vue`: the pin is `<i role="button" tabindex="0">` inside the row's `<button>`, which is nested interactive content (4.1.2). Screen readers drop or merge the inner control. Make the pin a sibling of the row button, with its own `aria-label`.

> Unpinning removes the row that holds focus, so focus drops to `<body>` and nothing is announced (2.4.3, 4.1.3). Move focus to the next or previous row, or the list heading, and announce "{cluster} unpinned" through a polite live region.

> `aria-haspopup="listbox"` but the panel is not a listbox: there is no `role="listbox"`, no `aria-selected` and no arrow-key model. With a search field and buttons inside, it behaves like a dialog, so use `aria-haspopup="dialog"` and `role="dialog"` with a label.

## 4. File, and leave the follow-up ready

File the survivors through `$CLAUDE_HARNESS_API/my-work/pr/$PR/comments`, as pending comments, exactly as `my-pr-review` describes in "Where to file the comments". Never submit.

Then write `/workspace/artifacts/review/a11y-findings.md` in the shape of #19128, so a person can turn it into a follow-up issue in one paste: a checklist grouped by component, one line per finding with the measured numbers, and footnote permalinks pinned to the PR head SHA. **Do not file that issue.** Whether follow-up belongs in this PR or in an issue is the reviewer's call.

## Finish

Report to the caller in a few lines: which components and states you measured, how many candidates you had and how many survived, the comments filed (file, line, criterion), anything you could only check by hand, and the path of `a11y-findings.md`. If there was nothing in scope, one line saying so.
