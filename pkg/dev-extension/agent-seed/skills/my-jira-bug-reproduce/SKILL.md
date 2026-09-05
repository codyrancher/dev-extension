---
name: my-jira-bug-reproduce
description: Attempt to reproduce a SURE Jira bug against a live Rancher, record what you find, and move it to To Prioritize or Waiting for Reporter. Use for bugs in the "In Triage" state, or when asked to reproduce a SURE ticket.
---

The engineering pass. Target: reproduced and moved to **To Prioritize** within **7 business days** of creation.

```bash
ISSUE=SURE-11898
J="$CLAUDE_HARNESS_API/jira/rest/api/2"
curl -s "$J/issue/$ISSUE" | jq '{summary: .fields.summary, status: .fields.status.name,
  affects: [.fields.versions[].name], description: .fields.description}'
```

**Leave the assignee alone.** The bug sits with gary korhonen between steps and
goes straight back to him when it reaches To Prioritize, so do not propose
yourself or whoever kicked the run off — a reassignment that gets undone in the
next breath is noise on a customer's ticket. The only exception is a bug that
is unassigned: then propose Gary. Say in `reason` who actually ran the pass.


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
curl -s -X POST "$CLAUDE_HARNESS_API/my-work/jira/$ISSUE/run/reproduce" \
  -H 'Content-Type: application/json' \
  -d '{"state":"running","note":"Driving the UI to reproduce the report"}'
```

Close it out the same way with `"state":"complete"` (or `"failed"` and a
one-line reason) — a run that dies silently leaves the portal spinning.

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

## Step 1: has someone already reported this? (Jira AND GitHub)

Cheapest possible outcome. Spend two minutes here before spending an hour on a
reproduction, because a duplicate ends the pass — and the same symptom often
arrives from several customers, or is already tracked as a GitHub issue from an
earlier report.

Search on the SYMPTOM, not the ticket's wording: the customer's phrasing and
ours rarely match. Pull two or three distinctive terms out of the report (an
error string, the resource type, the page) and try each.

Search **both trackers every time** — a bug reported twice by two customers
lives in Jira, and one we already know about lives in GitHub. Finding neither is
a result worth stating; finding either usually ends the pass.

```bash
# Other SURE bugs, whatever their state — a closed one is the useful kind.
curl -s -G "$CLAUDE_HARNESS_API/jira/rest/api/2/search" \
  --data-urlencode 'jql=project = SURE AND text ~ "registration secret" ORDER BY created DESC' \
  --data-urlencode 'maxResults=15' \
  | jq -r '.issues[] | "\(.key)  \(.fields.status.name)  \(.fields.summary)"'

# Anything already linked to this one (duplicates are often linked, not merged).
curl -s "$CLAUDE_HARNESS_API/jira/rest/api/2/issue/$ISSUE?fields=issuelinks" \
  | jq -r '.fields.issuelinks[]? | "\(.type.name): \(.inwardIssue.key // .outwardIssue.key) \(.inwardIssue.fields.summary // .outwardIssue.fields.summary)"'

# The GitHub side — where the fix would actually live. `gh` is installed but
# NOT logged in inside these containers, so use the public search API directly;
# both repos are public. It allows 10 searches a minute unauthenticated, which
# is plenty for a handful of terms.
q() { curl -s -G https://api.github.com/search/issues \
        --data-urlencode "q=repo:$1 $2" --data 'per_page=10' \
      | jq -r '.items[]? | "  #\(.number) [\(.state)] \(.title)"'; }
