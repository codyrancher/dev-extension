---
name: my-pr-review
description: Review a pull request in rancher/dashboard by leaving short, pending inline comments. Never submits the review (the user submits manually). Use when asked to review a PR, when the project name encodes a PR number, or as the review phase of my-pr-full-review.
---

- The PR number to review corresponds to the issue number in the Rancher instance name (e.g., `pr-16383-rancher` corresponds to PR #16383).
- Use `gh` to fetch the PR diff and details.
- Look at the original issue and note what the intended fix is.
- Review each changed file 
    - For every change look for: 
        - edge cases or possible unintended side-effects.
        - verify the change does what's intended to resolve the issue
        - ensure it addresses the intended fix
    - When appropriate leave inline comments using the GitHub API.
        - Never post nit-level comments. Skip purely stylistic preferences, naming bikesheds, formatting that the linter would catch anyway, and "could also be written as" rewrites that don't change behavior. If the only thing wrong is taste, say nothing. Only leave a comment when there's a real concern: a bug, a correctness issue, a missed edge case, a security or performance problem, an accessibility regression, or guidance that materially changes the design.
        - These inline comments should only be 1 to 2 sentences long. 
        - It should clearly state what problem is.
        - Verify that the stated problem is true.
        - When referring to specific lines (in the same file or elsewhere in the codebase), include a GitHub permalink to those lines rather than describing the location in prose.
        - If an easy solution is available it should be provided.
        - If a screenshot could better convey the intention behind the comment take a screenshot with the important bits highlighted/notated.
        - When using the GitHub API, omit the `event` field from the review creation request to keep it in PENDING state. Using `"event": "COMMENT"` submits the review immediately.
    - As a part of the review verify each of the PR checklist items to ensure they've been completed as expected.
        - Feel free to use the browser, users, light dark mode etc to verify.
- Do NOT submit the review. Only create individual review comments as pending so the user can review and submit themselves.



## Where to file the comments

Everything above (what deserves a comment, how long it is, permalinks, never submit) applies in both contexts. Only the filing mechanism differs, so pick the right one before you write anything.

**Harness portal ("Review / Respond" on the Pull Request tab).** You are running inside the project's container, and the priming prompt points you at `$CLAUDE_HARNESS_API/my-work/pr`. File through the harness, not `gh`: comments filed with `gh` bypass the portal's approval panel and the user never gets to vet them.

```bash
# Diff, existing GitHub review comments, and already-filed local comments
curl -s $CLAUDE_HARNESS_API/my-work/pr/<N>

# One pending comment (line = RIGHT-side line number from the diff)
curl -s -X POST $CLAUDE_HARNESS_API/my-work/pr/<N>/comments \
  -H 'Content-Type: application/json' \
  -d '{"path":"<file path>","line":<line>,"body":"<comment>"}'
```

- Only anchor to lines that appear in the diff. `side` defaults to `RIGHT`; pass `"side":"LEFT"` for a removed line, and `startLine` for a range.
- **Anything that isn't about a specific line is a PR-level comment.** Testing
  notes, what a recording shows, a correction to the issue's repro steps, "here
  is the context for this review" — none of those belong pinned to a line, where
  they read as a change request against code that is fine. Omit the path and
  pass `"level":"pr"`; it becomes the body of the draft review, which is what
  GitHub renders at the top of the PR:

  ```bash
  curl -s -X POST $CLAUDE_HARNESS_API/my-work/pr/<N>/comments \
    -H 'Content-Type: application/json' \
    -d '{"level":"pr",
         "body":"Recordings of the fix and of the bug it fixes: [[attach:demo.webm]]",
         "attachments":[{"path":"/workspace/artifacts/demo-changes/demo.webm",
                         "caption":"the fix working"}]}'
  ```

  File one per review at most — several are joined into a single body, since a
  review has exactly one. Attachments and `[[attach:…]]` markers work the same
  as on an inline comment.
- **A comment can carry evidence.** If you have a screenshot or a recording that
  shows the problem, attach it rather than describing it — the panel plays it
  inline, and the harness uploads it to GitHub when the review is submitted:

  ```bash
  curl -s -X POST $CLAUDE_HARNESS_API/my-work/pr/<N>/comments \
    -H 'Content-Type: application/json' \
    -d '{"path":"<file>","line":<line>,
         "body":"The dropdown closes on the first click: [[attach:dropdown.webm]]",
         "attachments":[{"path":"/workspace/artifacts/review/dropdown.webm",
                         "caption":"closes on the first click"}]}'
  ```

  `[[attach:<filename>]]` marks where it goes in the body; without a marker the
  file lands at the end. Never upload it to GitHub yourself — nothing should be
  public before the human submits the review.
- Read `reviewComments` from the GET first and do not repeat a point someone already raised.
- Stop after filing. The user approves each comment in the panel, and the portal's "Create draft review" button is what pushes them to GitHub as a PENDING review. Never call `/submit` yourself.
- Finish with a short summary of what you filed and why.

**Inside a project container (`*-pr-<N>` project, auto-review, or a direct ask).** No portal panel exists, so use `gh` and the GitHub API exactly as described above, leaving the review PENDING.
