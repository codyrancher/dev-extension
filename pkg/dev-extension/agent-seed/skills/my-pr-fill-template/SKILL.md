---
name: my-pr-fill-template
description: Compose the body of a rancher/dashboard pull request. Owns the verbatim template, the per-section word budgets, the bar every line has to clear, the copy-pasteable setup block a reviewer needs, the media captions, and which checklist boxes you are allowed to tick. Writes the finished body to a file for `gh pr create --body-file`. Use from my-pr-create, or on its own when asked to write, rewrite or tighten a PR description.
---

This skill produces one artifact: the PR body. `my-pr-create` owns the mechanics around it (branch, push, media upload, `gh pr create`, the render and CI checks). Everything about *what the body says* lives here, so this is the file to edit when the descriptions come out too long, too thin, or in the wrong shape.

## Inputs

Gather these before writing a word. Missing any of them produces a body that restates the diff, which is the failure mode this skill exists to prevent.

| Input | Where it comes from |
| --- | --- |
| Issue number | The trailing `issue-<N>` token in the project name, recorded in `/workspace/CLAUDE.md` |
| The change itself | `git diff master...HEAD` plus `--stat` for the shape of it |
| Why the change is what it is | The `my-root-cause-analysis` output: the candidates you rejected and why |
| Media URLs | `my-pr-create` hands you `filename\thref` lines, or its manual-upload fallback block |
| Test invocation | The jest paths that cover the change, from `my-fix-verify` |
| The fixture | The manifest you actually reproduced and verified with, not a fresh one |

## Output

Write the finished body to `/workspace/artifacts/pr-body.md`.

`my-pr-create` passes that file to `gh pr create --body-file` and re-reads it for the render check. Always go through a file: a body piped through a heredoc mangles the fixture YAML's indentation and eats backticks, and there is no way to see that until the PR is public.

## The template

Copy this verbatim. The copy below is already correct; the three invariants under it are **invariants to preserve**, not defects in the upstream template to repair. `.github/pull_request_template.md` at HEAD ships all 9 items as `- [ ]`, one per line, with zero `- []`. Check it rather than trusting this list if they ever disagree.

- **`- [ ]` with a space.** `- []` renders as literal text, not a checkbox. If you ever rewrite these lines by hand, keep the space.
- **One item per line, no wrapping.** These items are long, and it is tempting to wrap them to keep the body readable in an editor. A wrapped line breaks the list item in two and the second half renders as a stray paragraph. Keep each on one line.
- **The 9 items are contiguous, with no blank line between any two.** A blank line inside the list makes Markdown render it *loose*, wrapping every item in a `<p>` and visibly stretching the spacing between checkboxes. This is also why anything you add after the list must not start with `- ` (see "Anything you add after the checklist").

The upstream template also carries `<!-- ... -->` hint comments on two of the items (`The PR has a Milestone`, `The PR has been self reviewed`). **The copy below drops them deliberately**: they are authoring hints for the person filling the template in, they render as nothing, and each one lengthens a line you are separately required to keep unwrapped. Nothing checks for their presence. Drop them.

```markdown
### Summary
Fixes #$(issueNumber)

### Occurred changes and/or fixed issues


### Technical notes summary


### Areas or cases that should be tested


### Areas which could experience regressions


### Screenshot/Video

### Checklist
- [ ] The PR is linked to an issue and the linked issue has a Milestone, or no issue is needed
- [ ] The PR has a Milestone
- [ ] The PR template has been filled out
- [ ] The PR has been self reviewed
- [ ] The PR has a reviewer assigned
- [ ] The PR has automated tests or clear instructions for manual tests and the linked issue has appropriate QA labels, or tests are not needed
- [ ] The PR has reviewed with UX and tested in light and dark mode, or there are no UX changes
- [ ] The PR has been reviewed in terms of Accessibility
- [ ] The PR has considered, and if applicable tested with, the three Global Roles `Admin`, `Standard User` and `User Base`
```

## The three rules

They are the whole quality bar.

### 1. Terse. Keep authored prose under 450 words.

"Authored prose" is the whole body **minus** everything you did not compose: fenced code blocks (setup commands, the fixture YAML, the jest line), the `<details>`/`<summary>`/`</details>` tags, and the 9 verbatim checklist lines. Those are fixed costs, so counting them makes the gate unsatisfiable rather than strict. Everything else counts: headings excluded, bullets, paragraphs and media captions included.

Count it, do not eyeball it. Run this against `/workspace/artifacts/pr-body.md` before the PR exists, and against the live body afterwards:

