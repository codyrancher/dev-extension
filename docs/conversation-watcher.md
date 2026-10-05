# The conversation watcher

`docs/conversation-watcher.md`

## 1. What this is for

Every read of a conversation's state in this product is a pod exec issued **by a browser**. `conversationStates()` (`pkg/dev-extension/conversations.ts:151`) ships an inline shell script into the agent pod over the exec subresource and parses the result; `workspace-status.ts`, `WorkspaceRail.vue`, `WorkspaceConversations.vue` and `pages/Conversations.vue` each run that on their own timer. So nothing in this product observes a conversation while the page is shut — and the two moments worth knowing about, "the agent finished" and "the agent is asking you something", are by definition moments when nobody is watching. An agent that finishes at four in the morning leaves a hook file nobody will read until somebody loads a page.

This specifies a loop inside `dev-api` that watches instead. It keeps one document per cluster: every conversation the agent pod holds, what each is doing, and two counters that say how many times each has stopped and how many times it has asked for something. The browser reads that document over HTTP and execs for conversation state no more.

What it removes, in order of how much it matters:

**The blindness.** The observation happens with every tab shut, as a service account, on a timer. That is the whole feature, and nothing else here is worth anything without it.

**The exec per tab.** A Focus tab costs 4 execs a minute today and a workspace detail tab costs 12, whatever N workspaces and M conversations there are; each goes to zero. The inline-chat plan that prompted this would have added a state exec every 1.5 s per open chat — 40 a minute each — and that is removed before it is written: the state a chat header needs is in the document, and the 1.5 s transcript poll that draws the *messages* is a different question and is deliberately untouched.

**Up to 15 execs per deck move.** `agentTurnOf` (`focus-artifacts.ts:871`) is `listConversations` plus up to three `conversationPane` reads plus `latestAgentReport`, and the deck prefetches two neighbours. The watcher already has the transcript on a mount; when a conversation stops it reads what claude last said once and puts it in the document, and the card draws from that.

The owner asked for "poll which ones have finished, or provide a queue or something to check when a page reloads". The poll is `GET /conversations?state=idle,input,finished`. The queue is per person and is not in `dev-api`, because `dev-api` cannot tell who is asking: it is `focus.awaiting` in that person's own prefs, holding the counters a conversation was at when they handed work to an agent, so a reload compares and the card comes back exactly once.

## 2. The ground this rests on

Every statement here was checked in the tree, not inferred.

**`dev-api` already has an exec client, and it has no callers.** `podExec(namespace, pod, container, command, waitMs)` is at `dev-api/server.mjs:154`. It authenticates with the `base64url.bearer.authorization.k8s.io.<base64url token>` subprotocol, because the WebSocket Node exposes is the WHATWG one and cannot set an Authorization header — its own comment says so, at length, and that is a settled decision in this file. It always settles, with a `setTimeout` floor of `EXEC_WAIT_MS = 120000` (line 127), because an exec the apiserver upgrades and then abandons fires neither `close` nor `error` and a promise that never settles in a reconcile loop is a loop that never ticks again. **It returns channel 1 only**: `if (!frame.startsWith('1')) return;`. stderr and the apiserver's own status frame are discarded, so a 403, a pod going away mid-exec and a pod holding no conversations are the same empty string. Nothing in this design adds a second exec client. The gap is closed by a sentinel the script prints.

**The `pods/exec` grant the brief credits to `dev-api` is somebody else's.** The rule at `api.ts:2217` is inside the `ClusterRole` named `GLOBAL_SERVICE_ACCOUNT` (`dev-global-terminal`, declared at `api.ts:1932`) — the browser terminal's identity. `dev-api` runs as the ServiceAccount `dev-api` (`api.ts:2884`), whose ClusterRole is built by `ensureRules('rbac.authorization.k8s.io.clusterroles', API_NAME, …)` at `api.ts:2805`, and whose widest pod rule is `{ apiGroups: [''], resources: ['pods', 'pods/log'], verbs: ['get', 'list'] }` at `api.ts:2841`. The rule has to be added there. `ensureRules` (`api.ts:1948`) PUTs when `JSON.stringify(existing.rules) !== JSON.stringify(body.rules)`, so it reaches clusters that already have the role, on the next dashboard load, with no pod restart — RBAC is evaluated per request. `ensure` (`api.ts:2098`) by contrast is **create-if-missing**, so nothing in the `dev-api` Deployment body — an env var, a `strategy`, a `nodeSelector` — can ever reach a cluster that already has one. Nothing in this design depends on changing that body.

**`dev-api` already mounts the agent pod's whole workspace, read only.** `AGENT_WORKSPACE_HOST_PATH = '/var/lib/rancher/extension-studio/agent'` (`api.ts:2731`) is the same path `agent.ts:35` gives the agent pod as `/workspace` (`api.ts:2910`, `api.ts:2917`), and `server.mjs:706` already knows it as `AGENT_ROOT = '/agent-workspace'` with `AGENT_PREFIX = '/workspace/'` beside it. So `sessions/<id>.state.json`, `sessions/<id>.events.jsonl` and every transcript the state files name are plain file reads from this pod, for nothing. Neither Deployment has a `nodeSelector` or an affinity, so on a multi-node cluster this mount is a different, empty directory — which is why the mount is an **accelerator** in this design and never the source of truth. See §7.

**`sessions.sh` owns what a conversation is, and answers for one prefix at a time.** `seed/agent/sessions.sh:56` is `case "$VERB" in list|new|states) PROJECT=$2; ID='' ;; esac`; with no project the prefix is `agent-` and with one it is `p-<project>-`. Its opening comment is the single most important fact in this document: *a conversation IS a directory under `/workspace/sessions`, not a tmux session; tmux is where a conversation is currently running, and that is empty for the first minute after this pod restarts while every conversation is still there on the hostPath with its transcript and its name intact.* The `states` verb (line 159) prints one tab-separated line per conversation — `id`, `alive` from `tmux has-session -t mc-<id>`, seconds since the transcript **or any `subagents/*.jsonl`** last moved (`-1` when there is none), and `head -c 800` of the hook's state file — and it is keyed on the state files rather than the directories, so a conversation nobody has opened has no line and therefore no misleading dot.

**`sessions.sh list` greps whole transcripts, and the loop must never call it.** `title_of` (line 125) falls through to `ai_title_of` (line 104), which greps the entire conversation `.jsonl` for the last `"type":"ai-title"` line and pipes it through `tail`/`sed`/`tr`/`cut`. Transcripts run to many megabytes. `list` pays that because a person is waiting with a panel open; a loop at 2–12 ticks a minute inside the pod that is also running claude must not, and this design reports no titles.

**The hook writes a snapshot, not a sequence number.** `seed/chat-hook.mjs` is registered for `SessionStart`, `UserPromptSubmit`, `Stop`, `Notification` and `SessionEnd`. Each firing writes `<pane>.state.json` to a temp file and renames it (lines 82–86), so a reader never sees half a file, and appends the same JSON to `<pane>.events.jsonl`, trimmed to the last 500 lines when it passes 512 KiB (lines 88–100). The fields are `event`, `at`, `sessionId`, `transcript`, `cwd`, `pid`, and conditionally `prompt`, `notification` (from `notification_type`), `message` (capped at 500), `reason`, `stopHookActive`. There is **no counter** in it and this design does not add one: the `events.jsonl` beside it is a better answer to "what did I miss" and already exists. Its own doc says the part that governs everything below: *"Nothing here is authoritative on its own."*

**The derivation already exists three times and two copies have drifted.** `activityState` (`agent.ts:448`) crosses the three signals with `overruled = SPEAKS_LAST.has(a.event) && hookAgo <= a.wroteAgo + 5`, and the comment above it records that letting the transcript overrule `SessionStart` after an auto-compact "halves the samples where a working conversation was showing an idle dot". `agentStateOf` (`workspace-status.ts:256`) has neither `SPEAKS_LAST` nor that fix — it tests the bare `c.wroteAgo + 5 < hookAgo` — so the same conversation reads `idle` in the sidebar and `working` in the conversation strip after a compaction. The third is the inline shell inside `conversationStates`. This design makes `server.mjs` the authority, deletes `agentStateOf`, and leaves `activityState` only on the fallback path.

**`writeDoc` is last-write-wins, per key.** `readDoc`/`writeDoc` are at `server.mjs:235`/`248`; `k8s()` sets `application/merge-patch+json` on PATCH (line 44) and has no conflict path, and `writeDoc` sends no `resourceVersion` precondition, falling back to a POST on 404. So every write to one key is a clobber, and the design has to be *idempotent* rather than *serialised*. It cannot assume one writer: the `dev-api` Deployment declares `replicas: 1` (`api.ts:2886`) and **no `strategy`**, so Kubernetes defaults to RollingUpdate with maxSurge 1 and there are briefly two watchers on every publish — while `agent.ts:164` sets `strategy: { type: 'Recreate' }` on the agent pod for exactly this reason, and `ensure` being create-if-missing means that cannot be retrofitted here.

**`dev-api` is replaced on every publish, and so is the agent pod.** `ensureWorkspaceApi` compares the ConfigMap key by key and, when anything differs, PUTs it and then DELETEs the pod (`api.ts:2780–2792`) — the comment there records the "minute of 'no endpoints available' after every dashboard load" that the key-by-key comparison was introduced to stop. `agentBootVersion()` (`agent.ts:106`) hashes only `boot.sh`, `terminal-tools.sh` and `tmux.conf`, so **editing `sessions.sh` does not roll the agent pod** and no conversation dies for this change; the new script reaches the running pod on the next kubelet ConfigMap sync, because everything in `/seed` other than those three is re-read on each invocation.

**`node scripts/gen-dev-api.mjs` does not syntax-check anything.** Its header says "with a syntax check"; its body is a `readFileSync` into a `JSON.stringify`. A syntax error in `server.mjs` therefore ships, and the container exits 1 before `listen` — taking `/focus`, the review store, `my-work` for every in-cluster agent and all three existing reconcile loops with it. `node --check` is step 0 of the plan.

**Three reconcile loops already exist**, each catching its own errors, all started in the `listen` callback at `server.mjs:3850`: `reconcileTeardown` (10 s, then every 60 s), `reconcileWorkspaces` (3 s, then 15 s), `reapTools` (20 s, then 60 s). `installations()` (line 99) is the idiom for a fact a downstream cluster will never have: a 404 is recorded in `noInstallations` and logged once, not every tick forever.

**The constants.** `EXT_NS = 'extension-studio'`, `AGENT_OBJECT = 'extension-studio-agent'`, `AGENT_CONTAINER = 'agent'` (`pod.ts:23`, `:30`, `:33`); the agent pod carries `labels: { app: AGENT_OBJECT }` (`agent.ts:167`). The browser reaches `dev-api` at `${ clusterBase('local') }/api/v1/namespaces/dev-system/services/http:dev-api:8080/proxy` (`reviews.ts:43`), which the apiserver proxies without forwarding who is asking. `AGENTS_EVERY_MS = 15_000` (`workspace-status.ts:206`), `STATUS_MS = 15000` (`WorkspaceRail.vue:52`), `POLL_MS = 1500` (`chat-conversation.ts:110`).

## 3. The design, named

**A state snapshot with per-conversation counters, watched on two cadences, and a per-person handover.** One ConfigMap holds every conversation and what it is doing; the browser reads it over HTTP; what each person has handed to an agent lives in that person's own prefs.

The reason, in a line: a ConfigMap is a terrible log and a perfect snapshot — 1 MiB, read-modify-write per append, no precondition — and the two questions have different prices, so the expensive half (does this pane exist, which conversations are there) is one exec every 30 s and the cheap half (what did the hook last say, has the transcript moved) is a `statSync` on a mount this pod already has, every 5 s.

Three things are rejected on purpose.

**No event log with revisions.** A log needs retention, pagination, a truncation protocol and a cursor per consumer, over a key with no concurrency control, and the honest estimate is that ~95% of drains would return nothing. Worse, its revision authority cannot survive the publish path: `logBounds` cached per process plus a read-modify-write segment plus two overlapping watchers is a head revision that can go backwards, which is the one thing a cursor cannot survive. The log's irreplaceable value — a change that is already over by the time you look — is bought here with two counters and, when somebody actually wants the sequence, by reading the hook's own `events.jsonl` off the mount, which is already written and already trimmed.

**Nothing in the server may create a card.** A card appears because *this person* handed work to an agent and the agent then moved, or because the existing `agent-question` rule fires on a live `input`. There is no "an agent finished, make a card for everybody" path. That one decision makes a whole class of failure structurally impossible: a publish, a rolled agent pod, a first install, a deleted ConfigMap — none of them can flood anybody's deck, because none of them can mint a handover.

**No new derivation.** `server.mjs` becomes the authority for the five state words and `workspace-status.ts`'s drifted copy is deleted.

Grafted from the two designs that lost:

- *From the event-log design:* `hookEventsSince` — reading `<id>.events.jsonl` off the mount on a process's first tick, to recover the firings that happened while `dev-api` was being replaced. No execs, no new storage, and without it the feature's headline promise fails on every release, which is the one circumstance guaranteed to happen. Here it only moves counters; it cannot synthesise anything a person has not already asked to be told about.
- *From the event-log design:* a `GET /conversations/{id}/events` route, served by tailing that same file, so "why does this card say it is waiting?" is answerable without a second store.
- *From the inbox design:* `hookMs < podStartedMs` → unknown, forever. A hook event written before this container started was written by a claude that no longer exists, so its pane being absent says nothing that was not already true. This is strictly stronger than a settle window and it is what stops a week-old conversation becoming `finished` news two minutes after a roll.
- *From the inbox design:* serving the `conversation` artifact from the watcher's own transcript read, which is the only part of this feature that touches the ~8 s first card.
- *From the inbox design:* the exec's failure recorded in the response rather than only in a log, because the `pods/exec` grant only lands when somebody loads the dashboard — **and**, unlike that design, actually drawn in the UI, so a dead watcher is not indistinguishable from a quiet cluster.
- *From the inbox design:* `(id, event, at)` identity and a document re-read at the top of every tick, so two overlapping watchers converge instead of clobbering.

