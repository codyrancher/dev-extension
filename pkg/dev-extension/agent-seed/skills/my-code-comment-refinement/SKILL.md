---
name: my-code-comment-refinement
description: Evaluate every comment a change adds to rancher/dashboard and delete the ones that do not document a public interface, before anything is committed. Lists the added comments exactly (committed on the branch, staged, unstaged and untracked; moved comments and pragmas excluded), then keeps only contract documentation. Runs first in my-commit-create and before any other commit; use on its own when asked to clean up comments in a change.
---

The house rule: **comments document public interfaces, nothing else.** A comment that narrates the next line, restates the diff, explains an implementation choice or tells the story of the fix does not go upstream. The code is made plain enough to stand without it, and anything a reviewer genuinely needs to know goes in the PR description.

This runs **before every commit**, so a comment that should not exist never lands in history. Finish it before you stage.

## 1. List what the change adds

In the checkout:

```bash
node /workspace/.claude/skills/my-code-comment-refinement/added-comments.mjs
```

It diffs against the point the branch left `upstream/master` (its merge-base, not upstream's tip, so upstream's own newer comments are never listed as yours), and covers everything: commits on the branch, staged and unstaged edits, and untracked files. Workspace checkouts are shallow; when there is no merge-base it deepens the history until there is one, which only fetches history. `--base <ref>` picks another base, and `--json` gives machine-readable output.

What it leaves out on purpose:
- **Comments already in files you are passing through.** Only lines this change added or edited count.
- **Moved comments.** Text removed in one place and added in another is not new.

Each comment comes with a hint (`internal`, `public` or `pragma`) and the line it sits on. A hint is a starting point, not a verdict: read the code around it.

## 2. Judge each one

### `internal`: delete it
Narration (`// loop over the items`), restating the code, implementation rationale ("jsdom lays nothing out, so..."), history ("previously", "fixes #18264", "we tried X"), notes to reviewers, `TODO`/`FIXME`, commented-out code, section banners, and every comment inside a test.

If a comment was propping up unclear code, fix the code in the lines you already changed: a better name, a small well-named function, a named constant. Do not widen the diff to do it. When the reasoning is something a reviewer needs (why this approach, what was ruled out), move it to the PR's **Technical notes** or the commit body, not back into the source.

### `public`: keep it only if it states the contract
Public means another module, an extension (`@shell/...`), a consumer of `pkg/rancher-components`, or a Storybook docs reader can use the thing it documents: an export, a component (its top-of-script doc), a prop, emit, slot or exposed member, a member of an exported type, what an exported function or composable returns, or a story's description.

A public comment earns its place by telling a caller something the signature cannot: what the thing is for, what arguments and return values mean, units, defaults, invariants, what a slot receives, when an event fires, and any non-obvious constraint on using it. Then:

- **Delete it if it only restates the name or type.** `/** The title. */` on `title?: string` says nothing.
- **Trim it to the contract.** A public doc is often half contract and half rationale. On `RC_MODAL_WIDTHS`, *"The width of each size, in pixels, as the design system specs them"* is contract; *"Not `rem`: the shell pins the root font size..."* is rationale, so it goes to the PR notes. A 60-line component doc is almost always the second kind wearing the first kind's position.
- **Check the hint against reality.** Something documented as "internal to the package", or exported only so a test can reach it, is not a public interface. Judge by who can actually use it.

### `pragma`: never delete here
`eslint-disable`, `@ts-expect-error`, `istanbul ignore`, `webpackChunkName`, licence headers and the like do a job, and removing them breaks something. Whether one is justified is `my-fix-verify`'s question, not this skill's.

## 3. Leave the code clean, then check

- Deleting a comment can leave a double blank line or break `lines-around-comment`/`padding-line-between-statements`. Lint the files you touched:

  ```bash
  ./node_modules/.bin/eslint --max-warnings 0 $(git diff --name-only --diff-filter=AMR "$(git merge-base HEAD upstream/master)" -- '*.js' '*.ts' '*.vue')
  ```
- Run the lister again. The `internal` group should now be empty. Anything left in it needs a reason you would say out loud to a reviewer, and it goes in your report.
- Removing a comment never changes behaviour. If a test or the type check now fails, something other than a comment was removed.

## Finish

Report in a few lines: how many comments the change added, how many you deleted, how many you trimmed, and each one you kept with a word on why (`prop contract`, `slot payload`, `pragma`). Then hand back to the commit step that called you.
