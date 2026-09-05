---
name: my-fix-verify
description: Adversarially verify a rancher/dashboard change before it becomes a commit. Self-review the diff hunting for the reason to reject it, prove the change is covered by a test that fails without it, and sweep the edge cases and side effects the fix could have missed. Use after a fix is written and before committing, or on its own when asked to review, sanity check, or find holes in a working-tree change.
---

Read your own diff as if someone else wrote it and you have been asked to find the reason to reject it. Three passes, all three required. The point of doing this before the commit exists is that going back to the plan is still cheap.

A pass that finds nothing is a pass you did not do properly. Each section below ends with something you must be able to state, not just check off.

## Pass 1: self-review the diff

```bash
cd /workspace/dashboard
git diff
git status    # nothing stray: no debug logs, no .orig files, no committed screenshots or videos
```

Answer each of these out loud in your summary, honestly:

- Does this fix the reported issue, or only the one case I happened to test? Name a second case covered by the same change and confirm it.
- What is the most likely way this breaks something else, and have I actually looked at that thing? Not "probably fine".
- Is anything here unrelated to the issue? Remove it. Opportunistic cleanups, reformatted untouched lines, and stray import reordering all cost the reviewer attention and none of them are the fix.
- Would a reviewer who has never seen this issue understand why each hunk exists? If not, the code needs a comment or the PR needs a better description.
- Did I add a special case? A conditional keyed on a specific resource type, route, field value, or role is the thing `my-root-cause-analysis` rejects. If one survived into the diff, justify it in a sentence or take it out.
- Leftover `console.log`, commented-out code, `TODO`s, or debugging state?
- If I were the reviewer, what would I ask about first? Answer it pre-emptively in the PR description.

Repo conventions that fail review on sight:

- **No user-facing strings in code.** Labels go in `assets/translations/en-us.yaml`, referenced as `t('path.to.key')`.
- **Both themes.** Use existing CSS variables, never literal colours, and look at the result in light and dark.
- **Accessibility counts as correctness.** Interactive elements need a real accessible name, keyboard reachability, and correct roles. If you touched one, check the others nearby.
- **Never use em dashes** in code, comments, translations, or anything else you write.

## Pass 2: prove there is a test covering the change

"There are tests in that file" is not coverage. Coverage means **a test that fails without your fix and passes with it**. Prove it, do not assert it.

1. Write or update the test at the seam named in the plan (a model getter, a formatter, a util, a component's rendered output). Follow the neighbouring specs' structure; do not introduce a new testing style.
2. Confirm it passes:

   ```bash
   npx jest --ci <path to spec>
   ```

3. **Confirm it fails without the fix.** Revert only the source change, keep the test, and re-run:

   ```bash
   git stash push -- <changed source files>
   npx jest --ci <path to spec>      # must FAIL, and fail for the right reason
   git stash pop
   ```

   If it still passes, the test does not test the fix. Rewrite it. This step catches more useless tests than any amount of reading.

4. Assert the behaviour, not the implementation. A test that mirrors the code line for line passes forever and protects nothing.

**When there is genuinely no seam:** if the repo has no component tests for that area and the fix is purely visual, do not force one in a style the repo does not use. Say so explicitly, and write precise manual test instructions in the PR instead, at the same level of detail as the reproduction procedure. That is a real answer; silence is not.

If the change is covered by an existing Cypress e2e spec, run that spec too rather than assuming.

## Pass 3: sweep for edge cases and side effects

Work the list. For each item, either name what you checked and what you saw, or say why it does not apply.

**The regression surface.** Every other caller of the code you changed, from the plan's blast-radius list. Visit each one in the running UI once. This is where a narrow-looking fix gets caught breaking a sibling screen. If the list has grown since the plan, re-grep:

```bash
cd /workspace/dashboard && grep -rn "<changed symbol>" --include=*.vue --include=*.ts --include=*.js .
```

**Boundaries.** Empty state, exactly one item, many items, very long strings, missing or `null` fields, unicode. Bugs in this codebase cluster at zero and at one.

**States.** Loading, error, and success. Does the fix hold while data is still in flight, and when the request fails?

**Permissions.** If the change touches anything gated by RBAC, check it as more than one of `Admin`, `Standard User`, `User Base`. A fix that assumes admin visibility is a common failure here.

**Themes and i18n.** Light and dark. Any new string actually resolves and is not a raw key.

**Interactions.** Anything that shares state with what you changed: sorting, filtering, pagination, the resource's own detail and edit views, and the same component used on another resource type.

**Then run the real checks once, unscoped:**

```bash
yarn lint          # full repo, a few minutes, but the pre-push hook runs it anyway
yarn type-check
npx jest --ci <the suites covering your files>
```

The pre-push hook lints the whole repo, so a lint failure skipped here just fails later and slower.

## Verdict

Close with one of:

- **Ready.** The diff, the failing-without-the-fix test, the regression surface you walked, and the edge cases you checked, each with what you observed.
- **Not ready.** What the self-review or the sweep turned up, and which phase to go back to. Going back to the plan is the correct outcome when the fix turns out to be at the wrong altitude, and it is much cheaper now than after review.

Never report "verified" for something you reasoned about but did not run or look at. Say which items were checked in the running UI and which were checked by reading the code; they are not the same claim.
