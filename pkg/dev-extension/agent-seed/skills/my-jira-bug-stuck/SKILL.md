---
name: my-jira-bug-stuck
description: Work a stuck SURE Jira bug — one parked in Waiting for Reporter too long, or bouncing between the CSM/customer and engineering without progress. Assembles the history, says exactly what is blocking it, and drafts the nudge or the escalation to Gary/Neil. Use for bugs in "Waiting for Reporter", or when asked why a ticket is stuck.
---

A bug is stuck when it has stopped moving on its own: sitting in **Waiting for Reporter** past the point of usefulness, or ping-ponging between the customer and engineering with nobody able to reproduce it.

```bash
ISSUE=SURE-11898
J="$CLAUDE_HARNESS_API/jira/rest/api/2"
curl -s "$J/issue/$ISSUE?expand=changelog" | jq '{summary: .fields.summary, status: .fields.status.name,
  updated: .fields.updated,
  transitions: [.changelog.histories[] | {when: .created, who: .author.name,
    items: [.items[] | select(.field == "status") | {from: .fromString, to: .toString}]}
    | select(.items | length > 0)]}'
curl -s "$J/issue/$ISSUE/comment" | jq -r '.comments[] | "\(.created) \(.author.name): \(.body[0:300])"'
```

## Work out what is actually blocking it

Read the history, not just the last comment. Which is it?

- **We asked for something and never got it.** How long ago? Was the ask specific enough to act on? A vague ask is our fault, not the reporter's — re-ask precisely.
- **We got an answer and never acted on it.** Then it isn't waiting on the reporter at all: move it back into the flow and say so.
- **Engineering can't reproduce it and the customer can.** That's the case for a live session — the doc says arrange one rather than trading comments.
- **It's real but nobody owns it.** Name that and escalate.

## Then do the smallest thing that unblocks it

- Needs a nudge → recommend a comment with no transition, restating the specific ask and what happens next.
- Needs to move → recommend that move, and say why in the comment.
- Needs a human decision or a customer session → recommend no transition, and put the case in `reason`: the bug, how long it's been stuck, what's been tried, and what you want **Gary/Neil** to decide or arrange. Draft the message to them in the conversation so the user can send it themselves.

## Finish

One paragraph: why it's stuck, what you did, and what the next move is — including who owns that move. If the answer is "this needs a customer session", say so; that's a real outcome, not a failure.

## The comment you propose

**Under three sentences.** It is read by a CSM and forwarded to a customer, and
a wall of text gets skimmed or rewritten — either way your wording is lost. If
it genuinely needs more than three sentences (several questions, several
findings), make it a bulleted list instead of a paragraph: one line per point,
no preamble.

## Everything a recommendation can set

A triage decision is almost never one edit. "It's a duplicate" is a link, a
resolution, a status and a comment; "it's already fixed" is a fix version, a
resolution and a status. File them **together** — the panel shows each as its
own tick box and applies the ones the human keeps in a single press, so
proposing all of them costs nothing and proposing half of them leaves someone
to finish the job by hand.

```jsonc
{
  "action": "unstick",                 // the step you're running
  "toStatus": "Rejected",             // the move; omit to leave it where it is
  "assignee": "gak",                  // Jira username; "" to unassign
  "comment": "<customer-visible>",
  "reason": "<your case, not posted to Jira>",

  "team": "UI",                       // Rancher Team (customfield_23900)
  "fixVersions": ["v2.13.8"],         // the release that carries the fix
  "affectsVersions": ["v2.13.7"],     // the version it was found on
  "labels": ["ui"],
  "resolution": "Duplicate",          // applied with the transition
  "links": [{"type": "Duplicates", "key": "SURE-11000"}],

  "attachments": [{"path": "/workspace/artifacts/...", "caption": "..."}],
  "githubIssue": {"title": "...", "body": "...", "labels": ["kind/bug"]}
}
```

Anything the ticket already says is dropped automatically — you don't have to
check first, and re-proposing a field that's already right is harmless.

### Which fields each outcome needs