## 4. The state machine, for one conversation

Six words. Five are a function of the three signals `sessions.sh` reports; the sixth is the watcher's, because only the listing can observe it.

```
                     a directory under /workspace/sessions
                                      │
                      has it ever run? (a .state.json exists)
                         no │                        │ yes
                      ┌─────┴─────┐                  │
                      │   none    │        tmux has-session -t mc-<id>?
                      └─────┬─────┘           no │            │ yes
         its first SessionStart                  │            │
                            └──────────▶┌────────┴─┐          │
                                        │ finished │◀─────────┼── SessionEnd
                                        └────┬─────┘          │
                                             │ reattached     │
   the transcript (or a subagent's) moved ≤90s ago and no      │
   Stop / SessionEnd / Notification spoke after it ────────────┤
                                        ┌──────────┐           │
                           ┌───────────▶│ working  │◀──────────┘  UserPromptSubmit,
                           │            └────┬─────┘              Pre/PostToolUse,
          a prompt went in │                 │                    SubagentStop
                           │   Notification, type ≠ idle_prompt
                           │            ┌────┴─────┐
                           ├────────────│  input   │   ← "it has a question"
                           │            └──────────┘
                           │   Stop, or Notification/idle_prompt
                           │            ┌──────────┐
                           └────────────│   idle   │   ← "it finished"
                                        └──────────┘

   the directory is removed (`sessions.sh end`) ─────────▶ gone   (kept 6h, then dropped)

   nothing believable this tick ─────────────────────────▶ unknown (publishes nothing at all)
```

**`finished` and `input` are different states and the deck says different things about them.** Both are a reason to return a card, and that is the only thing they have in common. `input` is "claude is sitting there waiting on you, and nothing about this work can move until you answer" — it returns the card as `agent-question`, score 100, the `answer-agent` card, with the agent's own question on it. `idle`/`finished` is "the agent got to the end of what it was asked and the next move is yours" — it returns the card as `agent-stopped`, score 95, a new card whose job is "read what it did and say what happens next". And `finished` is not `idle`: `idle` is a turn that ended with claude still in its pane, `finished` is a pane that has gone. Calling a crash "finished" is how a deck comes to say an agent is done when it is dead, so the `note` carries the hook's `reason` where there is one and the card words it differently.

**`gone` is not a state of a conversation, it is the end of one.** `sessions.sh end` removes the directory, the `.id` file and the tmux session together (lines 241–262), so an id that was in the document and is not in the listing is one somebody closed. It gets an entry for six hours, because a client holding a card until that conversation moved would otherwise hold it for ever — then it is dropped. Its reappearance is a *different* conversation: `new` allocates the lowest free ordinal with `mkdir` (line 229), so ids **are** reused, which is what `bornAt` is for.

Three precedences decide the rest, each from a measured wrong answer.

**Liveness outranks everything, and only a process in the pod can report it.** `!alive → finished`, first and unconditionally; a transcript cannot say that its writer died mid-turn. This is the one fact no file on the mount holds and the entire reason an exec remains in this design: a tmux server is per user and answers only to a process inside its own pod.

**The transcript outranks the hook.** A hook fires only at a turn's edges, so a turn spent inside subagents reads as finished to it while the subagents write their own transcripts beside the session's the whole time — and there is no hook at all for "the question was answered", so a permission prompt answered in the terminal leaves the last `Notification` standing over an agent that has been working again for ten minutes. `workspace-status.ts`'s own comment records that exact bug.

**Except when the hook is the newer of the two.** `SPEAKS_LAST = {Stop, SessionEnd, Notification}` with a five-second margin: all three fire *after* that turn's final writes land, so for a few seconds the transcript still looks alive and `working` would be wrong. `SessionStart` and `UserPromptSubmit` are deliberately not on that list, and that is the point of having one — after an auto-compact the CLI fires `SessionStart` the instant compaction ends and carries straight on, and letting it win is how a working conversation came to show an idle dot.

`unknown` is the state that writes nothing: no state change, no counter, no document write. It is reached when there is no hook file and no transcript, when `!alive` inside the pod-settle window, and when `!alive` with a hook event older than the container's start. The last of those is the strongest guard in the design and it never expires.

Counters, which are what a client actually compares:

- `stops` increments on **entering** `idle` or `finished` from a state that was neither.
- `asks` increments on **entering** `input` from anything that was not `input`.
- Neither moves on a state that has not changed, and neither moves on an `unknown` tick.

They are per conversation and they only go up. A client that stored `{ stops: 3, asks: 1 }` and reads `{ stops: 5, asks: 2 }` knows the agent finished twice more and asked once more while the page was shut. That is less than a log; it is the half of a log that anything here uses.

## 5. Storage

### The snapshot: `dev-conversations` / `conversations.json`

One ConfigMap in `dev-system`, labelled `dev.rancher.io/kind: conversations`, written with the existing `writeDoc` and read with `readDoc`. The `dev-api` ClusterRole already grants `configmaps` `get, list, create, update, patch, delete` (`api.ts:2823`), so this needs no RBAC of its own.

```json
{
  "v": 1,
  "epoch": "m1k9wq2z",
  "at": "2026-10-04T12:41:10.002Z",
  "pod": "extension-studio-agent-5f9c7d8b-xk2qp",
  "items": {
    "p-pr-19212-1": {
      "id": "p-pr-19212-1",
      "kind": "workspace",
      "workspace": "pr-19212",
      "state": "input",
      "was": "working",
      "note": "permission",
      "stops": 3,
      "asks": 2,
      "bornAt": "2026-10-03T09:12:00.004Z",
      "changedAt": "2026-10-04T12:33:01.004Z",
      "hookAt": "2026-10-04T12:33:00.881Z",
      "alive": true,
      "wroteAgo": 134,
      "event": "Notification",
      "message": "Claude needs your permission to use Bash",
      "said": "I can run the suite headed, but that needs permission to shell out.",
      "question": { "tool": "AskUserQuestion", "header": "Which suite first?", "options": ["e2e/login", "e2e/nav", "all of them"] }
    },
    "agent-3": {
      "id": "agent-3", "kind": "drawer", "workspace": "",
      "state": "working", "was": "idle", "note": "",
      "stops": 19, "asks": 1,
      "bornAt": "2026-10-04T11:02:11.000Z",
      "changedAt": "2026-10-04T12:40:55.881Z",
      "hookAt": "2026-10-04T12:40:55.102Z",
      "alive": true, "wroteAgo": 3,
      "event": "UserPromptSubmit", "message": "", "said": "", "question": null
    }
  }
}
```

Keyed by id rather than an array, so folding one observation in is `items[id] = …` and never a scan. `epoch` is minted once, when the document is created, and exists for the one case nothing can recover from: a document somebody deleted. Every counter then restarts at zero, and a client holding `{ stops: 3 }` would compare it against a fresh `{ stops: 0 }` for ever — so a client that sees a new `epoch` releases what it was holding rather than holding it until somebody notices. `hookAt` is the hook event's own timestamp and is what makes a transition a transition: the same `Notification` cannot be counted twice however many ticks it survives, and it is the cursor the gap recovery reads `events.jsonl` against. `bornAt` distinguishes a reused id from the conversation that used to own it.

**Written only when something moved.** A PATCH every five seconds is twelve etcd writes a minute on a cluster where nothing is happening, for ever, and the premise of this loop is that it costs nothing when nobody is looking. The tick's own freshness is **not** in the document — it is in memory and served on the response — because a write per tick to say "nothing happened" is exactly the cost this exists to avoid, and because what a client wants from freshness is whether *this process* is still looking, which only this process knows.

**Deliberately not in the body:** prompts, transcript text, pane scrollback. The only free text is the hook's own `message` (capped at 500 by `chat-hook.mjs`, which `conversationStates` already returns to every browser today), and `said`/`question`, which are capped here. This document has no owner label and anyone who can read ConfigMaps in `dev-system` can read it, so it must not start carrying what people typed.

### The bound

~450 bytes per conversation with `said` and a `question`, ~250 without. `sessions.sh new` caps itself at a thousand conversations per prefix, so an unbounded document could in principle reach 450 KB — under the ceiling but not by a margin worth trusting. Three rules keep it small, and all three are enforced on write:

1. `said` is capped at `SAID_MAX = 500` characters, `question.header` at 120, four options at 80 each, `message` at 500, `note` at 80.
2. A `gone` entry is deleted once it is older than `GONE_TTL_MS` (6 hours).
3. If `items` exceeds `ITEM_CAP = 400`, the entries with the oldest `changedAt` are dropped until it does not. 400 conversations is ~180 KB, five times anything observed, and a dropped entry is simply rediscovered by the next listing with fresh counters — which releases any card held against it, the safe direction.

### The handover: `dev-prefs-<user>` / `prefs.json`, under `focus.awaiting`

No new document. `FocusPrefs` (`prefs.ts:19`) gains one field beside the pins, the snoozes and the done-markers, written by the browser with that person's own Rancher session through the existing `savePrefs` (`prefs.ts:81`).

```ts
export interface FocusPrefs {
  /** Queue keys pinned beside the deck. */
  pinned: string[];
  /** Queue key to the ISO time it comes back. */
  snoozed: Record<string, string>;
  /** Queue key to when it was dealt with, so it does not come straight back. */
  done: Record<string, string>;
  /**
   * Cards put aside until an agent moves, rather than until a time.
   *
   * `snoozed` is a clock, and the one thing this deck most needs to put aside is not on one: a
   * card you have just set an agent working on is not yours to move until the agent stops, which
   * is ten minutes or an hour - and it sat at the top of the deck for all of it, with a primary
   * button that would have started a second conversation in the same workspace.
   *
   * Per person, like the snoozes, and for the reason this file already states about the secrets
   * beside it: the conversation is everybody's, it is in a shared pod, but putting a card aside
   * is one person's arrangement of it - and pressing "Fix it" must not take the card off a
   * colleague's deck. It could not live in dev-api even if it wanted to: that service is reached
   * through the apiserver's service proxy, which does not forward who is asking.
   *
   * What is stored is what the snapshot said when the button was pressed. See `awaitingAgent` in
   * focus.ts for what that can and cannot tell.
   */
  awaiting: Record<string, AwaitedAgent>;
}

export interface AwaitedAgent {
  /** The conversation the work was handed to. */
  conversation: string;
  /** Which snapshot the counters came from, so a document that was deleted releases the card. */
  epoch: string;
  /** Which conversation, not just which id: `sessions.sh new` reuses the lowest free ordinal. */
  bornAt: string;
  /** The counters it was at. The card comes back when either moves. */
  stops: number;
  asks: number;
  /** When the button was pressed, for the seconds before the watcher has looked. */
  at: string;
}
```

`EMPTY_FOCUS` (`prefs.ts:36`) becomes `{ pinned: [], snoozed: {}, done: {}, awaiting: {} }`, `readPrefs` parses it with a validator of its own (below), and `sweepState` (`focus.ts:281`) ages it out at `AWAIT_HOURS = 72` — long enough that a card put aside on Friday is still waiting on Monday.

A malformed entry here holds a card out of the deck for ever rather than failing visibly, so it is validated rather than trusted:

```ts
function awaited(value: unknown): Record<string, AwaitedAgent> {
  if (!value || typeof value !== 'object') {
    return {};
  }

  return Object.fromEntries(Object.entries(value as Record<string, Json>)
    .filter(([, held]) => held && typeof held.conversation === 'string' && typeof held.at === 'string')
    .map(([key, held]) => [key, {
      conversation: held.conversation,
      epoch:        String(held.epoch || ''),
      bornAt:       String(held.bornAt || ''),
      stops:        Number(held.stops) || 0,
      asks:         Number(held.asks) || 0,
      at:           held.at,
    }]));
}
```

### Tenancy, plainly

**The snapshot is global.** One document, no owner label, holding every conversation in the cluster: the drawer's `agent-<n>` and every workspace's `p-<workspace>-<n>`. That is not a choice this feature makes, it is the shape of what is being watched — the conversations live in one agent pod on one hostPath with one claude login, which is why there is one pod and not one per workspace; `sessions.sh` namespaces them by workspace and never by person; and nothing anywhere records who started one (`<id>.by` records *what* started it, `panel` or `api`, not *who*). `dev-api` runs as one ServiceAccount, on a timer, on behalf of nobody.

So one person can see every conversation in this cluster, **which is already true today**: `conversationStates()` globs every workspace's state files and returns the lot to whichever browser asked, and the drawer's tab strip lists every `agent-<n>`. This makes that cheaper, not wider. The one constraint it puts on the body is the one stated above: no prompts, no transcript text.

**The handover is per person.** Two people watching `p-pr-19212-1` each press their own button, each store their own counters, and each get their own card back. Neither can clear the other's, and neither learns that the other was waiting — exactly how `pinned`, `snoozed` and `done` already behave.

If per-person conversations are ever wanted, the shape is one field where the conversation is: whatever starts one writes `<id>.who` beside the existing `<id>.by`, `states-all` prints it as a fifth column, the watcher carries it, the client filters. It is deliberately not in this change: nothing asks for it, and a filter over a field nothing writes is a filter that hides everything.

## 6. The HTTP API

Four routes, in the `routes` table (`server.mjs:2868`) immediately after the `/agents/{id}/runs` pair at line 2971 — the run records are the nearest neighbour. Reached from the browser through `DEV_API` (`reviews.ts:43`) and from an in-cluster agent as `$CLAUDE_HARNESS_API/conversations`.

