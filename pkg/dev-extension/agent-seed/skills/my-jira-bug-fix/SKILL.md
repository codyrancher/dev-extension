---
name: my-jira-bug-fix
description: Fix a reproduced SURE Jira bug in rancher/dashboard master, and keep Jira in step with the work so the CSM and customer can see progress. Use for bugs that are prioritized and ready to fix, or when asked to fix a SURE ticket.
---

Bugs are fixed in **master**, for delivery in the next minor release. Backports to other releases are decided by Neil/Gary with PM/CSM — check with them rather than assuming.

```bash
ISSUE=SURE-11898
J="$CLAUDE_HARNESS_API/jira/rest/api/2"
curl -s "$J/issue/$ISSUE" | jq '{summary: .fields.summary, status: .fields.status.name,
  affects: [.fields.versions[].name], fix: [.fields.fixVersions[].name],
  description: .fields.description}'
curl -s "$J/issue/$ISSUE/comment" | jq -r '.comments[] | "\(.author.name): \(.body[0:400])"'
```



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

## Where you're running

This step runs **inside the bug's own project container** — a dashboard
checkout, a Rancher and a browser sidecar, and the harness API on
`$CLAUDE_HARNESS_API`. The harness only prompts you once all of that is up, so
the environment is ready when you start. `.claude/rules/sidecars.md` covers
changing the Rancher version, turning Prime on, or swapping the auth provider
when the bug needs a different one.

Tell the portal where you are as you go — the button spins on this, and a
silent agent looks like a hung one:

```bash
curl -s -X POST "$CLAUDE_HARNESS_API/my-work/jira/$ISSUE/run/fix" \
  -H 'Content-Type: application/json' \
  -d '{"state":"running","note":"Working the fix"}'
```

Close it out the same way with `"state":"complete"` (or `"failed"` and a
one-line reason) — a run that dies silently leaves the portal spinning.

## Before you write code

- Assign the bug to yourself, so two people don't fix it at once.
- Find the linked rancher/dashboard GitHub issue (Gary creates it during triage and adds `Internal Reference: SURE-nn`). The public work happens there:
  ```bash
  gh issue list --repo rancher/dashboard --search "SURE-${ISSUE#SURE-}" --state all
  ```
  If there isn't one yet, ask Gary to create it rather than opening it yourself — he's the one who scrubs customer information out of it.
- Reproduce it yourself if the triage pass didn't leave you a recording. You cannot verify a fix for a bug you've never seen.

## The fix

Follow `my-issue-fix` for the engineering itself — root cause over symptom, a test that fails without the change, adversarial self-review, a recording that shows it working. Reference the **GitHub issue** in the commit and PR, never the customer's Jira contents.

## Keep Jira in step

The whole point of the process is that the customer can see movement. As the work lands:

- recommend a comment when the PR opens, and again when it merges, in plain non-internal language;
- say in `reason` which release should go in **Fix Version** — that field is set by the human applying your recommendation;
- recommend the matching move (Eng PR Review → To Test → …) rather than leaving the bug parked while the GitHub side races ahead.

Never paste internal-only detail, customer data from other tickets, or unreviewed speculation into a Jira comment.

## Finish

Report: the root cause in one or two sentences, the PR, the fix version you set, and what you left for a human — the backport decision especially.

## The comment you propose

**Under three sentences.** It is read by a CSM and forwarded to a customer, and
a wall of text gets skimmed or rewritten — either way your wording is lost. If
it genuinely needs more than three sentences (several questions, several
findings), make it a bulleted list instead of a paragraph: one line per point,
no preamble.

## Evidence: the video and screenshots you took

If you recorded or captured anything, offer it with the recommendation. Do NOT
try to upload it yourself — you cannot; you name the files and the person
reviewing decides which go on the ticket, one at a time, from the panel that
shows them.

```bash
curl -s -X POST "$CLAUDE_HARNESS_API/my-work/jira/$ISSUE/recommendation" \
  -H 'Content-Type: application/json' -d '{
    "action": "reproduce",
    "toStatus": "To Prioritize",
    "comment": "<under three sentences, or a bulleted list>",
    "reason": "<your case, for the person deciding>",
    "attachments": [
      {"path": "/workspace/artifacts/reproduce/reproduce-SURE-11898.webm",
       "caption": "17s: the Register button hangs after the 409"},
      {"path": "/workspace/artifacts/reproduce/console-error.png",
       "caption": "the console error at the moment it fails"}
    ]
  }'
```

- Paths are yours (`/workspace/...`); the portal resolves them inside this
  project and refuses anything outside it.
- One line per file in `caption` — it is the only thing distinguishing two
  screenshots in the list.
- Offer what supports the finding, not everything you captured. Three files with
  captions beat nine without.
- This goes on the JIRA ticket, which the customer already sees. The GitHub
  direction is the sensitive one: nothing from Jira travels to a GitHub issue
  unless you are certain it carries no customer information.

## Everything a recommendation can set

A triage decision is almost never one edit. "It's a duplicate" is a link, a
resolution, a status and a comment; "it's already fixed" is a fix version, a
resolution and a status. File them **together** — the panel shows each as its
own tick box and applies the ones the human keeps in a single press, so
proposing all of them costs nothing and proposing half of them leaves someone
to finish the job by hand.

```jsonc
{
  "action": "fix",                 // the step you're running
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
    "action": "fix",
    "toStatus": "Eng PR Review",
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