q rancher/dashboard "registration secret"
q rancher/rancher   "registration secret"
```

**If you find a match**, stop and file a recommendation rather than reproducing:

- An open SURE bug covering the same thing → propose **Rejected** with
  `"resolution": "Duplicate"`, a `links` entry for the other key, and a comment
  naming it ("Duplicate of SURE-nnnnn"). The link goes on with the rest.
- A closed SURE bug or a merged GitHub issue that already fixed it → propose
  **Resolved** with `"resolution": "Fixed"` and `fixVersions` set to the release
  that carries it, and name that release in the comment.
- An open GitHub issue tracking it → keep going with the reproduction, but say
  so in your summary: the reproduction is still worth having, and the GitHub
  issue is where it gets attached rather than a new one being opened.

Near-misses matter too. If something looks related but is not the same bug, name
it in your summary — it is usually the fastest route to the code, and whoever
prioritises this wants to know the two are neighbours.

## Reproduce

Try the **latest** version of Rancher first. If it doesn't reproduce there, try the version in Affects Version — a bug that only reproduces on the older version is still worth recording as such.

The project's sidecars give you a real Rancher and a browser: bring them up, then drive the UI the way the customer described. `my-issue-reproduce` covers the recording mechanics — use it for the video itself.

If the bug needs a system or environment you don't have, don't guess: say what access you'd need and stop.

## If it reproduces

- Add whatever you learned that the report didn't say: the actual trigger, a narrower set of steps, the console error, the API call behind it.
- The move is **To Prioritize**, with the version you reproduced on in
  `affectsVersions` if the ticket didn't already have it.
- Fill in `githubIssue`: a draft, or `{"existing": "rancher/dashboard#NNNNN"}`
  if your dedup search found one already tracking it. Never leave it out — the
  panel's GitHub button is built from this field. **You do not open it yourself** — the panel
  offers it as a tick box and a human presses Submit on GitHub's own form.
  Nothing customer-identifying — logs, videos, screenshots, cluster names, URLs
  with customer hosts — crosses from Jira into it. Whoever opens it adds the
  `Internal Reference: SURE-nn` line and the Jira/king/bug labels.

## If it reproduces: draft the GitHub issue too

The fix lives in rancher/dashboard, so a reproduced bug needs an issue there.
You do not open it — the doc is explicit that a human does, because they are the
one certifying no customer information crossed over. You write it; they press
the button.

Follow the repo's own template (`.github/ISSUE_TEMPLATE/bug_report.md`) — the
same headings, in the same order, so it reads like every other issue:

```
**Setup**
- Rancher version:
- Rancher UI Extensions:
- Browser type & version:

**Describe the bug**
**To Reproduce**
**Result**
**Expected Result**
**Screenshots**
**Additional context**
```

Keep it tight. **Describe the bug** is one or two sentences. **To Reproduce** is
numbered steps someone can follow without knowing anything about the ticket —
no "as the customer reported", just the steps. If a section has nothing worth
saying, leave it empty rather than padding it.

File it on the recommendation:

```bash
curl -s -X POST "$CLAUDE_HARNESS_API/my-work/jira/$ISSUE/recommendation" \
  -H 'Content-Type: application/json' -d '{
    "action": "reproduce",
    "toStatus": "To Prioritize",
    "comment": "<under three sentences>",
    "reason": "<your case>",
    "attachments": [{"path": "/workspace/artifacts/...", "caption": "..."}],
    "githubIssue": {
      "title": "<one line, no SURE number, no customer name>",
      "body": "<the filled-in template>",
      "labels": ["kind/bug"],
      "attachments": ["/workspace/artifacts/reproduce/reproduce.webm"]
    }
  }'
```

### What must not cross over

This is the rule the whole step turns on, and it runs one way: **nothing from
Jira travels to GitHub.**

- **Only your own artifacts.** The video you recorded, the screenshots you took
  against your own Rancher. Never a file the reporter attached to the Jira
  ticket — those show a customer's cluster, their names, their URLs, their data.
- **No customer identifiers** in the title or body: no company name, no
  usernames, no cluster names, no hostnames, no support case numbers, no
  verbatim quotes from the ticket that could identify who reported it.
- **No SURE key in the body you write.** The internal reference is added by the
  person opening the issue, not by you.
- If a step genuinely cannot be described without customer specifics, replace
  them with neutral placeholders (`cluster-a`, `user@example.com`) and say in
  `reason` that you did.

When in doubt, leave it out and note it in `reason`. An issue missing a detail
can be edited; a leaked customer detail cannot be unpublished.

## If it does not reproduce

Recommend **Waiting for Reporter**, with a comment stating plainly that you tried and could not, including the versions you tried. Then either:

- name the specific extra information that would let you try again (config, exact steps, timing, scale), or
- ask the reporter to walk their steps again and add the detail they left out.

## Finish

Report: reproduced or not, on which versions, what you added to the ticket, and where it now sits. If it reproduced, say what you'd want the fix to touch — that's the head start the fixing step needs.

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
  "action": "reproduce",                 // the step you're running
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
    "action": "reproduce",
    "toStatus": "To Prioritize",
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