```js
  // -- Conversations -------------------------------------------------------------------------
  //
  // What every claude in the Studio's agent pod is doing, and how many times each has stopped
  // and asked. Watched here (reconcileConversations) rather than read by a browser, which is the
  // whole of the change: every read of this used to be an exec issued BY a tab, so with no tab
  // open nothing observed anything - and the two moments worth knowing about, "it finished" and
  // "it is asking you something", are by definition moments when nobody is watching.
  //
  // A snapshot and two counters rather than a log. `stops` and `asks` are what a client compares
  // against what it last acted on; what they cannot say is which way the news went, and that is
  // paid where it is cheapest - the card comes back either way, and what it is about is read off
  // the conversation when the card is drawn. The sequence, when somebody wants it, is the hook's
  // own events.jsonl: see /conversations/{id}/events.
  ['GET', /^\/conversations$/, async(m, url) => conversationsAnswer(url)],
  ['GET', /^\/conversations\/(agent-\d+|p-[a-z0-9-]+-\d+)$/, async(m) => {
    const held = (await conversationDoc()).items?.[m[1]];

    if (!held) {
      throw failure(404, `No conversation called ${ m[1] }.`);
    }

    return { conversation: held, ...freshness() };
  }],
  // The sequence, read off the hook's own log rather than from a log of our own. The id pattern
  // is spelled out rather than `[^/]+` because this one interpolates into a path.
  ['GET', /^\/conversations\/(agent-\d+|p-[a-z0-9-]+-\d+)\/events$/, async(m, url) => ({
    id: m[1], ...hookEvents(m[1], Number(url.searchParams.get('limit') || 50)),
  })],
  // Look now rather than at the next tick. One caller: a page that has just set an agent
  // working. Without it the card it put aside comes back for one tick at the counters it was put
  // aside at, on top of somebody who has just dealt with it. At most one listing in flight
  // however many tabs press it.
  ['POST', /^\/conversations\/refresh$/, async() => {
    await listingTick();

    return conversationsAnswer(new URL('http://dev-api/conversations'));
  }],
```

### `GET /conversations`

| query | |
|---|---|
| `workspace=<name>` | only that workspace's conversations |
| `state=idle,input` | only those states; this is the owner's "poll which ones have finished" |

There is deliberately no `changedSince`. It would be three lines and it would read like a cursor to everybody who found it, while being unable to show a conversation that changed twice or changed and changed back.

```json
{
  "conversations": [
    {
      "id": "p-pr-19212-1", "kind": "workspace", "workspace": "pr-19212",
      "state": "input", "was": "working", "note": "permission",
      "stops": 3, "asks": 2,
      "bornAt": "2026-10-03T09:12:00.004Z",
      "changedAt": "2026-10-04T12:33:01.004Z",
      "hookAt": "2026-10-04T12:33:00.881Z",
      "alive": true, "wroteAgo": 134,
      "event": "Notification",
      "message": "Claude needs your permission to use Bash",
      "said": "I can run the suite headed, but that needs permission to shell out.",
      "question": { "tool": "AskUserQuestion", "header": "Which suite first?", "options": ["e2e/login", "e2e/nav", "all of them"] }
    },
    {
      "id": "agent-3", "kind": "drawer", "workspace": "",
      "state": "working", "was": "idle", "note": "",
      "stops": 19, "asks": 1,
      "bornAt": "2026-10-04T11:02:11.000Z",
      "changedAt": "2026-10-04T12:40:55.881Z",
      "hookAt": "2026-10-04T12:40:55.102Z",
      "alive": true, "wroteAgo": 3,
      "event": "UserPromptSubmit", "message": "", "said": "", "question": null
    }
  ],
  "epoch": "m1k9wq2z",
  "pod": "extension-studio-agent-5f9c7d8b-xk2qp",
  "podSettled": true,
  "mount": true,
  "watchedAt": "2026-10-04T12:41:10.002Z",
  "ageMs": 4120,
  "stale": false,
  "ok": true,
  "detail": ""
}
```

Sorted by `changedAt`, newest first. The six fields after `conversations` are what stop a consumer believing a watcher that has stopped, and each answers a different question:

`watchedAt`/`ageMs`/`stale` are about **the loop**, not the exec: `watchedAt` is updated by every tick whatever happened, so `stale` (older than `STALE_MS = 150_000`, five missed disk ticks) means the loop itself has died. `ok`/`detail` are about **the last listing**: an exec that 403s or times out sets `ok: false` with a sentence, and that is drawn in the UI rather than only logged, because the `pods/exec` grant only lands when somebody loads the dashboard and a silent 403 loop looks exactly like the bug this was built to fix. Crucially, a client must release held work on `stale` and **not** on `!ok`: five consecutive exec timeouts is precisely what a busy cluster with several working agents looks like, and releasing then would put every put-aside card back at once, each claiming its agent had finished. The hook state is still arriving off the mount in that case, so the answer is not even degraded.

`watchedAt: ""` means the loop has not run yet — the first few seconds after a publish — and is **not** the same as stale: the counters are correct, because they were read back from the document.

`podSettled: false` means the agent pod changed less than `POD_SETTLE_MS` ago, so a dead pane is not news. `mount: false` means this pod cannot see the agent's hostPath — a multi-node cluster — so the state is only as fresh as the 30-second listing; the response says so rather than silently degrading.

### `GET /conversations/{id}`

`{ "conversation": { … }, "epoch": …, "stale": false, … }`, or 404 with `No conversation called p-pr-19212-9.`

### `GET /conversations/{id}/events?limit=50`

The hook's own firings, newest first, read by tailing `<id>.events.jsonl` on the mount. For the chat view's "why does this say it is waiting?" and for a person debugging a wrong dot. Not for the deck.

```json
{
  "id": "p-pr-19212-1",
  "mount": true,
  "events": [
    { "event": "Notification", "at": "2026-10-04T12:33:00.881Z", "notification": "permission", "message": "Claude needs your permission to use Bash" },
    { "event": "UserPromptSubmit", "at": "2026-10-04T12:18:44.201Z", "prompt": "run the e2e suite" },
    { "event": "Stop", "at": "2026-10-04T12:17:02.773Z" }
  ]
}
```

`{ "mount": false, "events": [] }` where this pod cannot read the volume. An empty list with `mount: true` means the conversation has never fired a hook. The id is matched against the literal pattern above before it is interpolated into a path; nothing from a caller reaches the filesystem unchecked.

### `POST /conversations/refresh`

No body. Runs one listing tick, under the same mutex as the loop, and answers with the body of `GET /conversations`.

### OPENAPI

Added to the `paths` object at `server.mjs:1187`, after `/focus/cards/{id}` — the file's own header says a spec kept elsewhere is a spec that drifts, and the agent pod's CLAUDE.md tells an agent to read `/openapi.json` rather than to be told the routes.

```js
    '/conversations': {
      get: {
        operationId: 'readConversations',
        summary:     'Every conversation in the Studio\'s agent pod, and what it is doing.',
        description: [
          'Written by a loop in this pod (reconcileConversations), not by a browser - which is the',
          'point, since every other read of a conversation is an exec a tab issues. So this is also',
          'the answer to "what finished while nothing was open".',
          '',
          '`stops` and `asks` are how many times each conversation has ended a turn and asked for',
          'something, ever. Store them, compare them, and you know how many you missed. They say how',
          'many and never what; for that, read /conversations/{id}/events.',
          '',
          '`stale: true` means the loop has stopped and the states are history. `ok: false` means the',
          'last listing failed - the states are still being refreshed off the mount, so they are old',
          'rather than wrong.',
        ].join('\n'),
        parameters: [
          { name: 'workspace', in: 'query', schema: { type: 'string' }, description: 'Only that workspace\'s conversations.' },
          { name: 'state', in: 'query', schema: { type: 'string' }, description: 'Comma separated: working, input, idle, finished, none, gone.' },
        ],
        responses: { 200: { description: 'The conversations, newest change first, and the watcher\'s own freshness.' } },
      },
    },
    '/conversations/{id}/events': {
      parameters: [{
        name: 'id', in: 'path', required: true, schema: { type: 'string' }, description: '`agent-<n>` or `p-<workspace>-<n>`.',
      }],
      get: {
        operationId: 'readConversationEvents',
        summary:     'One conversation\'s hook firings, newest first.',
        description: 'Read off the hook\'s own log in the agent pod\'s volume, which it already keeps and already trims. `mount: false` means this API cannot see that volume.',
        responses:   { 200: { description: 'The firings.' } },
      },
    },
    '/conversations/refresh': {
      post: {
        operationId: 'refreshConversations',
        summary:     'Run one listing now rather than waiting for the next tick.',
        description: 'For a caller that has just started or ended a conversation. One listing in flight at a time, however many callers press it.',
        responses:   { 200: { description: 'The snapshot, after the listing.' } },
      },
    },
```

## 7. The watcher

A fourth section in `server.mjs`, after `reapTools` (line 2802) and before the `routes` table. Two cadences, because the two halves of the question cost differently — and the split is the whole economy of the design: 5-second freshness for 2 execs a minute, where one loop asking the pod every 5 seconds would be 12.

The exec answers what only a process in that pod can answer: which conversations exist, and whether each pane is alive. The mount answers what changes every few seconds: the hook's last event and the transcript's mtime. **The exec is sufficient and the mount is an accelerator** — the listing already carries the full state head in its fourth column, so a cluster where the mount is the wrong directory degrades to 30-second freshness and says so, rather than silently refreshing nothing.

### The script: one new verb

`seed/agent/sessions.sh` gains `states-all`, sharing the whole `states` body — the `tmux has-session`, the transcript stat, the subagent walk, the 800-byte state head. One code path, one owner. It must **not** call `title_of`; see §2.

```sh
 case "$VERB" in
   list|new|states) PROJECT=$2; ID='' ;;
+  # Every conversation in this pod, the drawer's and every project's, in one listing.
+  #
+  # A verb of its own rather than `states all`, because every lowercase word is a legal project
+  # name and a workspace somebody called `all` would then be the only unlistable one. The caller
+  # is the Dev extension's watcher (dev-api, reconcileConversations), which polls on behalf of
+  # everybody and has no project in mind: one exec here is the difference between a fixed cost
+  # and one exec per workspace per tick.
+  states-all) PROJECT=''; ID='' ;;
 esac
```

```sh
-if [ -n "$PROJECT" ]; then
+if [ "$VERB" = states-all ]; then
+  PREFIX=''
+elif [ -n "$PROJECT" ]; then
   PREFIX="p-$PROJECT-"
 else
   PREFIX="agent-"
 fi
```

The id guard inside `states` is `case "${id#"$PREFIX"}" in ''|*[!0-9]*) continue ;; esac`, which with an empty prefix rejects everything. It becomes a function, defined beside `title_of`:

```sh
# Whether this id is one of the kind this run is listing.
#
# With a prefix, what follows it must be nothing but the ordinal - the prefix is a glob, and a
# glob for project `foo` also matches project `foo-bar`. With no prefix (states-all) both kinds
# are being listed at once, so the shape itself is the test.
wanted_id() {
  if [ -z "$PREFIX" ]; then
    case "$1" in
      agent-*|p-?*-*) ;;
      *) return 1 ;;
    esac

    case "${1##*-}" in
      ''|*[!0-9]*) return 1 ;;
    esac

    return 0
  fi

  case "${1#"$PREFIX"}" in
    ''|*[!0-9]*) return 1 ;;
  esac
}
```

`states)` becomes `states|states-all)`, the guard inside the loop becomes `wanted_id "$id" || continue`, and the branch ends with a sentinel:

```sh
    if [ "$VERB" = states-all ]; then
      # Say that the listing ran to its end.
      #
      # The watcher's exec client reports stdout and nothing else (podExec, server.mjs), so a pod
      # holding no conversations and an exec the apiserver abandoned mid-stream both arrive as a
      # short listing - and treating the second as the first would mark every conversation gone
      # and bump every counter in the cluster. One line at the end is cheaper than an exit status
      # the caller cannot see, and it is at the end rather than the start so a truncated listing
      # fails the test too. Only for states-all: `states` output is parsed by three browser
      # callers and is left byte for byte as it was.
      echo '@@end'
    fi
```

The unknown-verb message gains `states-all`. Then regenerate `seed.generated.ts`, whose keys are the flattened file names (`sessions.sh`, not `agent/sessions.sh`):

```bash
node -e '
const fs=require("fs"),path=require("path");
const root="pkg/dev-extension/seed",out="pkg/dev-extension/seed.generated.ts",files={};
(function walk(d){for(const e of fs.readdirSync(d,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name)))
  e.isDirectory()?walk(path.join(d,e.name)):files[e.name]=fs.readFileSync(path.join(d,e.name),"utf8");})(root);
fs.writeFileSync(out,"/* eslint-disable */\n// Generated by scripts/gen-seed.mjs from pkg/agents/seed. Do not edit.\nexport const AGENT_FILES: Record<string, string> = {\n"
  +Object.keys(files).sort().map((k)=>`  ${JSON.stringify(k)}: ${JSON.stringify(files[k])},\n`).join("")+"};\n");'
```

This does not roll the agent pod: `agentBootVersion()` hashes only the three boot scripts, and the ConfigMap volume updates in place.

### The exec client

**No new exec client.** `podExec` at `server.mjs:154` is used as it is. Its one gap — stdout only — is closed by `@@end`, which is cheaper and less risky than reworking a function whose subprotocol choice is documented and settled. Two call-specific points: the listing passes `waitMs = 30_000` rather than the two-minute default, because this is a directory walk and not a `node -e` over a transcript; and the argv is a literal in this file, which is the reason the `pods/exec` grant below is defensible — no route takes a command from a caller, and nothing must ever make that untrue.

### The RBAC

`api.ts`, inside `ensureRules(… API_NAME …)`, after the `pods, pods/log` rule at line 2841 — **not** the rule at 2217, which belongs to `dev-global-terminal`:

```ts
      { apiGroups: [''], resources: ['pods', 'pods/log'], verbs: ['get', 'list'] },
      /*
       * One exec, into one pod: `sessions.sh states-all` in the Studio's agent pod, every thirty
       * seconds (reconcileConversations in server.mjs). It is the only thing in this service that
       * cannot be answered from the apiserver or from a mount - a tmux server is per user and
       * answers only to a process inside its own pod, so whether a conversation's pane is alive
       * is a question only a command in there can ask.
       *
       * This role did not have it. The `pods/exec` rule further up this file belongs to
       * `dev-global-terminal`, the account the browser's terminals run as, so granting it there
       * granted it to nothing that runs in this pod. `resourceNames` cannot narrow it: a pod's
       * name changes on every roll. What keeps it honest is that the watcher's argv is a literal
       * and no route takes a command from a caller.
       */
      { apiGroups: [''], resources: ['pods/exec'], verbs: ['create', 'get'] },
```

