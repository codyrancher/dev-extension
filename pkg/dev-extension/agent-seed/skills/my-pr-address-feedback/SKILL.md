---
name: my-pr-address-feedback
description: Address inline review comments on an existing rancher/dashboard PR — fix the ones with merit, reply to the ones that don't, and push a single follow-up commit. Use when the user gives you a PR URL with reviewer comments and asks you to address/respond/reply to them.
---

The user just got a code review on their PR and wants every comment dealt with — either fixed in code or addressed with a reply explaining why no change is needed. Don't half-do it. Every open comment gets a response.

## Workflow

1. **Fetch all unresolved inline comments** from the PR via the GitHub API:

   ```bash
   gh api repos/rancher/dashboard/pulls/<PR>/comments \
     --jq '.[] | "ID: \(.id)\nPath: \(.path):\(.line // .original_line)\nBody: \(.body)\n---"'
   ```

   This gives you each comment's id (needed for replies), the file/line it's anchored to, and the body. The PR number is in the project name (`*-pr-<N>`) or the URL the user pasted.

2. **For each comment, read the cited code in context.** Open the file, look at the surrounding lines, and look at how the rest of the file handles similar cases. The reviewer's claim is a hypothesis — verify it against the actual code before agreeing or disagreeing.

3. **Decide fix-vs-reply per comment:**

   | Fix it when | Reply when |
   |-------------|------------|
   | Reviewer caught a real bug, missed edge case, wrong assertion, security issue | Suggestion is taste/style and breaks existing file conventions |
   | The change is small and obviously correct | Reviewer's premise is wrong (e.g. they missed a guard elsewhere) |
   | Reviewer points to a missed guard or validation | Asking for a refactor beyond this PR's scope |
   | Test asserts against the wrong thing | The fix would be a regression somewhere else |

   Never fix something purely to please the reviewer if it makes the code worse or inconsistent with the rest of the file. Pushing back with a specific reason is better than silently doing the wrong thing.

4. **Make the fixes.** Edit each file. Don't bundle unrelated changes — only what the comments asked for.

5. **Run the relevant tests** for any code you changed (`yarn test:ci <path>` for unit tests; `yarn lint` if you touched lots of files). Fix the failures before continuing.

6. **Commit and push.** One commit per logical change is fine; one combined commit is also fine if changes are tightly related. Push to the **same branch** the PR is on (`origin/issue-<N>` typically) — never open a new PR. Run the push in the background since the codyrancher pre-push hook (yarn lint) takes a minute or two:

   ```bash
   git push origin issue-<N>  # via run_in_background:true
   ```

   While that runs, move on to step 7 — don't sit and wait.

7. **Draft a reply to every comment.** Draft, not publish: `gh api
   comments/<id>/replies` posts the moment you run it, and a reply written by an
   agent should be read by the person whose name is on it first.

   The harness attaches replies to a PENDING review instead, which is a real
   GitHub draft — it sits on the thread marked pending, visible only to you,
   until you submit the review on GitHub:

   ```bash
   # what threads exist, and the id of each one's first comment
   curl -s "$CLAUDE_HARNESS_API/my-work/pr/<PR>/threads" \
     | jq -r '.threads[] | "\(.commentId)  \(.path):\(.line)  \(.author)  \(.body[0:60])"'

   # for a fix
   curl -s -X POST "$CLAUDE_HARNESS_API/my-work/pr/<PR>/reply-draft" \
     -H 'Content-Type: application/json' \
     -d '{"commentId": <COMMENT_ID>,
          "body": "<one-line summary of what changed>. Pushed in `<short-sha>`."}'

   # for a pushback
   curl -s -X POST "$CLAUDE_HARNESS_API/my-work/pr/<PR>/reply-draft" \
     -H 'Content-Type: application/json' \
     -d '{"commentId": <COMMENT_ID>,
          "body": "<specific reason, citing the convention or guard>. Happy to <alternative> if you'"'"'d rather."}'
   ```

   The first draft reply opens the pending review; every one after it joins the
   same review, so they are all submitted together in one press. `threadId` works
   in place of `commentId` if you already have the thread's node id.

   If `$CLAUDE_HARNESS_API` is not set — you are not running inside a harness
   project — say so and leave the replies in your summary as text rather than
   publishing them with `gh`. A published reply cannot be taken back.

   Replies should be short — one or two sentences. For pushbacks, cite where else in the file/repo the convention is used (a permalink helps but isn't required for same-file references the reviewer can see). Offer an alternative when you can — "happy to refactor the whole file if you'd prefer" leaves the door open without committing to scope creep.

8. **Tell the user what you did**, broken down per comment: which were fixed (and
   the commit sha), which got draft replies (with a one-line summary of your
   reasoning). End with the one thing only they can do: **the replies are drafts
   on a pending review — read them and submit the review on GitHub to publish.**

## What not to do

- **Don't open a new PR.** Push to the existing branch. The reviewer is already watching it.
- **Don't reply with "Done"** and no explanation. Even one short sentence about what changed is better — it saves the reviewer from reading the diff again to understand the fix.
- **Don't skip the test run.** If you change a test or any code that has unit tests, run them before pushing. Reviewers are unhappy when "address feedback" pushes break CI.
- **Don't reply to every comment with `LGTM, fixed`.** Each reply should reflect what specifically was changed for that comment. Generic acknowledgments waste the reviewer's time.
- **Don't silently disagree.** If you don't fix something, you must reply explaining why. Leaving a comment unresolved with no response is the worst outcome — it forces the reviewer to chase you.
- **Don't publish replies with `gh`.** Draft them through the harness so the
  user reads them first. The one exception is a PR outside a harness project,
  and there the right move is to hand the text over rather than post it.
- **Don't resolve the comment threads yourself.** GitHub lets you mark threads resolved, but that's the reviewer's call. Leave them open after replying so the reviewer can decide.

## Edge cases

- **Reviewer posted comments as a PENDING review (not yet submitted):** these don't appear in `pulls/<N>/comments`. They're under `pulls/<N>/reviews/<review-id>/comments` and only the reviewer can see them. If the user expects comments but you find none, that's why — ask the user to submit the review first.

- **Comment thread already has back-and-forth:** read the whole thread (`gh api repos/.../pulls/comments/<id>` and look at `in_reply_to_id`) before responding. Don't restart the conversation from scratch.

- **Comment references a line that no longer exists** (because a previous commit removed it): the comment becomes "outdated" in GitHub's UI. You can still reply — say "the code at this position was removed in `<sha>` while addressing <other comment>; let me know if there's a related concern in the new structure."

- **Many comments at once** (more than ~8): fix in passes by file rather than by comment, so the diff stays coherent. Then reply per-comment at the end. Track which comment IDs you've replied to so you don't miss any.
