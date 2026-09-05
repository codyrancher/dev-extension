---
name: my-dependabot-fix
description: Resolve every open Dependabot alert sharing one advisory title in rancher/dashboard, in a single PR — work out the smallest change that closes all of them, then loop an implementer and an evaluator until the change is exactly as small as it needs to be. Use when asked to fix, resolve or clear a Dependabot alert or a security advisory.
---

The alert title you were given is the unit of work. The same advisory usually
fires once per lockfile — `yarn.lock`, `shell/yarn.lock`, `cypress/yarn.lock`,
`docusaurus/yarn.lock` — and those are one job, not four.

Can you figure out what we need to do in order to resolve ALL of the
`${alertTitle}` dependabot alerts on
https://github.com/rancher/dashboard/security/dependabot. Can we open up one PR
to resolve all of them at once?

After a first pass create two subagents, one will implement changes and the
other will evaluate if each change directly fixes the alert, if the change and
related code could actually be removed, and if the change is as small as
necessary. These two subagents should loop until the evaluator determines the
change is perfect.

## What you were handed

The prompt names the advisory and lists every open alert under it — number,
package, and the manifest it was found in. That list is the definition of done:
the PR closes all of them or it is not finished.

You can read the alerts yourself through the harness, which holds the token:

```bash
curl -s "$CLAUDE_HARNESS_API/my-work/dependabot" \
  | jq '.groups[] | select(.title == "<the title>")'
```

Each alert carries the vulnerable range and the first patched version. That
pair is the whole problem statement: get every lockfile onto something at or
above the patched version.

## Work out the smallest change

Almost always a transitive dependency, so there is no line in `package.json` to
edit. Find out how it is pulled in before changing anything:

```bash
cd /workspace/dashboard
yarn why <package>            # in each workspace that has the alert
grep -rn "<package>" --include=package.json .
```

Then the options, cheapest first:

- **It is already fixed upstream.** Re-resolving the lockfile is enough:
  `yarn up <package>` (or `yarn upgrade <package>` on classic) in each affected
  workspace. Prefer this — it changes nothing but the lockfile.
- **A parent needs bumping** to a version that depends on the patched release.
  Bump the smallest parent that does the job, not the top-level package.
- **Nothing upstream yet.** A `resolutions` entry pins the transitive dependency.
  It works, and it is the option that leaves the most behind — say so explicitly
  in the PR, so it can be removed when the parent catches up.
- **The dependency should not be here at all.** Occasionally the honest fix is
  deleting the thing that pulls it in. Worth a sentence of thought before
  reaching for a pin.

Run each affected workspace's install so every lockfile is consistent, and check
you actually moved the needle:

```bash
yarn why <package> | grep -i version   # the vulnerable version should be gone
```

## Then the loop

Two subagents, and they do not swap roles:

**The implementer** makes the change. It gets the advisory, the alert list, and
the evaluator's findings from the previous round.

**The evaluator** never edits. Three questions, in this order:

1. **Does each change directly fix an alert?** Point at the alert number and the
   line that closes it. A change that fixes nothing on the list comes out.
2. **Could the change, or code related to it, actually be removed?** A pin that
   is no longer needed, a dependency nothing imports, a workaround the bump
   makes redundant. Deleting beats adding.
3. **Is it as small as necessary?** An unrelated lockfile churn, a major bump
   where a patch would do, a `resolutions` entry covering more than the
   advertised range — all findings.

The evaluator returns **PASS** or **CHANGES** with findings that name a file and
a line. Loop until PASS, and stop early if the same finding survives two rounds
— that is a disagreement for the user to settle, not something to iterate at.
Cap it at five rounds and report where it stands if you hit that.

`my-code-issue-refinement` runs exactly this pattern; use it rather than
re-inventing the loop, with the advisory in place of the issue.

## Prove it before the PR

```bash
yarn install --check-files          # every affected workspace
yarn test <scoped>                  # whatever the touched packages cover
```

A lockfile change that does not build is worse than the vulnerability it fixes.
If a bump breaks something, say so and stop — do not paper over it with a pin
that hides the breakage as well as the alert.

## Finish: open the PR

Hand off to **`my-pr-create`** — do not hand-roll the PR. One PR for the whole
group, with:

- a title naming the advisory, not the packages
- **`Fixes GHSA-…`** (and the CVE if there is one) so GitHub closes the alerts
  on merge
- every alert number in the body, with the manifest each was found in
- what the change was and why it is the smallest one: which lockfiles moved,
  which version they landed on, and — if you used `resolutions` — what has to
  happen upstream before the pin can come out

Then report to the user: which alerts this closes, what changed, how many rounds
the loop took, and anything the evaluator flagged that you deliberately kept.