### The module

```js
// -- Conversations ---------------------------------------------------------------------------
//
// What the browser could only ask while a tab was open, asked here instead. Every read of a
// conversation's state used to be an exec issued BY THE BROWSER (conversations.ts, through
// podExecOnce), so with no tab open nothing observed anything: an agent could finish at four in
// the morning and the only record of it was a hook file nobody would read until somebody loaded
// a page.
//
// The expensive half of that question and the cheap half are different questions, and separating
// them is the whole of this loop's cost.
//
//   The listing - which conversations exist, and whether each pane is alive - is one exec, because
//   `sessions.sh` owns the first and only a process inside that pod can answer the second.
//
//   The fields that move every few seconds - the hook's last event, the transcript's mtime - are
//   files, and this pod already has them: it mounts the agent pod's /workspace read-only at
//   AGENT_ROOT so a review's evidence can be served out of it, and the same mount holds
//   sessions/<id>.state.json.
//
// So: one exec every thirty seconds, and a handful of stats every five. The exec is sufficient on
// its own - the listing carries the whole state head - which is what lets a cluster where this pod
// cannot see that volume degrade to thirty-second freshness and say so (see `mount`) rather than
// silently refreshing nothing.

const AGENT_NAMESPACE = process.env.AGENT_NAMESPACE || 'extension-studio';
const AGENT_APP = process.env.AGENT_APP || 'extension-studio-agent';
const AGENT_CONTAINER = process.env.AGENT_CONTAINER || 'agent';
/** Where the agent pod's conversations are, as this pod sees them. See AGENT_ROOT. */
const AGENT_SESSIONS = `${ AGENT_ROOT }/sessions`;

const CONVERSATIONS_DOC = process.env.DEV_CONVERSATIONS_MAP || 'dev-conversations';
const CONVERSATIONS_KEY = 'conversations.json';
const CONVERSATION_LABELS = { 'dev.rancher.io/kind': 'conversations' };

const LISTING_MS = 30_000;
const DISK_MS = 5_000;
/** Five missed disk ticks. Past this the loop has stopped and the states are history. */
const STALE_MS = 150_000;

/**
 * How long after a new agent pod appears a dead pane is not news.
 *
 * Measured, and the reason this guard exists: tmux is empty for the first minute after the agent
 * pod restarts, while every conversation is still there on the hostPath with its transcript and
 * its name intact - the note at the top of sessions.sh is about exactly this. dev-api is rolled by
 * the same publish that rolls that pod, so without this the first tick after every release would
 * declare every conversation in the cluster finished at once.
 */
const POD_SETTLE_MS = 120_000;

/**
 * How long a conversation is kept after its directory has gone.
 *
 * Not dropped the moment it disappears, because disappearing is itself the news: a deck holding a
 * card until a conversation moved, and told nothing, holds it for ever. `sessions.sh end` removes
 * the directory as well as the session, so this is the only record that it ever existed.
 */
const GONE_TTL_MS = 6 * 3600_000;

/** Entries kept, oldest change dropped first. Five times anything observed; see the doc. */
const ITEM_CAP = 400;
const SAID_MAX = 500;
/** Several turns of transcript. A transcript itself runs to many megabytes. */
const TAIL_BYTES = 128 * 1024;

/**
 * How recently the transcript must have moved for a conversation to count as working.
 *
 * The same ninety seconds the browser used when it made this judgement itself. Long enough to
 * cover a subagent thinking between writes, short enough that a conversation nobody is in stops
 * claiming to be busy. Kept identical on purpose: the point of moving the derivation here is that
 * one answer is given, not that a third one is invented.
 */
const WORKING_WINDOW_S = 90;

/**
 * The hook events that are the last word on a conversation, when they are the latest thing to
 * have happened.
 *
 * `Stop` and `SessionEnd` say the turn is over and both fire after that turn's final writes land,
 * so for a few seconds afterwards the transcript still looks like it is moving. `Notification`
 * fires right after the tool call it is asking permission for was written down. Each has to be
 * able to overrule a transcript that has only just stopped, which is the five-second margin below.
 *
 * `SessionStart` and `UserPromptSubmit` are not on this list, and that is the point of having one:
 * neither says anything about whether claude is busy now. SessionStart is the case that was wrong
 * for longest - the CLI fires it the moment it finishes an auto-compact and then carries straight
 * on with the rest of the turn, while the transcript, quiet all through the compaction, is the only
 * thing that knows. Letting it know halved the samples where a working conversation showed an idle
 * dot (agent.ts, activityState, which this is ported from).
 */
const SPEAKS_LAST = new Set(['Stop', 'SessionEnd', 'Notification']);

/** The states that mean it has stopped and the work is a person's again. */
const SETTLED = new Set(['input', 'idle', 'finished']);
const QUESTION_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode']);
const CONVERSATION_ID = /^(agent-\d+|p-[a-z0-9-]+-\d+)$/;

/** Which agent pod the last listing came from, and when this process first saw that one. */
let agentSeen = { pod: '', since: 0 };
/** What this process knows about its own looking. In memory: a write per tick to say "nothing
 * happened" is the cost this design exists to avoid, and what a client wants from this is whether
 * THIS process is still looking, which only this process knows. */
let watch = { at: 0, ms: 0, ok: true, detail: '', mount: true, first: true };
/** One tick at a time, whichever kind. See `once`. */
let ticking = null;
let noAgentPod = false;
/** A short memo, so a dozen browser tabs polling do not each cost an apiserver read. */
let memo = { at: 0, doc: null };
```

### The derivation, which is now the only one

```js
/**
 * The bucket a conversation falls in, from what the pod reported about it.
 *
 * Ported verbatim from `activityState` (agent.ts:448) - the newer of the two browser copies, the
 * one that carries the SessionStart fix - and it is here because this is the judgement that has to
 * be made when nobody is looking. `agentStateOf` (workspace-status.ts) is deleted in the same
 * change; it was the drifted copy, with neither SPEAKS_LAST nor that fix, which is why the same
 * conversation read `idle` in the sidebar and `working` in the conversation strip after a compact.
 *
 * The transcript outranks the hook: a hook fires only at a turn's edges, so a turn spent inside
 * subagents reads as finished to it while the subagents write all the while, and a permission
 * prompt answered in the terminal leaves the last Notification standing over an agent that is
 * working again.
 *
 * '' is returned for "nothing believable", which the caller folds in as no change at all. A state
 * file caught between the hook's write and its rename, and an `alive: no` from a pod that has only
 * just started, are both doubt rather than news.
 */
function conversationState(a, podStartedMs = 0) {
  // Neither a hook file nor a transcript: a conversation nobody has ever opened. Which is what
  // leaves a fresh tab with no dot rather than a misleading one.
  if (!a.event && a.wroteAgo < 0) {
    return 'none';
  }

  const hookMs = Date.parse(a.at) || 0;

  if (!a.alive) {
    /*
     * A pane that is not there, which is only believable twice over.
     *
     * For the first two minutes after the agent pod changes there is no tmux server at all while
     * every conversation is still on the hostPath waiting to be reattached. And a hook event
     * written before this container started was written by a claude that no longer exists, so its
     * pane being absent says nothing that was not already true - and that holds however long ago
     * the pod came up, which is what stops a conversation last touched a week ago becoming
     * `finished` news the moment the settle window passes.
     */
    if (!podStartedMs || Date.now() - podStartedMs < POD_SETTLE_MS || (hookMs && hookMs < podStartedMs)) {
      return '';
    }

    return 'finished';
  }

  const hookAgo = (Date.now() - hookMs) / 1000;
  const overruled = SPEAKS_LAST.has(a.event) && hookAgo <= a.wroteAgo + 5;

  if (a.wroteAgo >= 0 && a.wroteAgo <= WORKING_WINDOW_S && !overruled) {
    return 'working';
  }
  // claude said it exited. The pane may well still be there - the loop that owns it restarts
  // claude in a moment - but nothing is running in it now. Below the transcript window on purpose:
  // a `/clear` fires SessionEnd too, and the SessionStart a second later takes this back.
  if (a.event === 'SessionEnd') {
    return 'finished';
  }
  if (a.event === 'Notification' && a.notification && a.notification !== 'idle_prompt') {
    return 'input';
  }
  switch (a.event) {
  case 'UserPromptSubmit':
  case 'PreToolUse':
  case 'PostToolUse':
  case 'SubagentStop':
    return 'working';
  case 'Notification':
    return a.notification === 'idle_prompt' ? 'idle' : 'input';
  default:
    return 'idle';
  }
}
```

### The document

```js
const freshDoc = () => ({
  v: 1, epoch: `${ Date.now().toString(36) }${ Math.random().toString(36).slice(2, 6) }`, at: '', pod: '', items: {},
});

/**
 * The document, read rather than cached between ticks.
 *
 * Two watchers exist for a few seconds of every publish: the dev-api Deployment has replicas 1 and
 * no `strategy`, so Kubernetes defaults to RollingUpdate with maxSurge 1, and `ensure` in api.ts is
 * create-if-missing so `strategy: Recreate` cannot be retrofitted to a cluster that already has
 * one. `writeDoc` is a merge-patch with no precondition, so the answer is not to serialise but to
 * be idempotent: both watchers read the same base, both compute the same fold from the same inputs
 * (see `foldOne`), and the clobber is harmless. Caching the document in a module variable is what
 * would make it harmful.
 *
 * The memo is two seconds, for the browser tabs polling this through the service proxy; a tick
 * passes `true` and reads through it.
 */
async function conversationDoc(force = false) {
  if (!force && memo.doc && Date.now() - memo.at < 2_000) {
    return memo.doc;
  }
  const held = await readDoc(CONVERSATIONS_DOC, CONVERSATIONS_KEY).catch(() => null);
  const doc = held?.items ? held : freshDoc();

  memo = { at: Date.now(), doc };

  return doc;
}

async function writeConversations(doc, changed) {
  memo = { at: Date.now(), doc };
  if (!changed) {
    return;
  }

  await writeDoc(CONVERSATIONS_DOC, CONVERSATIONS_KEY, doc, CONVERSATION_LABELS);
}
```

### The exec half

```js
/** The running agent pod, or null. `Running` rather than `Ready`: this pod has no probes. */
async function agentPod() {
  const pods = await k8s(`/api/v1/namespaces/${ AGENT_NAMESPACE }/pods?labelSelector=app%3D${ AGENT_APP }`).catch((e) => {
    /*
     * No such namespace, said once.
     *
     * dev-api runs on every cluster a workspace can land on and the agent pod is only ever on
     * `local`, so downstream this is the normal and permanent answer. The three reconcilers above
     * each learned the expensive way that a failure logged every tick, forever, on every downstream
     * cluster is worse than no feature; see `installations`.
     */
    if (e.status === 404) {
      noAgentPod = true;
      console.log(`[dev-api] conversations: no ${ AGENT_NAMESPACE } namespace on this cluster, so there is no agent pod to watch; not asking again.`);
    } else {
      watch = { ...watch, ok: false, detail: `the agent pod could not be looked up: ${ e.message || e }` };
    }

    return null;
  });

  return (pods?.items || []).find((pod) => pod.status?.phase === 'Running' && !pod.metadata?.deletionTimestamp) || null;
}

/**
 * When the claude side of this pod started, which is what decides whether `alive: no` means
 * anything. The container's own start, not the pod's: a pod scheduled an hour ago whose container
 * restarted ninety seconds ago has an empty tmux server either way.
 */
function agentStartedMs(pod) {
  const container = (pod.status?.containerStatuses || []).find((c) => c.name === AGENT_CONTAINER);

  return Date.parse(container?.state?.running?.startedAt || pod.status?.startTime || '') || 0;
}

/**
 * The listing: one exec, and the only thing here allowed to decide what a conversation IS.
 *
 * `sessions.sh states-all` owns that. A conversation is a directory under /workspace/sessions and
 * not a tmux session, a distinction two earlier versions of this question got wrong in two
 * different ways, and that script is also the only place that can say whether a pane is alive.
 */
async function listingTick() {
  return once(async() => {
    if (noAgentPod) {
      return;
    }
    const started = Date.now();
    const pod = await agentPod();

    if (!pod) {
      // Not "no conversations": every one of them is still on the hostPath. Record that the tick
      // could not look, and change nothing.
      return note('the agent pod is not running, so the conversations could not be listed', started);
    }
    if (pod.metadata.name !== agentSeen.pod) {
      agentSeen = { pod: pod.metadata.name, since: Date.now() };
    }

    const out = await podExec(AGENT_NAMESPACE, pod.metadata.name, AGENT_CONTAINER, ['/bin/sh', '/seed/sessions.sh', 'states-all'], 30_000);

    /*
     * The sentinel, and why it is not `out.trim()`.
     *
     * `podExec` hands back stdout and throws away stderr and the exit status (see its note), so an
     * exec that failed - a 403 because the pods/exec rule has not reached this cluster, a pod going
     * away mid-tick, a socket the apiserver abandoned - is indistinguishable from a pod holding no
     * conversations, and from a listing cut off halfway. Folding any of those in as the truth would
     * mark conversations gone and bump counters, which is the one mistake this loop can make that a
     * client cannot recover from. So the script says it ran to the end.
     */
    if (!out.includes('@@end')) {
      return note('the listing did not run to the end; keeping the last snapshot. If this persists, check that the pods/exec rule in api.ts has reached this cluster', started);
    }

    const rows = [];

    for (const line of out.split('\n')) {
      const [id, alive, wrote, head] = line.replace(/\r$/, '').split('\t');

      if (!id || !CONVERSATION_ID.test(id)) {
        continue;
      }
      rows.push({ ...rowOf(id, head), alive: alive === 'yes', wroteAgo: Number(wrote ?? -1) });
    }

    await absorb(rows, pod.metadata.name, agentStartedMs(pod), true, started);
  });
}

/** One row, from an id and the 800-byte head of its state file. */
function rowOf(id, head) {
  let hook = {};

  try {
    hook = JSON.parse(head || '{}');
  } catch { /* a state file caught between the hook's write and its rename; next tick reads it whole */ }

  return {
    id,
    kind:         id.startsWith('agent-') ? 'drawer' : 'workspace',
    workspace:    id.startsWith('agent-') ? '' : id.replace(/^p-/, '').replace(/-\d+$/, ''),
    event:        String(hook.event || ''),
    notification: String(hook.notification || ''),
    message:      String(hook.message || '').slice(0, 500),
    reason:       String(hook.reason || '').slice(0, 80),
    at:           String(hook.at || ''),
    transcript:   String(hook.transcript || ''),
  };
}
```

