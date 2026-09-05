---
name: my-pr-comment-verify
description: Verify the assertions in a review comment before a human reads it — prove them with a recording or screenshot attached to the comment, or correct the comment with an "Edit:" note when the claim turns out to be wrong. Use on each pending comment after a review, and as part of my-pr-full-review.
---

A review comment is a claim about the code. This step is where the claim gets tested, because a confident wrong comment costs the author more time than no comment at all.

You are given one comment id. Work only on that one.

```bash
PR=<number>; ID=<comment id>
curl -s "$CLAUDE_HARNESS_API/my-work/pr/$PR" \
  | jq --argjson id "$ID" '.localComments[] | select(.id == $id)'
```

## 1. Name the assertion

Read the comment and state, to yourself, what it actually claims — "this throws when the array is empty", "this breaks keyboard focus", "this fires twice per render". A comment with no testable claim (a question, a preference) needs no verification; leave it alone and say so.

## 2. Prove it or disprove it

Pick the cheapest evidence that would convince a sceptic:

- **Reproduce it in the running app.** The project has Rancher and a browser; drive the case the comment describes and capture it — `my-browser-screenshot` for a state, `my-browser-record-video` for a sequence. Highlight the part that matters.
- **Prove it in code.** A failing test, or a node/console snippet that shows the behaviour, when the claim is about logic rather than UI.
- **Trace it honestly.** If neither is possible, follow the code path and say what you checked — and downgrade the comment's certainty to match.

## 3. Then update the comment

**If the claim holds**, attach the evidence to the comment. Do NOT upload it
yourself — name the file and the harness uploads it to GitHub when the human
submits the review, which is the same moment the comment itself becomes public:

```bash
curl -s -X PUT "$CLAUDE_HARNESS_API/my-work/pr/$PR/comments/$ID" \
  -H 'Content-Type: application/json' -d '{
    "body": "<original text>\n\nThe list stays empty after the second click: [[attach:empty-list.webm]]",
    "attachments": [
      {"path": "/workspace/artifacts/verify/empty-list.webm",
       "caption": "the list stays empty after the second click"}
    ]
  }'
```

- `path` is yours (`/workspace/...`); it is resolved inside this project and
  anything outside it is refused.
- **Evidence about the review as a whole goes PR-level**, not onto whichever
  line you happened to be looking at: a before/after recording, a note that the
  issue's repro steps are wrong, anything a reader needs before they start on
  the diff. Post it with `{"level":"pr", "body":…}` and no path — it becomes the
  draft review's body, at the top of the PR. A recording pinned to a line reads
  as "change this line", which is rarely what it means.
- `[[attach:<filename>]]` in the body is replaced by the real embed at submit
  time — a player for a video, an image for a screenshot. Leave the marker out
  and the file is appended to the end of the comment instead.
- Videos play in the review panel before that, so the person approving the
  comment can watch the evidence rather than take your word for it.
- Send `"attachments": []` to clear them. Run anything with an IP or a
  customer's hostname in it through `my-video-censor-ip` FIRST — submitting the
  review publishes these.

**If the claim is wrong**, do not quietly delete it. Put an `Edit:` at the very top explaining what you found:

> **Edit:** I checked this and it doesn't hold — `foo` is guarded by the `v-if` above, so the empty case never reaches this line. Leaving the comment for the record.

Then, if nothing useful remains, delete it:

```bash
curl -s -X DELETE "$CLAUDE_HARNESS_API/my-work/pr/$PR/comments/$ID"
```

The judgement call: keep a corrected comment when the correction teaches the author something, delete it when it was simply noise.

## Finish

One line: the claim, the verdict, and what evidence you attached.
