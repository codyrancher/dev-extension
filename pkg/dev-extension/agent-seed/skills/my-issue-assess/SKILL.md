---
name: my-issue-assess
description: Turn a rancher/dashboard GitHub issue into a precise problem statement, a numbered reproduction procedure, and a map of the code that owns the behaviour. Produces the written assessment that the reproduce, root-cause, and verify phases all key off. Use before fixing anything, or on its own when asked what an issue is actually about, whether it is still valid, or where its code lives.
---

Read an issue closely enough that you could argue either side of it, then write down what you found. Nothing downstream works without this: the repro video records these steps, the root-cause analysis explains this symptom, and the verification re-runs these steps. Vague input here produces a confident wrong fix later.

The issue number is the trailing `issue-<N>` token in the project name and is recorded in `/workspace/CLAUDE.md`.

## 1. Read the whole thread

```bash
gh issue view <N> -R rancher/dashboard --comments
```

Read every comment, not the title and first post. Issues drift: the reproducible bug is often narrower, wider, or simply different from the opening report, and the last comment is frequently the one that matters.

Extract:

- **Expected behaviour**, one sentence. **Actual behaviour**, one sentence. If you cannot write both precisely, you do not understand the issue yet. Keep reading.
- **Environment constraints.** Rancher version, cluster type, browser, role, feature flags. Anything that might mean it does not reproduce here.
- **Scope signals.** Labels (`kind/bug`, `area/*`), milestone, linked PRs, and any "this also happens in X" comment that widens the surface.
- **What is out of scope.** Issues collect adjacent complaints. Name them and set them aside explicitly, so the fix does not quietly grow.

## 2. Check prior art before you write anything

A rejected earlier attempt tells you which approach not to take, and an existing fix tells you to stop.

```bash
gh pr list -R rancher/dashboard --search "<N>" --state all
gh issue view <N> -R rancher/dashboard --json closedByPullRequestsReferences
cd /workspace/dashboard && git log --oneline --grep "<keyword>" -20
```

If it looks already fixed on master, say so with the commit and stop. That is a valid, useful outcome.

## 3. Write the reproduction procedure

A numbered list, in the imperative, that someone who has never seen the issue could follow. Every step names a concrete UI target, not an intention.

Bad: "navigate to the cluster and trigger the error".
Good:

```
1. Log in as admin.
2. Cluster Management > Clusters > click `local`.
3. Left nav > Storage > PersistentVolumeClaims.
4. Click Create.
5. Leave Name empty, click Create.
6. Observe: no validation error appears and the form silently stays put.
   Expected: an inline "Name is required" error under the Name field.
```

Rules that make the list usable later:

- **End on an observation** that names the exact on-screen difference between expected and actual. That sentence becomes the highlight in the repro video and the assertion in the verification pass.
- **Include setup steps** for any resource the bug needs. If the repro depends on a cluster, namespace, or object that does not exist yet, the steps to create it are part of the procedure.
- **Note the minimum.** Strip every step that is not required to trigger the bug. A shorter procedure is a sharper video and a faster verification loop.
- If the issue ships no usable steps, derive them from the description and say plainly that you derived them.

## 4. Map the code

Locate the owning code before anyone forms a theory about it. Grep for the user-visible string first, since it usually lives in `assets/translations/en-us.yaml` and the translation key points straight at the component that renders it. Then work outward: component, then its store or model, then the util or formatter underneath.

```bash
cd /workspace/dashboard
grep -rn "<visible string>" assets/translations/en-us.yaml
grep -rn "<translation.key>" --include=*.vue --include=*.ts --include=*.js .
```

Record the two or three files most likely to hold the defect, and for each one a line on why you suspect it. These are candidates, not conclusions. Deciding among them is the `my-root-cause-analysis` skill's job.

## Output

A short written assessment, in the summary and carried forward into the fix:

- Expected vs actual, one sentence each.
- The numbered reproduction procedure.
- Environment constraints and anything that might block reproduction here.
- Prior art: earlier PRs or commits, and what they imply.
- Candidate code locations with a one-line suspicion for each.
- Explicitly out of scope: adjacent problems you are not fixing.

If the issue is unfixable as written (needs a product decision, is a duplicate, is already fixed, or is a request for a feature rather than a bug), say that here and stop. Reporting that early is worth more than a plausible fix to the wrong problem.