### The disk half

```js
/**
 * The hook's state file and the transcript's mtime, read off the mount.
 *
 * It refreshes ids the listing has already named and never discovers one, which is what keeps this
 * a refresh of fields rather than a second answer to what a conversation is. null means the file
 * could not be read, and the listing's own copy then stands.
 */
function diskRow(id) {
  let hook = {};

  try {
    hook = JSON.parse(fs.readFileSync(`${ AGENT_SESSIONS }/${ id }.state.json`, 'utf8'));
  } catch {
    return null;
  }

  const row = rowOf(id, JSON.stringify(hook));
  // The path in the state file is the pod's (`/workspace/...`); the same file is under the mount.
  const local = row.transcript.startsWith(AGENT_PREFIX) ? `${ AGENT_ROOT }/${ row.transcript.slice(AGENT_PREFIX.length) }` : '';
  let mtime = 0;

  if (local) {
    try {
      mtime = Math.floor(fs.statSync(local).mtimeMs / 1000);
    } catch { /* claude has not written it yet */ }

    /*
     * And its subagents'.
     *
     * The load-bearing half of `working`. The hook fires at a turn's edges, so a turn that spends
     * twenty minutes inside subagents reads as finished to it, while the subagents write their own
     * transcripts in a directory beside the session's the entire time.
     */
    try {
      for (const file of fs.readdirSync(`${ local.replace(/\.jsonl$/, '') }/subagents`)) {
        if (!file.endsWith('.jsonl')) {
          continue;
        }
        const at = Math.floor(fs.statSync(`${ local.replace(/\.jsonl$/, '') }/subagents/${ file }`).mtimeMs / 1000);

        mtime = at > mtime ? at : mtime;
      }
    } catch { /* no subagents, which is most turns */ }
  }

  return { ...row, wroteAgo: mtime ? Math.max(0, Math.round(Date.now() / 1000) - mtime) : -1 };
}

/**
 * The fast half: the fields that move, for the ids the listing already named.
 *
 * `alive` is the listing's to say, so its last answer is carried forward. A pane that died since
 * reads as working for up to thirty seconds and then as finished - thirty seconds of a wrong word,
 * against one exec every five seconds for a right one. `SessionEnd` closes most of that gap
 * anyway: claude writes it on its way out, and this half reads it.
 */
async function diskTick() {
  return once(async() => {
    if (noAgentPod) {
      return;
    }
    const started = Date.now();
    const doc = await conversationDoc(true);

    // Nothing listed yet means no ids to refresh and no pane this is allowed to call alive.
    if (!doc.pod) {
      return;
    }

    const rows = [];

    for (const held of Object.values(doc.items || {})) {
      if (held.state === 'gone') {
        continue;
      }
      const fresh = diskRow(held.id);

      if (fresh) {
        rows.push({ ...fresh, alive: held.alive });
      }
    }

    /*
     * Whether this pod can see the agent's volume at all.
     *
     * Both hostPaths are node-local and neither Deployment has a nodeSelector, so on a multi-node
     * cluster this mount is a different, empty directory - and an empty directory does not throw,
     * so every `readFileSync` lands in a catch that means "no state file yet". Silently refreshing
     * nothing for ever is the failure this field exists to prevent: the response says `mount:
     * false`, the states are then only as fresh as the thirty-second listing, and that is a
     * degradation somebody can see rather than one nobody finds out about.
     */
    watch = { ...watch, mount: !(Object.keys(doc.items || {}).length && !rows.length) };

    await absorb(rows, doc.pod, agentSeen.since ? agentStartedMs({ status: {} }) || agentSeen.since : 0, false, started);
  });
}
```

> Implementation note: `absorb`'s `podStartedMs` argument on the disk path is the container start the listing recorded. Keep it on the document (`doc.startedAt`, written by the listing tick) rather than re-deriving it here; the line above is shorthand for reading it back. Do not call the apiserver from the disk tick — it is the half that must cost nothing.

### The fold

```js
/**
 * Fold one observation in, and move a counter where something moved.
 *
 * `stops` and `asks` are the whole of the contract with a client: it holds what they were when it
 * handed work over and compares. So they must move exactly once per turn boundary and never for
 * the clock - `changedAt` and `wroteAgo` change on every tick, and a counter that moved with them
 * would be one no client could ever match.
 *
 * Derived from the stored values rather than incremented in memory, and keyed on the hook's own
 * `at`: two watchers folding the same observation onto the same base reach the same answer, which
 * is what makes the merge-patch clobber during a rollout harmless. The same property is what makes
 * a tick that re-reads an unchanged state file a no-op.
 */
function foldOne(before, seen, state, now) {
  if (!before || before.state === 'gone') {
    return {
      ...seen,
      state,
      was:       '',
      // Adopted, not announced: a conversation seen for the first time has a history this watcher
      // did not observe, and counting it would mean installing this feature credited every
      // conversation in the cluster with a stop it never saw.
      stops:     0,
      asks:      0,
      bornAt:    now,
      changedAt: now,
      hookAt:    seen.at,
    };
  }

  const moved = before.state !== state || before.hookAt !== seen.at || before.alive !== seen.alive;

  if (!moved) {
    return { ...before, ...seen, state, hookAt: seen.at };
  }

  const ended = SETTLED.has(state) && state !== 'input';
  const wasEnded = SETTLED.has(before.state) && before.state !== 'input';

  return {
    ...before,
    ...seen,
    state,
    was:       before.state,
    stops:     before.stops + (ended && !wasEnded ? 1 : 0),
    asks:      before.asks + (state === 'input' && before.state !== 'input' ? 1 : 0),
    changedAt: now,
    hookAt:    seen.at,
  };
}

/** `listing` says this came from the exec, which is the only thing allowed to call one gone. */
async function absorb(rows, pod, podStartedMs, listing, started) {
  const doc = await conversationDoc(true);
  const nowMs = Date.now();
  const now = new Date(nowMs).toISOString();
  const items = { ...(doc.items || {}) };
  const seen = new Set();
  let changed = false;

  for (const row of rows) {
    seen.add(row.id);
    const before = items[row.id] || null;
    const state = conversationState(row, podStartedMs);

    // Doubt rather than news: a state file caught mid-rename, or a pane whose absence cannot yet
    // be believed. Nothing moves, so nothing anybody put aside comes back on a publish.
    if (!state) {
      continue;
    }

    const gap = watch.first && before && before.hookAt && before.hookAt !== row.at ? hookGap(row.id, before.hookAt, row.at) : null;
    const base = gap ? { ...before, stops: before.stops + gap.stops, asks: before.asks + gap.asks } : before;
    const next = foldOne(base, row, state, now);

    if (SETTLED.has(state) && (!before || before.state !== state)) {
      // What it last said, read once, here. `agentTurnOf` in the browser costs up to five execs
      // for this and the deck prefetches two neighbours; the transcript is on this mount already.
      Object.assign(next, detailOf(row));
    }
    changed = changed || !before || next.stops !== before.stops || next.asks !== before.asks ||
      next.state !== before.state || next.alive !== before.alive;
    items[row.id] = next;
  }

  if (listing) {
    for (const [id, held] of Object.entries(items)) {
      if (held.state === 'gone') {
        if (nowMs - Date.parse(held.changedAt || '') > GONE_TTL_MS) {
          delete items[id];
          changed = true;
        }
        continue;
      }
      if (seen.has(id)) {
        continue;
      }
      /*
       * Its directory has gone, which `end` does deliberately - it is what `new` allocates
       * against. News, and it gets an entry of its own rather than simply disappearing: a client
       * holding a card until this conversation moved would otherwise hold it until somebody
       * noticed. The counters stop here; a reused id gets a new `bornAt` and starts again.
       */
      items[id] = {
        ...held, state: 'gone', was: held.state, alive: false, changedAt: now, said: '', question: null,
      };
      changed = true;
    }
  }

  // The ceiling, enforced on write. A dropped entry is rediscovered by the next listing with fresh
  // counters, which releases anything held against it - the safe direction.
  const ids = Object.keys(items);

  if (ids.length > ITEM_CAP) {
    for (const id of ids.sort((a, b) => Date.parse(items[a].changedAt || '') - Date.parse(items[b].changedAt || '')).slice(0, ids.length - ITEM_CAP)) {
      delete items[id];
    }
    changed = true;
  }

  watch = {
    at: nowMs, ms: nowMs - started, ok: true, detail: '', mount: watch.mount, first: false,
  };
  await writeConversations({ ...doc, at: now, pod, startedAt: podStartedMs, items }, changed);

  for (const row of rows) {
    const next = items[row.id];
    const before = (doc.items || {})[row.id];

    if (next && (!before || before.state !== next.state)) {
      console.log(`[dev-api] conversation ${ row.id }: ${ before?.state || 'new' } -> ${ next.state }${ next.note ? ` (${ next.note })` : '' } (stops ${ next.stops }, asks ${ next.asks })`);
    }
  }
}
```

### The gap a publish leaves

```js
/**
 * The hook firings a conversation recorded between the last one this watcher saw and the one it is
 * looking at now.
 *
 * For the gap a restart leaves. dev-api is replaced by every publish and the roll takes up to a
 * minute; a turn that both begins and ends inside that minute leaves the document saying `idle`
 * before and the listing saying `idle` after, so the fold sees no transition and the person who was
 * away for all of it is told nothing happened. The hook's own log is the record that survives - it
 * appends every firing to `<id>.events.jsonl` for exactly this kind of question, trimmed at 512
 * KiB - and this pod has that volume mounted already, so reading it costs nothing.
 *
 * Only the two firings that are worth a count: a Stop (the turn ended) and a Notification that is
 * not an idle prompt (it is waiting). Strictly between the two timestamps, so the firing that
 * produced the state being folded in is counted by the fold and not twice.
 *
 * Once per conversation, on the first tick of a process, and only where the hook has moved since.
 * Zero when the file cannot be read, which includes the case where this pod is on a different node
 * from the agent pod: recovering nothing is the right failure, because these are events that are
 * already over and inventing one is worse than missing one.
 */
function hookGap(id, fromAt, toAt) {
  const from = Date.parse(fromAt || '') || 0;
  const to = Date.parse(toAt || '') || 0;

  if (!from || !to || to <= from) {
    return null;
  }

  const out = { stops: 0, asks: 0 };

  try {
    const lines = fs.readFileSync(`${ AGENT_SESSIONS }/${ id }.events.jsonl`, 'utf8').split('\n');

    // Backwards, and stopped at the first one old enough: the file holds up to five hundred lines
    // and only its tail can be newer than what the document already recorded.
    for (let n = lines.length - 1; n >= 0; n--) {
      if (!lines[n].trim()) {
        continue;
      }
      let event;

      try {
        event = JSON.parse(lines[n]);
      } catch {
        continue;
      }
      const at = Date.parse(event.at || '') || 0;

      if (at <= from) {
        break;
      }
      if (at >= to) {
        continue;
      }
      if (event.event === 'Stop') {
        out.stops++;
      }
      if (event.event === 'Notification' && event.notification && event.notification !== 'idle_prompt') {
        out.asks++;
      }
    }
  } catch {
    return null;
  }

  return out.stops || out.asks ? out : null;
}

/** The same file, as the sequence a person can read. See GET /conversations/{id}/events. */
function hookEvents(id, limit) {
  const want = Math.min(Math.max(1, limit || 50), 200);

  try {
    const lines = fs.readFileSync(`${ AGENT_SESSIONS }/${ id }.events.jsonl`, 'utf8').split('\n');
    const out = [];

    for (let n = lines.length - 1; n >= 0 && out.length < want; n--) {
      if (!lines[n].trim()) {
        continue;
      }
      try {
        const event = JSON.parse(lines[n]);

        out.push({
          event:        String(event.event || ''),
          at:           String(event.at || ''),
          notification: String(event.notification || ''),
          message:      String(event.message || '').slice(0, 500),
          reason:       String(event.reason || ''),
          prompt:       String(event.prompt || '').slice(0, 300),
        });
      } catch { /* a line cut mid-write */ }
    }

    return { mount: true, events: out };
  } catch {
    return { mount: false, events: [] };
  }
}
```

### What it last said, and what it is asking

