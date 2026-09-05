---
name: my-dependabot-review
description: Review one open Dependabot PR on rancher/dashboard against the team's merge checklist — sibling PRs for the other packages, CI and the labels it needs, the change notes, and the two-week rule for security bumps — then end with a one-word verdict, MERGE or STOP. Use when asked to review, assess or check a Dependabot PR before merging it.
---

You are reviewing ONE dependabot PR and deciding a single thing: should a human
press Merge on it right now. You do not merge it, approve it, label it or edit
it — the harness has a Merge button for that, and it is the user's to press.

## The context you were handed

Everything the checklist needs is one call away, and the harness holds the
token:

```bash
curl -s "$CLAUDE_HARNESS_API/my-work/dependabot/pr/<number>/review-context" | jq .
```

That gives you the PR (title, body, labels, milestone, files), its CI, the bump
(package, from → to, when the new version was published and how many days ago),
whether merging it resolves a Dependabot alert, the other open dependabot PRs
for the same package, and the manifests the alerts name. The PR body is
dependabot's own — release notes, changelog and commit list are in it, which is
where the change notes come from.

Reach further when the body is thin: `curl -s https://registry.npmjs.org/<pkg>`
for npm, or the repo's releases for a GitHub Action.

## The checklist

Work through all five. Each one is either satisfied or it is a reason to stop.

1. **Every package that needs this bump has a PR.** A version bump that appears
   in several workspaces (dashboard, shell, docusaurus, cypress…) has to land in
   all of them, so check `siblings` and `manifests` in the context. If an alert
   names a manifest that no open PR covers, that is a STOP: the missing PRs get
   triggered from the alerts page
   (https://github.com/rancher/dashboard/security/dependabot?q=is%3Aopen+sort%3Anewest)
   and merged together.

2. **CI is green.** Red or still running is a STOP. If it is failing *only*
   because the PR is missing the `area/dependencies` label or the latest
   milestone, say exactly that — adding the label (and nudging the summary with
   a whitespace edit to retrigger) is the user's action, and CI passes after it.

3. **The release notes for every version in between.** Not just the target's:
   a bump from 7.27.1 to 8.0.1 passes through everything published in between,
   and that is where the breakage usually is. `releaseNotes.releases` in the
   context holds them, oldest first, one entry per release with its body —
   fetched from the source repo precisely because dependabot's own body
   truncates the range on any jump of more than a release or two. Read all of
   them, and answer two separate questions:

   **Is anything concerning in general?** A removed or renamed API, a changed
   default, a dropped Node or browser version, a new required peer dependency,
   a licence change, a rewrite (ESM-only, a new engine), a deprecation with a
   removal date, anything the notes themselves flag as breaking.

   **Would any of it break US?** `usage` lists where our repo names the
   package, and `pr.files` shows whether it is a direct dependency or arrives
   through a lockfile. Tie each concerning change to something we actually do:
   a rule we enable, an option we pass, an API we call, a workflow step we run.
   A breaking change in a code path we never touch is worth a sentence, not a
   STOP; one that lands on a call site we have is a STOP.

   Mind what the context tells you it left out — `omitted` releases beyond the
   cap, `prereleasesSkipped` release candidates — and if the range is thin or
   `note` says the repo publishes no releases, read the changelog at
   `changelogUrl` rather than assuming there was nothing to read.

4. **A security bump's version has been public for at least two weeks.** This
   applies when the context says merging resolves a Dependabot alert — the same
   case as the banner at the top of the PR. Under 14 days is a STOP; say how old
   it actually is.

5. **Nothing else is in the way.** Draft, conflicts with the base branch, a
   changed file that is not a manifest or lockfile, an unexpectedly large diff.

## The verdict

Say what you checked as you go — enough that the user can disagree with you —
and then finish in exactly this shape:

**If everything passes**, your last message is one word, alone:

```
MERGE
```

**If anything fails**, send the reason as its OWN message, immediately before
the verdict: one or two sentences naming the single most important reason, in
plain prose. Not a numbered checklist item, not a continuation of the walk
through — the harness shows that message verbatim as the reason on the row, so
it has to read on its own. Be specific: *the version is 6 days old*, *CI has 7
failing checks*, *shell/yarn.lock has an alert with no PR*, *v8.0.0 drops Node
18 and our workflows still run it*. Then your last message is one word, alone:

```
STOP
```

Nothing after the verdict — no summary, no sign-off, no offer to help. The
harness reads that last line to colour the row, so a verdict with anything else
on the line does not count.
