---
name: my-jira-bug-review
description: Review a new customer bug in the SURE Jira project for the Rancher UI team — decide whether it belongs to this team, whether it duplicates or is already fixed, whether it has enough information, then set the team fields and move it to In Triage or Waiting for Reporter. Use for bugs in the "New" state, or when asked to review/triage a SURE ticket.
---

The first pass over a bug that just arrived. Target: reviewed within **3 business days** of creation.

You never talk to Jira directly — the harness proxies it with the team token:

```bash
ISSUE=SURE-11898                                   # the key you were given
J="$CLAUDE_HARNESS_API/jira/rest/api/2"

curl -s "$J/issue/$ISSUE" | jq '{key, summary: .fields.summary, status: .fields.status.name,
  reporter: .fields.reporter.name, created: .fields.created,
  affects: [.fields.versions[].name], description: .fields.description}'
```

Everything you write into Jira is customer-visible through the CSM. Write like it.


## The attachments on the ticket

Screenshots, HAR files and logs the reporter attached are usually the difference
between reproducing and guessing. The Jira proxy can't serve their content (it
only proxies `/rest/`), so read them through the harness:

```bash
# What's attached, with the id and a URL you can fetch
curl -s $CLAUDE_HARNESS_API/my-work/jira/$ISSUE/detail \
  | jq -r '.attachments[] | "\(.id)  \(.filename)  \(.mimeType)"'

curl -s "$CLAUDE_HARNESS_API/jira-attachment/<id>/<filename>" -o /tmp/<filename>
```

A screenshot you can actually open tells you which page and which Rancher
version the report is about — read it before you conclude anything.

## 1. Read it and decide whose bug it is

- **Not a UI bug?** Re-assign to the owning team and remove the UI team, so it leaves this queue. Set `customfield_23900` (Rancher Team) to that team's value. If you can't tell which team owns it, say so in your summary and stop — Gary or Neil decides.
- **Duplicate?** Search before assuming it's new. Search on the SYMPTOM (an
  error string, the resource type, the page), not the reporter's phrasing:
  ```bash
  # Deliberately NOT filtered to "Rancher Team" = UI — an untagged bug is
  # exactly the kind that gets duplicated, and other teams' bugs can be the
  # original. Status is unfiltered too: a closed one is the useful kind.
  curl -s -G "$J/search" \
    --data-urlencode 'jql=project = SURE AND text ~ "<key words>" ORDER BY created DESC' \
    --data 'maxResults=15' \
    | jq -r '.issues[] | "\(.key) [\(.fields.status.name)] \(.fields.summary)"'

  # Already linked to this one? Duplicates are often linked rather than merged.
  curl -s "$J/issue/$ISSUE?fields=issuelinks" \
    | jq -r '.fields.issuelinks[]? | "\(.type.name): \(.inwardIssue.key // .outwardIssue.key)"'

  # And the GitHub side, where a fix would actually live. `gh` is present but
  # NOT authenticated in these containers; the public search API needs no token
  # for these repos (10 searches a minute).
  q() { curl -s -G https://api.github.com/search/issues \
          --data-urlencode "q=repo:$1 $2" --data 'per_page=10' \
        | jq -r '.items[]? | "  #\(.number) [\(.state)] \(.title)"'; }
  q rancher/dashboard "<key words>"
  q rancher/rancher   "<key words>"
  ```
  If it duplicates an existing issue, recommend **Rejected** with
  `"resolution": "Duplicate"`, a `links` entry pointing at the original, and a
  comment naming it ("Duplicate of SURE-nnnnn"). The link is applied with the
  rest of the recommendation — you no longer have to ask for it in `reason`.
- **Already fixed in a newer version?** Propose `toStatus: "Resolved"` with
  `"resolution": "Fixed"` and `fixVersions` set to the release the fix landed
  in, and say clearly in the comment which version carries it.

## 2. Judge whether it can be worked

Read it as the engineer who will have to reproduce it. You need: what the customer did, what happened, what they expected, and which Rancher version.

If any of that is missing, move it to **Waiting for Reporter** with a comment that asks for exactly what you need — no generic "please provide more info". Ask for the specific missing thing: the steps, the browser console output, a HAR, the exact version.

Always check the **Affects Version** field is set. If it isn't, ask for it — we can't reproduce against nothing.

## 3. Set the team fields

- Rancher Team (`customfield_23900`) = `UI`
- Assignee: `gary korhonen` if a UI engineer needs to take it; otherwise the SSE team assigns themselves.

## 4. Move it on

If the report holds up, the move is **In Triage**, with this comment:

> Thank you for the bug report, we've moved this to "In Triage" and an engineer will be taking a look to try and reproduce the bug. We'll update you soon and let you know if further information is required

If it doesn't, the move is **Waiting for Reporter** (missing information), **Rejected** (duplicate — name the original in the comment) or **Resolved** (already fixed — name the version).

Recommend exactly one of those. If the call genuinely belongs to a human — you can't tell which team owns it, or the duplicate is arguable — recommend no transition, and put the question in `reason`.

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
  "action": "review",                 // the step you're running
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
    "action": "review",
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