```js
/**
 * The two things a stopped conversation's card needs that the state file does not carry: what
 * claude last said, and what it is actually asking.
 *
 * Read off the mount, once, when the conversation enters a settled state - not per tick. The hook
 * writes the transcript's absolute path in the pod's own spelling, so `/workspace/...` there is
 * `/agent-workspace/...` here, which also means this never has to guess which project directory it
 * is under: a drawer conversation's is `-workspace-conversations` and a workspace's is
 * `-workspaces-<name>-dashboard`, and `ai_title_of` in sessions.sh only knows the first.
 *
 * The last 128 KiB - several turns - because a transcript runs to many megabytes, and the first
 * line of that is dropped because it was cut in the middle.
 */
function detailOf(row) {
  const local = row.transcript.startsWith(AGENT_PREFIX) ? `${ AGENT_ROOT }/${ row.transcript.slice(AGENT_PREFIX.length) }` : '';
  const detail = { said: '', question: null };

  if (!local) {
    return detail;
  }

  const entries = [];

  for (const line of tailLines(local)) {
    try {
      entries.push(JSON.parse(line));
    } catch { /* a line cut mid-write */ }
  }

  const blocksOf = (e) => {
    const content = e?.message?.content;

    if (typeof content === 'string') {
      return [{ type: 'text', text: content }];
    }

    return Array.isArray(content) ? content : [];
  };
  const answered = new Set();

  // Backwards, and the same rule `pendingQuestion` uses in chat-state.mjs: a question tool with no
  // result yet is pending. A side chain is a subagent's and is not what the conversation waits on.
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];

    if (entry.type === 'user') {
      for (const block of blocksOf(entry)) {
        if (block.type === 'tool_result') {
          answered.add(block.tool_use_id);
        }
      }
      continue;
    }
    if (entry.type !== 'assistant' || entry.isSidechain) {
      continue;
    }
    if (!detail.question) {
      for (const block of blocksOf(entry)) {
        if (block.type !== 'tool_use' || answered.has(block.id)) {
          continue;
        }
        detail.question = QUESTION_TOOLS.has(block.name) ? {
          tool:    block.name,
          header:  String(block.input?.questions?.[0]?.header || (block.name === 'ExitPlanMode' ? 'A plan to approve' : '')).slice(0, 120),
          options: (block.input?.questions?.[0]?.options || []).slice(0, 4).map((o) => String(o?.label || o).slice(0, 80)),
        } : null;
        break;
      }
    }
    if (!detail.said) {
      const text = blocksOf(entry).filter((b) => b.type === 'text').map((b) => String(b.text || '')).join('\n').trim();

      // Not a tag: `latestAgentReport` skips these too - the CLI's own furniture reads as the
      // agent's last word and it is not.
      if (text && !/^</.test(text)) {
        detail.said = text.slice(0, SAID_MAX);
      }
    }
    if (detail.said && detail.question) {
      break;
    }
  }

  return detail;
}

/** The tail of a file as lines, without the first one, which was cut in the middle. */
function tailLines(file, bytes = TAIL_BYTES) {
  let fd = 0;

  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const take = Math.min(size, bytes);
    const buffer = Buffer.alloc(take);

    fs.readSync(fd, buffer, 0, take, size - take);
    const lines = buffer.toString('utf8').split('\n');

    return take < size ? lines.slice(1) : lines;
  } catch {
    return [];
  } finally {
    if (fd) {
      try {
        fs.closeSync(fd);
      } catch { /* already closed */ }
    }
  }
}
```

### The mutex, the freshness and the answers

```js
/**
 * One tick at a time, whichever kind.
 *
 * The listing and the refresh write the same key, and `writeDoc` is a merge-patch with no
 * precondition - so a refresh that read the document before the listing's write and wrote after it
 * would silently undo a transition. Serialising them inside this process costs nothing (the disk
 * tick is a handful of stats) and removes the only race this design can actually prevent. The
 * overlap between two processes cannot be prevented, which is what the idempotent fold is for.
 */
function once(work) {
  if (!ticking) {
    ticking = work().finally(() => {
      ticking = null;
    });
  }

  return ticking;
}

function note(detail, started) {
  watch = {
    at: Date.now(), ms: Date.now() - started, ok: false, detail, mount: watch.mount, first: watch.first,
  };
  console.error(`[dev-api] conversations: ${ detail }`);
}

/**
 * The freshness a consumer needs, and the two halves of it that must not be confused.
 *
 * `stale` is about the loop: `at` is stamped by every tick whatever happened, so this is "nothing
 * is looking any more" and a client releases everything it was holding on it. `ok`/`detail` are
 * about the last listing: an exec that failed leaves the states being refreshed off the mount, so
 * they are old rather than wrong - and five consecutive exec timeouts is exactly what a busy
 * cluster with several working agents looks like, which is the moment a client must NOT release
 * every card it is holding.
 *
 * `at: ''` is "has not looked yet", the few seconds after a publish, and is not stale: the counters
 * were read back from the document and are correct.
 */
function freshness() {
  const doc = memo.doc || freshDoc();

  return {
    epoch:      doc.epoch || '',
    pod:        doc.pod || '',
    podSettled: !agentSeen.since || Date.now() - agentSeen.since > POD_SETTLE_MS,
    mount:      watch.mount,
    watchedAt:  watch.at ? new Date(watch.at).toISOString() : '',
    ageMs:      watch.at ? Date.now() - watch.at : -1,
    stale:      !!watch.at && Date.now() - watch.at > STALE_MS,
    ok:         watch.ok,
    detail:     watch.detail,
  };
}

async function conversationsAnswer(url) {
  const doc = await conversationDoc();
  const workspace = url.searchParams.get('workspace') || '';
  const states = (url.searchParams.get('state') || '').split(',').filter(Boolean);
  const conversations = Object.values(doc.items || {})
    .filter((c) => !workspace || c.workspace === workspace)
    .filter((c) => !states.length || states.includes(c.state))
    .sort((a, b) => String(b.changedAt).localeCompare(String(a.changedAt)));

  return { conversations, ...freshness() };
}
```

### Starting it

In the `listen` callback (`server.mjs:3850`), after the `tools` block:

```js
  // The conversations in the agent pod: what finished, and what is asking, while no page was open.
  //
  // Thirty seconds for the listing, which is the one exec; five for the refresh, which is a stat
  // per conversation on a mount this pod already has. Five is below the browser's own fifteen
  // (workspace-status.ts, AGENTS_EVERY_MS), so nothing reading this is ever staler than what the
  // sidebar managed by itself. Staggered off the three loops above the way they are off each other.
  const listing = () => listingTick().catch((e) => console.error('[dev-api] conversation listing tick failed:', e.message || e));
  const disk = () => diskTick().catch((e) => console.error('[dev-api] conversation refresh tick failed:', e.message || e));

  setTimeout(listing, 5_000);
  setInterval(listing, LISTING_MS);
  setTimeout(disk, 8_000);
  setInterval(disk, DISK_MS);
```

## 8. The client

### `conversations.ts`: the exec becomes the fallback

The existing body of `conversationStates` becomes `conversationStatesByExec`, unchanged, and this goes in front of it. `devApi` is **not** imported from `reviews.ts`: that file already imports this one, and a cycle in a UMD bundle is not a build error, it is one of the two modules getting an empty object at run time.

```ts
/** The in-cluster API, addressed from here rather than through reviews.ts, which imports this file. */
const DEV_API = `${ clusterBase(STUDIO_CLUSTER) }/api/v1/namespaces/dev-system/services/http:dev-api:8080/proxy`;

export interface ConversationNow {
  id: string;
  kind: string;
  workspace: string;
  state: 'working' | 'input' | 'idle' | 'finished' | 'none' | 'gone';
  was: string;
  note: string;
  stops: number;
  asks: number;
  bornAt: string;
  changedAt: string;
  alive: boolean;
  wroteAgo: number;
  event: string;
  message: string;
  said: string;
  question: { tool: string; header: string; options: string[] } | null;
}

export interface ConversationSnapshot {
  epoch: string;
  /** The loop has stopped; everything here is history. Not the same as a failed exec. */
  stale: boolean;
  /** The last listing failed. The states are old rather than wrong - say so, do not act on it. */
  ok: boolean;
  detail: string;
  podSettled: boolean;
  conversations: Record<string, ConversationNow>;
}

/**
 * Every conversation's state, from the in-cluster watcher rather than from an exec of our own.
 *
 * This was one exec per read, issued by whichever tab happened to be open - which is both the
 * expensive half (four a minute here, four more in the rail, four more in the strip) and the half
 * that cannot answer anything at all about the hours the page was shut. dev-api watches the pod now
 * (server.mjs, reconcileConversations) and keeps a document, so this is a GET.
 *
 * null when the watcher has nothing to say, which is a real case and not an error: for the twenty
 * seconds after every publish dev-api is being replaced. Every caller falls back to the exec, and
 * the fallback is why the rail does not go blank on a release.
 */
export async function conversationSnapshot(): Promise<ConversationSnapshot | null> {
  const answer = await devFetch(`${ DEV_API }/conversations`).catch(() => null);

  if (!answer?.conversations || answer.stale) {
    return null;
  }

  return {
    epoch:         String(answer.epoch || ''),
    stale:         false,
    ok:            answer.ok !== false,
    detail:        String(answer.detail || ''),
    podSettled:    answer.podSettled !== false,
    conversations: Object.fromEntries((answer.conversations as Json[]).map((c) => [String(c.id), c as ConversationNow])),
  };
}

export async function conversationStates(): Promise<ConversationState[]> {
  const snapshot = await conversationSnapshot();

  if (snapshot) {
    return Object.values(snapshot.conversations)
      .filter((c) => c.kind === 'workspace' && c.state !== 'gone')
      .map((c) => ({
        id:           c.id,
        workspace:    c.workspace,
        alive:        !!c.alive,
        event:        c.event || '',
        notification: c.note || '',
        at:           c.changedAt || '',
        wroteAgo:     Number(c.wroteAgo ?? -1),
      }));
  }

  return conversationStatesByExec();
}

/** Look now, for a caller that has just changed something. One call, best effort. */
export function refreshConversations(): Promise<void> {
  return devFetch(`${ DEV_API }/conversations/refresh`, { method: 'POST' }).then(() => undefined).catch(() => undefined);
}
```

`startConversation`, `endConversation` and `sendToPane` each end with `void refreshConversations()`, so the document is right by the time the next poll reads it.

### `workspace-status.ts`: the drifted derivation goes

`agentStateOf` and `WORKING_WINDOW_S` are **deleted**. `refreshAgents` keeps its throttle, its shape and its callers:

```ts
async function refreshAgents(): Promise<void> {
  if (Date.now() - agentsAt < AGENTS_EVERY_MS) {
    return;
  }
  if (!agentsInFlight) {
    agentsInFlight = (async() => {
      try {
        const next: Record<string, AgentState> = {};
        /*
         * The watcher's answer, not an exec of our own, and not a derivation of our own either.
         *
         * The copy that used to live here had neither the SPEAKS_LAST margin nor the SessionStart
         * fix that `activityState` carries, so the same conversation read `idle` in this sidebar
         * and `working` in the conversation strip after an auto-compact. There is one answer now
         * and dev-api gives it; all that is left here is folding a workspace's conversations into
         * the loudest of them, which is what one dot can say.
         */
        const snapshot = await conversationSnapshot().catch(() => null);
        const states: { workspace: string; state: AgentState }[] = snapshot
          ? Object.values(snapshot.conversations).filter((c) => c.workspace && c.state !== 'gone').map((c) => ({ workspace: c.workspace, state: c.state as AgentState }))
          : (await conversationStates()).map((c) => ({ workspace: c.workspace, state: agentStateFallback(c) }));

        for (const { workspace, state } of states) {
          if (RANK[state] > RANK[next[workspace] || 'none']) {
            next[workspace] = state;
          }
        }
        agents = next;
        agentsAt = Date.now();
      } catch { /* the next poll asks again */ } finally {
        agentsInFlight = null;
      }
    })();
  }
  await agentsInFlight;
}
```

`agentStateFallback` is `activityState` from `agent.ts`, exported and reused — not copied. That is the whole of the deduplication: one authority in `server.mjs`, one browser copy on the fallback path, and that copy is the text the server's was ported from.

The three component callers change identically — `pages/Conversations.vue:245`, `components/WorkspaceRail.vue:1441` and `components/WorkspaceConversations.vue:207` all do `next[c.id] = agentStateOf(c)` over `conversationStates()`, and all become `next[c.id] = c.state` over `conversationSnapshot()`, with the exec as the fallback. `reviews.ts:526` and `WorkspaceRail.vue:1491` want only `alive` for one id and read it off the snapshot. `agent.ts`'s `sessionStates` gains the same snapshot-first path, which takes the drawer's tab strip from 4 execs a minute to zero.

### `focus.ts`: the handover

```ts
/** Long enough to cover a weekend: a card put aside on Friday is still waiting on Monday. */
const AWAIT_HOURS = 72;

/** The states that mean it has stopped and the work is yours again. `gone` counts: it is news. */
const SETTLED_STATES = new Set(['input', 'idle', 'finished', 'gone']);

/**
 * How long a card stays aside before the snapshot has to justify it.
 *
 * Between pressing the button and the agent actually picking the prompt up there are seconds -
 * sometimes a minute, if the workspace pod is still coming up - in which the conversation is still
 * exactly as it was. Without this the card comes straight back on top of somebody who has just
 * dealt with it. `POST /conversations/refresh` shortens the window; this closes it. The signal the
 * window is waiting for is the state going to `working`, which the disk tick sees within five
 * seconds of the prompt landing.
 */
const HANDOVER_GRACE_MS = 45_000;

/**
 * Whether this card is waiting on an agent rather than on a person.
 *
 * The deck's premise is that every card is something only you can move, and the moment you press
 * "Fix it" the card in front of you stops being one: nothing about it can move until the agent
 * stops. So pressing it records the conversation and its counters, and the card is held back until
 * one of those counters moves - which is exactly "the agent finished or has a question", because
 * entering idle/finished is the only thing that moves `stops` and entering input is the only thing
 * that moves `asks`.
 *
 * The counters and not a revision. A revision moves when the agent *starts*, which is the opposite
 * of what this predicate wants: a card hidden until "something changed" would come back five
 * seconds after the agent picked the work up. `stops` and `asks` move on the way out of a turn and
 * never on the way in, which is the whole reason they are what is stored.
 *
 * Six ways back out, and every one of them errs towards showing the card:
 *
 *   - either counter moved;
 *   - the conversation has settled whatever the counters say, because a prompt that was queued and
 *     never started never moves one, and a card held on that would be held for ever;
 *   - the loop has stopped (`stale`), because a watcher that has quietly died must not be able to
 *     hide work for a week. Note: NOT on a failed exec - that is a busy cluster, which is when the
 *     cards should stay hidden;
 *   - the epoch is not the one the counters came from, so a document somebody deleted releases
 *     every card instead of stranding them;
 *   - `bornAt` differs, because `sessions.sh new` reuses the lowest free ordinal and the id you
 *     handed work to may now be somebody else's conversation;
 *   - the snapshot has never heard of the conversation at all.
 *
 * What it cannot tell is which way the news went. Two transitions inside one tick are one change,
 * and a conversation that finished and was asked again looks like one that was only asked unless
 * the counters happen to disagree. It is paid where it is cheapest: the card comes back either way,
 * and what it is about is read off the conversation when the card is drawn.
 */
export function awaitingAgent(key: string, state: FocusState, agents: ConversationSnapshot | null): boolean {
  const held = state.awaiting?.[key];

  if (!held) {
    return false;
  }
  if (!agents || agents.stale || (held.epoch && agents.epoch && held.epoch !== agents.epoch)) {
    return false;
  }

  const now = agents.conversations[held.conversation];

  if (!now || SETTLED_STATES.has(now.state)) {
    return false;
  }
  if (held.bornAt && now.bornAt && held.bornAt !== now.bornAt) {
    return false;
  }
  if (now.stops !== held.stops || now.asks !== held.asks) {
    return false;
  }

  // Inside the grace window nothing has to be true yet; after it, only a conversation that is
  // actually working earns the card's absence.
  return Date.now() - Date.parse(held.at) < HANDOVER_GRACE_MS || now.state === 'working';
}

/**
 * What happened to a card's agent while nobody was looking, from the counters alone.
 *
 * The whole of what a snapshot can say about the past, and worth saying on the card that comes
 * back: "it stopped twice and asked you something" is a different thing to walk into than "it
 * stopped". How many, never what - for that there is /conversations/{id}/events.
 */
export function agentNews(key: string, state: FocusState, agents: ConversationSnapshot | null): { stops: number; asks: number } | null {
  const held = state.awaiting?.[key];
  const now = held && agents?.conversations?.[held.conversation];

  if (!held || !now) {
    return null;
  }

  return { stops: Math.max(0, now.stops - held.stops), asks: Math.max(0, now.asks - held.asks) };
}

/**
 * The rule a released card re-enters the deck under.
 *
 * Nothing else in the queue can say this, because nothing else knows the card was put aside: the
 * queue is built from GitHub and from the workspaces' own stages, and "you asked to be told when
 * this stopped" is a fact about one person's prefs. Two rules rather than one, because the two
 * endings want different things of you - a question is answered here, a stop is read - and because
 * a stop that is a dead pane is a different sentence again.
 */
function released(item: PriorityItem, state: FocusState, agents: ConversationSnapshot | null): PriorityItem {
  const held = state.awaiting?.[item.key];
  const now = held && agents?.conversations?.[held.conversation];

  if (!held || !now || !SETTLED_STATES.has(now.state)) {
    return item;
  }

  const asking = now.state === 'input';

  return {
    ...item,
    since: now.changedAt || item.since,
    rule:  asking ? 'agent-question' : 'agent-stopped',
    needs: asking ? 'Answer the agent' : 'Read what the agent did and say what happens next',
    why:   asking
      ? (now.message || 'the agent asked something and stopped until it hears back')
      : (now.state === 'finished' ? 'the agent stopped and its pane has gone' : 'the agent you set working here finished while you were away'),
    score: weightOf(asking ? 'agent-question' : 'agent-stopped'),
  };
}
```

