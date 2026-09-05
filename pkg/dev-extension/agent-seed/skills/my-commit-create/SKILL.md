---
name: my-commit-create
description: Create a Rancher Dashboard commit on a new branch following this project's commit conventions (concise title, no AI co-author, Fixes #issue, branch named issue-NNNNN). Use when staged changes are ready to be committed for an issue fix.
---

- Concise title stating what we did.
- Base it off of what changes are currently staged instead of just using the conversation history.
- Zero to two line summary if the title isn't sufficient.
- `Fixes #$(issueNumber)` (the runtime issue number for this project).
- Do NOT include any Co-Authored-By lines or any mention of Claude/AI in the commit.
- Make a new branch with the commit named `issue-$(issueNumber)`.

After committing, run `git-fix-commit` to amend the most recent commit's message in the VS Code editor tab (save and close to apply). No args, operates on `HEAD`.