| Conclusion | What to propose |
|---|---|
| Belongs to another team | `team` = their team, `assignee: ""`, no transition, `reason` naming them |
| Duplicate | `toStatus: "Rejected"`, `resolution: "Duplicate"`, `links` to the original, comment naming it |
| Already fixed in a newer release | `toStatus: "Resolved"`, `resolution: "Fixed"`, `fixVersions` = that release, comment naming it |
| Not enough information | `toStatus: "Waiting for Reporter"`, comment asking for the specific missing thing |
| Affects Version missing but known | `affectsVersions` = what you determined, alongside whatever else you propose |
| Good report, ours to work | `toStatus: "In Triage"`, `team: "UI"`, `assignee: "gak"`, the standard comment |
| Reproduced | `toStatus: "To Prioritize"`, `attachments`, and a `githubIssue` draft |

`links` uses Jira's own link-type names (`Duplicates`, `Relates`, `Blocks`, `Causes`, `Supersedes`) and
reads outward from this bug: `{"type": "Duplicates", "key": "SURE-11000"}` means
*this bug duplicates SURE-11000*.

`resolution` is set as part of the transition, so it only sticks on a move that
resolves the bug. Propose it whenever you propose Rejected or Resolved — a
resolved bug with no resolution is the thing that gets reopened by a report.

### The GitHub issue, whenever the fix belongs in rancher/dashboard

**Any recommendation that moves a bug to To Prioritize must say something about
GitHub** — that move means "reproduced", and a reproduced bug is only half
triaged until there is an issue in rancher/dashboard. Send one of two things:

- **A draft**, when nothing covers it yet:
  `"githubIssue": {"title": "...", "body": "...", "labels": ["kind/bug"]}`
- **The issue that already covers it**, when your dedup search found one:
  `"githubIssue": {"existing": "rancher/dashboard#16247"}`

Either way the panel gets a button — "Open prefilled" for a draft, "Open ↗" for
an existing one. Omitting the field entirely is the one thing that leaves a
reproduced bug with no GitHub action at all, so don't: if you decided no new
issue was needed, that decision belongs in `existing`, not only in `reason`.

A human presses Submit on GitHub's own form; you never create the issue.

If you have **already filed** the recommendation and are adding the issue
afterwards (the panel's "Draft it" button asks for exactly this), attach it to
the pending one rather than filing again — a second `POST /recommendation`
supersedes the first and throws away the comment and attachments someone may be
part-way through reviewing:

```bash
curl -s -X POST "$CLAUDE_HARNESS_API/my-work/jira/$ISSUE/recommendation/github" \
  -H 'Content-Type: application/json' \
  -d '{"title": "...", "body": "...", "labels": ["kind/bug"]}'
# or, when one already covers it:
#  -d '{"existing": "rancher/dashboard#16247"}'
```

Don't draft one when the bug isn't ours, or when it hasn't been reproduced — an
issue nobody has confirmed is noise in that repo.

Follow the repo's template headings (Setup / Describe the bug / To Reproduce /
Result / Expected Result / Screenshots / Additional context), keep **Describe
the bug** to a sentence or two, and make **To Reproduce** numbered steps that
work without knowing the ticket exists.

**Nothing from Jira travels to GitHub.** Only artifacts you produced yourself —
never a file the reporter attached. No company name, usernames, cluster names,
hostnames, support case numbers, or verbatim quotes that identify the reporter.
No SURE key in the body: the internal reference is added by the person opening
the issue. If a step can't be written without customer specifics, use neutral
placeholders (`cluster-a`, `user@example.com`) and say so in `reason`.

## How you finish: recommend, don't act

**You have read-only access to Jira.** The proxy refuses writes (405), and that
is deliberate: this is a customer's ticket, and the person running you is the
one who owns what the customer sees. When you've reached a conclusion, file a
recommendation and stop.

```bash
curl -s -X POST "$CLAUDE_HARNESS_API/my-work/jira/$ISSUE/recommendation" \
  -H 'Content-Type: application/json' -d '{
    "action": "unstick",
    "toStatus": "In Triage",
    "comment": "<the exact text to post on the ticket, customer-visible>",
    "reason": "<why, for the person deciding — not posted to Jira>"
  }'
```

- `toStatus` — the move you're proposing. Omit it if the bug should stay where
  it is and only needs a comment.
- `comment` — write it as the finished article. It goes to the customer
  verbatim if the button is pressed, so no internal shorthand, no speculation,
  no other customers' details.
- `reason` — your case, in a sentence or two. This is what the human weighs.

One recommendation per run: filing a new one supersedes your previous proposal.
Buttons under the conversation apply it, change the target, or throw it away —
so say what you'd do and why, then leave the decision alone.