`focusDeck` takes the snapshot and gains two steps:

```ts
export function focusDeck(items: PriorityItem[], config: FocusConfig, state: FocusState, agents: ConversationSnapshot | null = null): FocusTask[] {
  const now = Date.now();

  return items
    .filter((item) => !state.done[item.key])
    .filter((item) => {
      const until = state.snoozed[item.key];

      return !until || Date.parse(until) <= now;
    })
    // Set an agent working and the card goes; it comes back when the agent stops. See awaitingAgent.
    .filter((item) => !awaitingAgent(item.key, state, agents))
    .map((item) => released(item, state, agents))
    .map((item) => { /* …the existing map, unchanged… */ })
    /*
     * Re-sorted, because `released` changes what an item is worth.
     *
     * A card somebody put aside until an agent finished is the one thing in this deck they
     * explicitly asked to be told about, and the rule that put it there knows nothing about that: a
     * finished fix falls through to `stalled` at 45 and lands tenth. The rest of the order is
     * `priorityQueue`'s and is untouched - this is a stable sort over scores it already set.
     */
    .sort((a, b) => b.score - a.score);
}
```

`readFocusState`'s fallback (`focus.ts:268`) gains `awaiting: {}`, and `sweepState` gains `awaiting: Object.fromEntries(Object.entries(state.awaiting || {}).filter(([, held]) => keep(held.at, AWAIT_HOURS)))`.

### `priority.ts`: one rule

```ts
  'agent-stopped': {
    label: 'An agent you were waiting on has stopped',
    about: 'You put this card aside until it finished and it has, so it is yours again - and it is the one thing in this deck you explicitly asked to be told about.',
    score: 95,
  },
```

95, below `agent-question` at 100 and above `review-findings` at 90: a question is blocked on you *and* the agent is sitting idle waiting, a finished run is blocked on you alone, and both outrank a review nobody has promised to look at. `priorityQueue` is **not** changed — `fromWorkspaces` already turns a live `input` into `agent-question`, and `status.agent` now comes from the watcher.

### `cards/agent-stopped.js`

```js
module.exports = {

    id:      'agent-stopped',
    chip:    'Agent stopped',
    label:   'An agent you were waiting on has stopped',
    kind:    'agent',
    lede:    'waited',
    rules:   ['agent-stopped'],
    summary: '{why}',
    // Its last report, which is what a skill ends with, and whatever it left in the workspace's
    // artifacts. Both are the answer to "what did it do" - the question this card exists to ask.
    // Served from the watcher's own read when it has one; see turnFromSnapshot.
    wants:   ['conversation', 'media'],
    actions: [
      { label: 'Open the conversation', verb: 'open' },
      { label: 'What did it do?', verb: 'ask', prompt: 'The agent in {workspace} finished and stopped. Read the last few turns of its conversation and tell me, in five lines, what it did, what it changed, and what it thinks is left.' },
      { label: 'Carry on', verb: 'ask', prompt: 'You finished the last thing in {workspace}. Pick up from there: say what you would do next and start it.' },
      { verb: 'snooze', hours: 4 },
      { verb: 'done' },
    ],
};
```

Then `node scripts/gen-cards.mjs`.

### `focus-artifacts.ts`: the free `conversation`

```ts
      if (want.has('conversation')) {
        /*
         * The watcher's own read first.
         *
         * `agentTurnOf` is up to five execs - a conversation listing, three pane reads and a `node
         * -e` over a transcript - and the deck prefetches the two cards either side of the one on
         * screen, so one deck move was up to fifteen. When a conversation has stopped, dev-api has
         * already read its last word and its pending question off the mount, for nothing, so this
         * is the same answer for no execs at all.
         *
         * What is lost is `status` and `tail`, both of which come from the pane's own text.
         * `status` is the spinner's verb and is '' for a conversation that has stopped - which
         * every one of these is - so nothing is lost there. `tail` is the pane's last six lines,
         * against `said`, the last thing claude wrote in the transcript: for a crash those differ,
         * which is what the `finished` wording is for.
         */
        out.agent = turnFromSnapshot(extra?.agents || null, subject.workspace) ||
          await agentTurnOf(subject.workspace).catch(() => null);
      }
```

```ts
/** The stopped conversation in this workspace as the `conversation` artifact, or null. */
export function turnFromSnapshot(agents: ConversationSnapshot | null, workspace: string): AgentTurn | null {
  const found = Object.values(agents?.conversations || {})
    .filter((c) => c.workspace === workspace && SETTLED_STATES.has(c.state) && c.state !== 'gone')
    .sort((a, b) => String(b.changedAt).localeCompare(String(a.changedAt)))[0];

  if (!found || (!found.said && !found.question)) {
    return null;
  }

  return {
    conversation: found.id,
    question:     found.question?.header || found.message || '',
    options:      (found.question?.options || []).map((label, i) => ({ key: String(i), label, selected: false })),
    wants:        found.question ? (found.question.tool === 'ExitPlanMode' ? 'plan' : 'choice') : (found.state === 'finished' ? '' : 'text'),
    said:         found.said,
    status:       '',
    tail:         '',
    title:        '',
    reachable:    true,
  };
}
```

### `pages/Focus.vue`

A ref, read with the other four local reads at line 771 — this is the one read on this page that is both local and cheap, and it is what puts an agent's question on screen before GitHub's measured 7.7 seconds has elapsed:

```ts
const agents = ref<ConversationSnapshot | null>(null);
```

```ts
    const [cfg, st, who, workspaces, seen] = await Promise.all([
      readFocusConfig(),
      readFocusState(),
      currentOwner().catch(() => ''),
      listAllWorkspaces().catch(() => []),
      // One GET, not an exec, so it rides with the rest of the load rather than behind the
      // fifteen-second throttle an exec had to have.
      conversationSnapshot().catch(() => null),
    ]);

    agents.value = seen;
```

`all` passes it through, and that is the whole of the live channel — no `reRank` and no second ranking path, because the deck is a computed over this ref:

```ts
const all = computed<FocusTask[]>(() => focusDeck(items.value, { ...config.value, cards: cards.value }, state.value, agents.value));
```

```ts
/*
 * The snapshot, re-read on a timer and on coming back to the tab.
 *
 * Ten seconds, and a GET rather than an exec - which is why this can exist at all. The deck had no
 * interval of any kind: every card on it was as of the moment the page loaded, so an agent that
 * finished while you were reading the card above it stayed finished and invisible. Assigning the
 * ref is enough; `all` is a computed over it, so the card returns without a re-rank.
 *
 * `document.hidden` is checked because a background tab moving cards is a background tab moving
 * them under somebody who will come back to it, and because there is no reason to pay for it.
 */
const SNAPSHOT_POLL_MS = 10_000;

onMounted(() => {
  const tick = async() => {
    if (document.hidden) {
      return;
    }
    const seen = await conversationSnapshot().catch(() => null);

    if (seen) {
      agents.value = seen;
    }
  };
  const timer = setInterval(tick, SNAPSHOT_POLL_MS);

  document.addEventListener('visibilitychange', tick);
  onBeforeUnmount(() => {
    clearInterval(timer);
    document.removeEventListener('visibilitychange', tick);
  });
});
```

The handover, next to `snooze` (line 1154):

```ts
/**
 * Put the card aside until the agent it has just set working has something to say.
 *
 * Every agentic verb ends the same way - an agent is now working and the card is not yours to move
 * - and the deck's own answer to that was nothing: the card stayed on top, with a primary button
 * that would have started a second conversation in the same workspace.
 *
 * What is stored is the counters, not a time. See `awaitingAgent` in focus.ts.
 */
async function handToAgent(task: FocusTask, conversation: string) {
  if (!conversation) {
    return;
  }

  const seen = agents.value?.conversations?.[conversation];

  await remember({
    ...state.value,
    awaiting: {
      ...state.value.awaiting,
      [task.key]: {
        conversation,
        epoch:  agents.value?.epoch || '',
        bornAt: seen?.bornAt || '',
        stops:  seen?.stops ?? 0,
        asks:   seen?.asks ?? 0,
        at:     new Date().toISOString(),
      },
    },
  });
  // The listing runs every thirty seconds and the pane has just been typed into, so ask it to look
  // now: without this the deck is comparing against counters the agent is about to leave behind.
  void refreshConversations().then(() => conversationSnapshot()).then((fresh) => {
    agents.value = fresh || agents.value;
  });
  say('Put aside until the agent stops.');
}
```

`askHere` already returns the conversation id, so in `act` an `ask` becomes `await handToAgent(task, await askHere(task, actionPrompt(action, task)))`, and `isAgentic(action, …)` — already in `focus.ts` — is the predicate for which verbs get it. `pickUpTheReview` and `pickUpTheIssue` return the started workspace rather than a conversation; they get the handover on the next snapshot poll instead, which is correct, because the conversation they start does not exist yet.

And the one thing the inbox design left undone — the watcher's own failure, drawn. Beside the existing `error` line:

```vue
        <!--
          A watcher that cannot exec is indistinguishable from a quiet cluster, and the `pods/exec`
          grant only reaches a cluster when somebody loads this dashboard. So it is said here rather
          than left in a log nobody reads. `ok: false` is not `stale`: the states are still being
          refreshed off the mount, so they are old rather than wrong.
        -->
        <div v-if="agents && !agents.ok" class="deck__note">
          The agent watcher could not read the pod: {{ agents.detail }}
        </div>
```

### End to end

Press "Fix it" at 14:02. `askHere` starts the conversation and returns its id; `handToAgent` stores `{ stops: 2, asks: 0, bornAt, epoch }` and posts `/conversations/refresh`; `awaitingAgent` is true inside the grace window and the card leaves the deck. Within five seconds the disk tick sees `working` and the card stays gone on that basis instead. Close the laptop. At 14:19 claude hits a permission prompt; the hook writes `Notification`; within five seconds the disk tick folds it in, `asks` → 1, the state goes `input`, `detailOf` reads the question off the transcript, and the ConfigMap is PATCHed — once. At 09:00 the next day the page loads, the snapshot arrives with the four other local reads, `awaitingAgent` sees `asks: 1 !== 0`, `released` re-rules the item to `agent-question` at 100 with `since: 14:19`, and `answer-agent` is the first card drawn — before GitHub has answered — with the agent's own question and its options on it, read from a transcript nobody exec'd for. `agentNews` says it asked once since you left. The person answers in the bar; within five seconds the state is `working` again, and the card leaves the deck the moment they press the button that hands it back.

## 9. Cost, as numbers

**At rest: 2 execs a minute. Flat in N workspaces, M conversations, tabs and people.**

One exec every 30 s (`sessions.sh states-all`). The 5-second half is `fs.readFileSync` plus `fs.statSync` on a mount this pod already has: zero execs.

Inside the agent pod, per exec: M `tmux has-session`, M `head -c 800`, M transcript stats and M subagent globs. At M = 20 that is roughly 90 syscalls and a few tens of milliseconds, ~8 KB of stdout; at M = 60, ~150 syscalls and ~25 KB. At 2/min: under 50 KB a minute off the pod and a fraction of a percent of one core. **No `title_of`**, which is the single biggest in-pod cost decision in this document: `ai_title_of` greps the whole transcript, and a loop that called it would be M full-transcript scans per tick inside the pod that is also running claude.

Inside `dev-api`, per disk tick: M `readFileSync` of ~400 B plus M + subagents `statSync`. At M = 20 that is ~60 stats every five seconds, ~700 a minute, all page-cache hits on a local hostPath.