````bash
node -e '
const lines = require("fs").readFileSync(process.argv[1], "utf8").split("\n");
let fence = false, total = 0, cur = "(preamble)"; const by = {};
for (const l of lines) {
  if (/^```/.test(l)) { fence = !fence; continue; }
  if (fence || /^### /.test(l) || /^- \[[ x]\] /.test(l) || /^<\/?details>|^<summary>/.test(l)) {
    if (/^### /.test(l)) cur = l.slice(4);
    continue;
  }
  const w = l.trim().split(/\s+/).filter(Boolean).length;
  total += w; by[cur] = (by[cur] || 0) + w;
}
console.log("TOTAL", total); for (const [k, v] of Object.entries(by)) console.log(String(v).padStart(5), k);
' /workspace/artifacts/pr-body.md
````

Per section, in the same units. The rows are ceilings, and they sum to 325, so even hitting every one at once leaves headroom under the 450 cap. Being under 450 is not a licence to ignore a row: a section over its own ceiling is over budget regardless of the total.

| Section | Budget (authored words) |
| --- | --- |
| Summary | `Fixes #N`, nothing else (5) |
| Occurred changes | 3-5 bullets, one line each (50) |
| Technical notes | up to 3 bullets, or the one `Nothing notable.` line (45) |
| Areas to test | the fenced setup block and fixture, plus up to 4 bullets and one line saying what a correct result looks like (105 outside the blocks) |
| Regressions | up to 3 bullets (45) |
| Screenshot/Video | the 2 caption lines (30) |
| Checklist notes | up to 4 short lines (45) |

If the count is over, the cut is almost always lines that restate the diff. Which is rule 2.

### 2. Cut the *what*, keep the *why*. Information that is not actionable wastes the reader's time.

Make the summary as simple as it can be. The reviewer already has the diff, so a line that restates it is noise no matter how well written it is. The test for every line is what the reviewer **does differently** for having read it: challenges the approach, tests a case they would have skipped, stops writing a review comment you have already answered. A line that fails that test comes out, even when it is true and even when the section still has budget left.

- Cut: "Adds `models/foo.js` containing the matching logic." The file list is on the Files tab.
- Cut: "Merge the two branches into one, and key the insertion off that property." Visible in the diff, changes nothing a reader does.
- Keep: "The annotation is written by a backend controller that only knows Ingress, so this cannot come from it and is resolved in the UI." That is a decision the reviewer would otherwise challenge.
- Keep: anything an earlier reviewer got wrong, or that contradicts a nearby convention.
- Keep the rejected alternative when it is the obvious one. One line on why the fix is not the thing the reviewer would have reached for first saves the whole round trip.
- Do **not** append a long prose appendix to the Checklist. Per-item evidence goes in your reply to the user, not in the body.

A body that lands this right is **shaped oddly on purpose**: Occurred changes thins out, Technical notes carries the weight, because Technical notes is the only part a reviewer cannot reconstruct from the diff. Do not rebalance the sections to look even.

When trimming to a budget, cut in that order too: the "what" lines go first, every one of them, before a "why" line is touched. If a section is still over its ceiling with nothing but "why" left, keep the "why" and say in your reply to the user which section you let run over and by how much. Over-budget on rationale is a judgement call worth flagging; padding a section back to even is not.

### 3. A reviewer must be able to exercise the change from the body alone.

Somewhere in "Areas or cases that should be tested" there has to be a copy-pasteable setup: the CRDs or charts to install, the fixture manifest, and the one line saying what a correct result looks like. Never write "create an X and point it at a Y" and leave the reviewer to compose the YAML.

Recover the fixture you actually used rather than inventing a fresh one, since the one you used is known to work. It is in your reproduce/verify scripts, and the live objects are readable from the cluster you tested against.

This container has **no `kubectl`, no `jq` and no `yq`**, so do not reach for them. Mint a token from the admin credentials (there is no `~/.rancher-token`; do not assume a stashed one exists) and use node with the repo's `js-yaml` for the YAML:

```bash
set -a; source /workspace/.env; set +a
TOKEN=$(curl -sk "https://$RANCHER_HOST_NAME/v3-public/localProviders/local?action=login" \
  -H 'Content-Type: application/json' \
  -d "{\"username\":\"$RANCHER_ADMIN_USER\",\"password\":\"$RANCHER_ADMIN_PASS\"}" \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).token))')

curl -sk "https://$RANCHER_HOST_NAME/k8s/clusters/local/apis/<group>/<version>/namespaces/<ns>/<plural>/<name>" \
  -H "Authorization: Bearer $TOKEN" | node -e '
const yaml = require("/workspace/dashboard/node_modules/js-yaml");
let s = ""; process.stdin.on("data", (d) => s += d).on("end", () => {
  const o = JSON.parse(s);
  for (const k of ["managedFields", "uid", "resourceVersion", "creationTimestamp", "generation", "annotations", "fields"]) delete o.metadata[k];
  delete o.status;
  console.log(yaml.dump(o));
});'
```

Put the manifest in a `<details><summary>` block so it stays out of the way, and keep the install command and the expected result outside it where they are visible.

**Call out any step that the manifest alone does not produce, but prove the step is load-bearing before you write it.** A `status` subresource normally written by a controller that is not running in a bare cluster is the classic candidate: the reviewer applies the YAML, sees nothing, and loses an hour. Give them the `kubectl patch --subresource=status` line **only after** reading the code path that consumes that field and confirming your fixture actually reaches it. Many resolvers read `status` only as a fallback, so a fixture that populates the primary field never touches it and the patch is a no-op. A setup step that demonstrably changes nothing is worse than no step: a reviewer who skips it and still sees the right result stops trusting the rest of the body. The unit test fixture is the cheapest proof: if the test asserts the expected result without the field, the field is not needed.

If the change has no external fixture (pure UI, existing resources), the setup block is the exact navigation path instead. Either way, **always** include the jest invocation for the tests that cover the change, alongside the fixture when there is one:

```bash
npx jest --ci <test paths>
```

## The Occurred changes section

A plain list of the major changes, nothing more. Several bullets: the primary change the issue asked for first, then the supporting changes that were large enough for a reviewer to want to know about up front.

One line per bullet, no rationale. Why the change is what it is belongs in Technical notes, and only if it clears that section's bar. Mechanical edits (renames, moved imports, test scaffolding) do not get a bullet.

## The Technical notes section

Only technical items that were **surprising, unintuitive or unconventional** get a bullet here. That means something a reviewer would otherwise stop on: an approach that contradicts a nearby convention, a constraint that forced the fix into an unexpected shape, behaviour that is not what the code looks like it does.

If nothing clears that bar, the whole section is one line:

```markdown
Nothing notable.
```

That is the expected outcome for most PRs, not a failure to find material. Do not pad it. Restating what the change does, or explaining a decision any reviewer would have made the same way, is not a technical note.

## The Screenshot/Video section

`my-pr-create` hands you the uploaded hrefs. Place them here: markdown image syntax for `.png`, a bare URL on its own line for `.webm`. GitHub auto-renders bare `user-attachments` URLs as `<video>` players, and mangles them if you wrap them in link or image syntax.

**Caption every asset.** A bare URL under a bare heading tells the reviewer nothing about what they are looking at or when the video has made its point. Write exactly two labelled lines, each naming what to look at, and say **"the same walk"** on the after so the reviewer knows the two recordings are comparable rather than two different demos:

```markdown
**Before** - no HTTPRoutes tab, no Endpoints row, and the Ingresses tab is empty:

https://github.com/user-attachments/assets/<before-id>

**After** - the same walk, with the Endpoints link and the HTTPRoutes tab:

https://github.com/user-attachments/assets/<after-id>
```

If `my-pr-create` fell back to manual upload, drop its placeholder block in verbatim and list only files that actually exist.

## The checklist

Leave a box unticked when only the user can make it true, and tell the user which ones you left and why.

- `The PR has a Milestone` and `The PR has a reviewer assigned` are the user's to set. Always unticked.
- Tick the Global Roles item only if you actually exercised the change as more than one role.
- `The PR template has been filled out` and `The PR has been self reviewed` are gates with real conditions behind them, not assertions. `my-pr-checklist` walks all 9 items and is what actually earns the ticks; this skill only sets the initial state.

**Ticking a box you did not earn is forbidden.** Unticked boxes fail the `Description` CI job by design, and that red is the expected terminal state of a draft you hand over. Turning it green by ticking converts an honest red into a false green and defeats the only thing the checklist is for. `my-pr-create` explains the job and the handover wording.

### Never write a literal `[ ]` outside the 9 items

The CI script greps the **entire body** for `\[.\]`, not just the checklist section. Any literal `[ ]` in prose, in a fenced block, or in the fixture YAML counts as an unchecked box and fails the job. Reword rather than escape. `my-pr-create` greps for strays before finishing.

### Anything you add after the checklist

Checklist notes go **above** `### Checklist`, or below it as **plain paragraphs**. Never as `- ` bullets below it.

A `- ` bullet one blank line under the last `- [x]` is not a new list. Markdown absorbs it into the task list, so you get a 12-item loose list instead of a 9-item tight one, and every checkbox on the page gets stretched apart. The boxes still work, which is why this is easy to ship without noticing.