Apiserver traffic: 2 pod lists and 14 ConfigMap reads a minute (the document is re-read at the top of every tick, deliberately — see `conversationDoc`), and **zero writes at rest**. A write happens only when a state or a counter moved, at most one per tick, so a busy cluster with four agents churning is bounded at 14 writes a minute and in practice is a handful.

### Against today

| | execs/min |
|---|---|
| **today**, every tab shut | **0** — and nothing is observed, which is the defect, not a saving |
| **today**, one Focus tab | 4 (`workspace-status.ts`, `AGENTS_EVERY_MS` 15 s) |
| **today**, one workspace-detail tab | 12 (rail 15 s + strip 15 s + statuses 15 s) |
| **today**, the Conversations page | 6 (10 s) |
| **today**, the drawer open | 5 (`AgentPanel.vue`, `STATES_POLL_MS` 12 s) |
| **today**, per open chat | +40 (`chat-conversation.ts`, `POLL_MS` 1500) |
| **today**, per deck move | up to 15 (`agentTurnOf`, up to 5, prefetched ×3) |
| **the inline-chat plan**, per open chat | +40 more, for state alone |
| **this**, every tab shut | **2** |
| **this**, one Focus tab | **2** |
| **this**, five mixed tabs and the drawer | **2** |
| **this**, per deck move | **0** while a conversation has stopped; the fallback otherwise |
| **this**, per open chat | **40**, unchanged — and the inline-chat plan's extra 40 never happens |

A realistic working session today — two tabs, one open chat, flicking through cards — is 16 + 40 execs a minute steady plus up to 15 per card turned, call it 100 a minute. The same session becomes **42**, all but two of them the chat's own transcript poll, which streams megabytes incrementally and is the right tool for a conversation somebody is looking at.

The honest line in the other direction: **a cluster nobody ever opens now pays 2,880 execs a day to discover nothing**, where today it pays zero. That is the price of the feature existing at all, and there is no cheaper shape available — a Kubernetes watch needs an object to watch, and the thing that changes here is a file on a hostPath. The fingerprint-and-skip variant (stat the sessions directory, skip the exec when nothing moved) was considered and rejected: a tmux session killed by hand moves no file, so the skip would miss exactly the `finished` transition the exec is kept for.

Browser traffic: `GET /conversations` is ~250–450 B per conversation, so ~8 KB at M = 20. A Focus tab polls it at 10 s (6/min), the rail and the strip at 15 s. All HTTP, no exec, whoever asks and however many tabs there are.

**What this does not fix:** the ~8 s first card is the GitHub search, measured in `Focus.vue`'s own comment at 364 KB in 7.7 s. What it removes from that path is the agent half — `workspaceStatuses` no longer fires an exec per load, and the conversation state the deck needs arrives as an 8 KB GET issued in parallel with everything else rather than behind a 15-second throttle on a WebSocket upgrade.

## 10. Not in scope, and what cannot work

**The 1.5 s chat poll stays.** It reads the transcript — megabytes, incrementally, with an offset per tab — and it is what draws the messages. The snapshot answers a different question. What this removes is the *state* exec the inline-chat plan would have added beside it.

**No event log, no cursor, no server-side queue.** The counters are what a client compares, and the sequence, where anybody wants it, is the hook's own `events.jsonl` read off the mount. Two consequences, stated rather than hidden: two transitions inside one tick are one change, so a conversation that finished and was asked again is indistinguishable from one that was only asked; and nothing can *count* turn boundaries or measure how long an agent was blocked from this document. The deck does not need either. Anything that does needs a different store, and it should say so rather than growing this one.

**No conversation titles in the loop, at any cadence.** `ai_title_of` greps whole transcripts. The consequence is real: a `p-<ws>-<n>` card is named by its workspace, but a drawer conversation would read "conversation 3 asked you something", which is not a card anybody can triage. If titles become necessary the answer is an mtime-keyed cache read off the mount, and it is not in this change.

**Drawer conversations (`agent-<n>`) get no Focus card.** Not because of the title — because the deck's actions cannot address them: `open` has no workspace and no url and says so (`Focus.vue`, `act`), and `ask` resolves through `panelConversation()`, which is the *most recent* drawer conversation and not the one that asked. They are in the snapshot, so the drawer's own dots work, and that is where a conversation you are already having belongs.

**No per-person filtering, and no pretending otherwise.** A question asked of a colleague's agent lands at the top of your deck if you handed that work over, and a colleague's conversations are visible to you in the snapshot. Nothing records who started a conversation, and `<id>.by` records *what* (`panel` or `api`), not *who*. Adding an owner is one field in the pod and is explicitly future work.

**Nothing in the server creates a card**, so there is no "an agent finished, tell everybody" path. A finish nobody handed over falls through to the stage ladder exactly as it does today. That is a deliberate limit: it is also the reason a publish, a rolled agent pod, a first install and a deleted ConfigMap cannot flood anybody's deck.

**The mount cannot be relied on, and is not.** Neither Deployment has a `nodeSelector` and `ensure` is create-if-missing, so one cannot be added to an existing cluster. On a multi-node cluster the state is as fresh as the 30-second listing, `mount: false` says so, and `/conversations/{id}/events` and the free `conversation` artifact are unavailable there. A `nodeSelector` on both Deployments is the right fix and it is a separate change that only reaches new installs.

**`replicas: 1` is not enforceable and is not assumed.** Two watchers exist for a few seconds of every publish whatever the replica count, and the fold is idempotent so that this is survivable rather than prevented. Scaling `dev-api` up would be survivable for the same reason — but `writeDoc` would then clobber more often, and the right fix would be a `resourceVersion` precondition on `writeDoc`, which it does not have.

## 11. The implementation plan

Two things shape every step. **This view verifies only on a published build** — the Focus deck, the rail and the drawer are a Rancher UI plugin, so nothing here is testable from a local dev server against a real agent pod. And **publishing rolls these very pods**: `ensureWorkspaceApi` PUTs the `dev-api` ConfigMap and deletes the pod when `server.mjs` differs, and a release that changes the agent Deployment rolls that too. So every verification below begins after a roll — which is convenient, because the roll is this design's hardest case and the first thing to watch in each step is what it did to the document.

**Step 0 — the guard rails.** Add `node --check` to the loop you use while editing: `node --check pkg/dev-extension/dev-api/server.mjs && node scripts/gen-dev-api.mjs`. `gen-dev-api.mjs` claims a syntax check and does not do one, and a syntax error in `server.mjs` is a CrashLoop that takes `/focus`, the review store and all three existing reconcilers with it. Do not add a second `podExec`; there is one at line 154. *Verify:* `node --check` passes and `git diff --stat` shows `dev-api.generated.ts` moving with `server.mjs`.

**Step 1 — `sessions.sh states-all`.** Edit `seed/agent/sessions.sh`, regenerate `seed.generated.ts`. *Verify*, before any of the rest exists: `kubectl -n extension-studio exec deploy/extension-studio-agent -c agent -- /bin/sh /seed/sessions.sh states-all` prints one line per conversation for the drawer **and** every project, ends with `@@end`, and takes well under a second. Then `… /seed/sessions.sh states` and `… states <project>` to confirm their output is byte-identical to before — three browser parsers read it. Then confirm no conversation died: the drawer's tabs are all still there, because `agentBootVersion` does not hash this file.

**Step 2 — the RBAC.** Add the `pods/exec` rule at `api.ts:2841`. *Verify:* load the dashboard once (that is what runs `ensureRules`), then `kubectl auth can-i create pods/exec --as=system:serviceaccount:dev-system:dev-api -n extension-studio` → `yes`. This step is independently useful and independently reversible, and until it lands everything after it fails loudly in one place.

**Step 3 — the listing tick and the document.** The constants, `conversationState`, `conversationDoc`, `agentPod`, `rowOf`, `foldOne`, `absorb`, `once`, `note`, `listingTick`, and only the listing interval started. No routes, no disk tick, no detail read. *Verify:* `kubectl -n dev-system logs deploy/dev-api | grep conversations` shows one `-> state` line per conversation on the first tick and **nothing at all on subsequent ticks**; `kubectl -n dev-system get cm dev-conversations -o jsonpath='{.data.conversations\.json}' | jq` shows every conversation with `stops: 0, asks: 0` adopted silently; `kubectl -n dev-system get cm dev-conversations -o jsonpath='{.metadata.resourceVersion}'` twice, two minutes apart on an idle cluster, is the same number. Then type into a conversation and confirm one transition is logged and `stops`/`asks` move by exactly one per turn. Then the case that matters: `kubectl -n extension-studio rollout restart deploy/extension-studio-agent` and watch for two minutes — **no conversation may transition to `finished`, no counter may move**, and the log should be silent.

**Step 4 — the disk tick and `mount`.** `diskRow`, `diskTick`, the `mount` field. *Verify:* a `Stop` is reflected in the document within ten seconds rather than forty; `jq '.items[].wroteAgo'` changes between reads while an agent is working; and the degradation, by setting `AGENT_WORKSPACE_ROOT=/nonexistent` on the pod by hand (`kubectl -n dev-system set env deploy/dev-api AGENT_WORKSPACE_ROOT=/nonexistent`) — the document must keep updating at 30 s and `mount` must go false. Unset it afterwards; remember that nothing you set by hand on this Deployment survives, because the extension never patches the body.

**Step 5 — the routes and OPENAPI.** `conversationsAnswer`, `freshness`, `hookEvents`, the four routes, the `paths` entries. *Verify*, through the proxy the browser uses:
```
curl -sk -H "Authorization: Bearer $TOKEN" \
  "$RANCHER/k8s/clusters/local/api/v1/namespaces/dev-system/services/http:dev-api:8080/proxy/conversations" | jq
```
every conversation present with `stale: false` and `ok: true`; `?state=idle,input` filters; `?workspace=pr-19212` filters; `/conversations/p-pr-19212-1/events` returns the hook's own firings newest first; `/conversations/changes` and `/conversations/../../secrets` both 404 rather than matching the id route; `POST /conversations/refresh` returns within a second or two and bumps `watchedAt`. Then `/openapi.json | jq '.paths | keys'` includes the three new paths.

**Step 6 — the gap recovery and the detail read.** `hookGap`, `detailOf`, `tailLines`, and their two call sites in `absorb`. *Verify:* delete the `dev-api` pod while an agent is mid-turn and let the turn finish during the roll; the first tick of the new pod must move `stops` by one and log it. Then confirm a settled conversation has a non-empty `said`, and one sitting on an `AskUserQuestion` has a `question` with its options — and that neither is re-read on subsequent ticks (watch the pod's CPU, or add a temporary log line and remove it).

**Step 7 — the browser's read path.** `conversations.ts` (snapshot, fallback, refresh), `workspace-status.ts` (`agentStateOf` deleted, `activityState` exported from `agent.ts` and reused), the three component callers, `reviews.ts:526`, `WorkspaceRail.vue:1491`, and `agent.ts`'s `sessionStates`. This step is all of it or none of it: three of four converted leaves a dashboard whose sidebar and conversation strip disagree about one conversation, with nothing saying why. *Verify* on a published build: every dot in the rail, the strip, the Conversations page and the drawer is what it was, and the browser's network panel shows **zero** `…/exec` WebSocket upgrades while those pages sit open. Then stop the watcher (`kubectl -n dev-system scale deploy/dev-api --replicas=0`) and confirm every dot still appears, via the exec fallback, within one poll — then scale back up.

**Step 8 — the handover's storage and ranking, with nothing writing it.** `prefs.ts` (`awaiting`, `awaited`), `focus.ts` (`AWAIT_HOURS`, `SETTLED_STATES`, `HANDOVER_GRACE_MS`, `awaitingAgent`, `agentNews`, `released`, `focusDeck`'s fourth argument and its sort), `priority.ts`'s rule, `cards/agent-stopped.js`, `gen-cards.mjs`. *Verify:* the deck is exactly as it was, because nobody has an `awaiting` entry; `/focus/cards` still lists what it listed; and a hand-written entry put into `dev-prefs-<you>` by hand (`stops` one below the live value) makes that card appear at 95 as `agent-stopped` on the next load, while one with the live value makes it disappear.

**Step 9 — the handover, written.** `Focus.vue`: the `agents` ref, the read in `load()`, `all`'s fourth argument, the 10 s poll, `handToAgent` on the agentic branch of `act`, and the `!agents.ok` line in the template. *Verify* the whole loop, in this order: press an agentic button and watch the card leave within a second; reload immediately and confirm it stays gone (the grace window); wait for the agent to work and confirm it stays gone past 45 s (the `working` state); close the tab, let the agent stop, reopen, and confirm the card is first in the deck with the right rule and the right `since`; press its button and confirm it leaves again. Then the two failure directions: `kubectl -n dev-system scale deploy/dev-api --replicas=0` and confirm every held card comes back within 150 s rather than staying hidden; and `kubectl -n dev-system delete cm dev-conversations` and confirm held cards come back on the new `epoch` instead of being stranded.

**Step 10 — the free artifact.** `turnFromSnapshot` and the `want.has('conversation')` branch, with `agents` threaded through `readArtifacts`'s `extra`. Last, because it is the only step that changes what a card *draws* rather than when it appears. *Verify:* an `agent-stopped` or `answer-agent` card on top shows the agent's last word and its options, and flicking through five cards issues no `…/exec` upgrade at all; then remove `said` from one item in the document by hand and confirm the card falls back to `agentTurnOf` and still draws.

**After the last step**, one pass over the things that are easy to leave half done: `agentStateOf` is gone from `workspace-status.ts` and nothing imports it; `conversationStatesByExec` exists and is reachable only as a fallback, with a comment saying so, because it will otherwise be deleted as dead code and the rail will go blank on every publish; `dev-api.generated.ts`, `seed.generated.ts` and `cards.generated.ts` are all regenerated and committed; and `node --check` passes.

**One thing worth adding later and not now:** `dev-conversations` and the per-conversation entries are the kind of orphan `reconcileTeardown` exists to find, and it does not know about them. A cluster whose agent pod is gone for good keeps the document for ever. It is one label selector in that sweep and it is not in this change.