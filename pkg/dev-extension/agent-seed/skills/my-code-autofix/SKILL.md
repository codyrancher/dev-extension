---
name: my-code-autofix
description: Kick off the unattended auto-fix loop on a Claude Harness project. Waits for init.sh to finish, then runs `claude --dangerously-skip-permissions` against /workspace/dashboard pointed at the my-issue-fix skill (issue projects) or the my-pr-review skill (PR projects). Runs from either the global session (fires into a project container over docker) or from inside a project session (fires locally, no docker needed). Use whenever a project's `init.sh` ran but `.auto-fix-fired` / `.auto-review-fired` was never created, or whenever you need to re-fire after fixing an upstream failure (yarn install died, sidecars weren't ready, etc.).
---

This skill is the **launcher only**. It gets an unattended `claude -p` running in the right container with the right prompt, then gets out of the way. What that agent actually does is defined elsewhere:

- **`issue-<N>` project** -> the `my-issue-fix` skill, which orchestrates nine phases through their own skills: `my-issue-assess`, `my-issue-reproduce`, `my-root-cause-analysis`, the fix, `my-fix-verify`, `my-fix-demonstrate`, `my-commit-create`, `my-pr-create` (which calls `my-pr-fill-template`), `my-pr-checklist`.
- **`pr-<N>` project** -> the `my-pr-review` skill (pending inline comments, never submitted).

Change those skills, not this file, when you want the agent to behave differently. The prompt below is deliberately short: it names the entry-point skill and the non-negotiables, and nothing else. Depth in a shell-quoted string is depth that cannot be edited safely.

Environment quirks that used to be documented here (root-owned `node_modules`, env vars missing in non-interactive shells, git dubious ownership) now live in the **project-environment rule**. In-project that rule is loaded into context automatically. From the global session it is not, so read it directly when something behaves unexpectedly: `/data/projects/<project>/.claude/rules/project-environment.md`.

The harness-api rebuild on 2026-05-24 dropped the auto-fix wiring that used to live in `init.sh.hbs`, so this has to be fired manually every time a project is created.

## Step 0 - Detect where you're running

Run this first. Everything below branches on the answer:

```bash
echo "PROJECT_NAME=[$PROJECT_NAME]"; command -v docker >/dev/null && echo "docker=yes" || echo "docker=no"
```

- `PROJECT_NAME` set, `docker=no` -> **in-project mode**. You are already inside the target container. Skip every `docker exec`.
- `PROJECT_NAME` empty, `docker=yes` -> **global mode**. Fire into the container over docker.

Do not assume you are in global mode because this skill used to be global-only. Check.

## Inputs

**Project name.**

- In-project mode: it's `$PROJECT_NAME`. Never ask the user, and never ask them to run it from somewhere else.
- Global mode: the user supplies it (e.g. `auth-pass-change-signin-issue-15461`, `chart-buttons-pr-17120`).

**Issue or PR number** is derived from the project name, never asked for: the trailing `issue-<N>` or `pr-<N>` token, matched as `(^|-)(issue|pr)-([0-9]+)$`. The leading dash is optional, so `pr-18567` is a valid project name resolving to PR #18567. If neither matches, abort and ask the user what the project is for.

## Step 1 - Preflight

**In-project mode:** nothing to check. The container is up by definition, you're in it.

**Global mode:** confirm the container is running.

```bash
docker ps --format '{{.Names}}' | grep "^claude-harness-<project>-1$"
```

If missing, start it with `POST $CLAUDE_HARNESS_API/projects/<project>/start` and wait. If even that fails, surface the error and stop. No point firing an agent into a dead container.

## Step 2 - Check the marker

So a re-run is intentional, not a duplicate fire.

```bash
# in-project
ls /workspace/.auto-fix-fired /workspace/.auto-review-fired 2>/dev/null
# global
docker exec -u 1000:1000 claude-harness-<project>-1 ls /workspace/.auto-fix-fired /workspace/.auto-review-fired 2>/dev/null
```

If present, ask the user whether to force-rerun (delete the marker first) or skip.

## Step 3 - Fire the wrapper

The wrapper waits for `/workspace/.init-done` (up to 60 min), touches the marker, then runs `claude --dangerously-skip-permissions -p "<prompt>"` from `/workspace/dashboard`. Output streams to `/workspace/.auto-run.out`, and the per-project tailer streams the agent's transcript to `/workspace/auto.logs`.

Substitute two values into the body below:

- `<MARKER>` - `.auto-fix-fired` (issue) or `.auto-review-fired` (PR)
- `<PROMPT>` - one of the two below, verbatim. Keep them short: the depth belongs in the skill, not in a shell-quoted string.
  - **fix**: `Use the my-issue-fix skill to fix this project's issue end to end. Follow all nine phases in order and honour its gates: reproduce on video before changing anything, weigh at least two candidate root causes before editing, prove the fix with a test that fails without it, record the fix working, then commit, open the draft PR and work its checklist. You are running unattended: nobody will answer a question, so make the best-supported call, state your assumptions, and finish. If a phase cannot complete, stop there and write up what you found rather than guessing past it. Leave the PR as a draft.`
  - **review**: `Use the my-pr-review skill to review this project's PR. Leave pending inline comments only. Do not submit the review, leave it in PENDING for the user.`

### Wrapper body (identical in both modes)

```bash
for i in $(seq 1 720); do
  if [ -f /workspace/.init-done ]; then break; fi
  sleep 5
done
if [ ! -f /workspace/.init-done ]; then
  echo "FATAL: init never completed" > /workspace/.auto-run.out
  exit 1
fi
if [ -f /workspace/<MARKER> ]; then
  echo "already fired previously, skipping" >> /workspace/.auto-run.out
  exit 0
fi
touch /workspace/<MARKER>
set -a; . /workspace/.env; set +a
cd /workspace/dashboard
claude --dangerously-skip-permissions -p "<PROMPT>" >> /workspace/.auto-run.out 2>&1
```

The `. /workspace/.env` line matters. The wrapper runs non-interactively, which skips `~/.bashrc`, so without it the agent inherits a shell with no `RANCHER_HOST_NAME`, no `HARNESS_API`, and no admin credentials. See the project-environment rule.

### In-project launch

You are already uid 1000 in the right container, so there is no `docker exec` and no `-u`. Detach with `setsid` so the run survives this tool call, this session, and the browser disconnecting:

```bash
setsid nohup bash -c '
  <WRAPPER BODY HERE>
' >/dev/null 2>&1 </dev/null &
echo "fired"
```

The `setsid` + `</dev/null` + `&` combination is what makes it detached. Without it the run dies when the Bash tool call returns. Nested `claude` (a `claude -p` spawned from inside a Claude session) works fine, it is a separate process with its own auth. Do not talk yourself out of firing because "I am already Claude."

### Global launch

`docker exec -d` provides the detachment, so no `setsid` is needed:

```bash
docker exec -u 1000:1000 -d claude-harness-<project>-1 bash -c '
  <WRAPPER BODY HERE>
'
```

`-u 1000:1000` is required. As root the agent writes root-owned files into `/workspace/dashboard` and git refuses the tree as dubious ownership.

## Step 4 - Report

One line each:

- "Auto-fix queued for `<project>` (issue #<N>), fires once init.sh finishes (~5 min for a fresh project)." If `.init-done` already exists, say it started immediately instead.
- Watch live:
  - in-project: `tail -f /workspace/auto.logs`
  - global: `tail -f /data/projects/<project>/auto.logs`

For PR projects, add: "Review sits in PENDING when complete, user submits or discards from Files Changed."

Then verify the fire actually took rather than reporting blind: `ls -la /workspace/.auto-fix-fired` and check a `claude` process exists (`ps aux | grep -c "[c]laude"`).

## Re-firing on an existing project

When the user asks you to re-run on a project that already has `.auto-fix-fired` (the first attempt died because yarn install failed, or you just patched a template bug and want to retry):

1. Delete the marker: `rm -f /workspace/.auto-fix-fired /workspace/.auto-run.out` (prefix with `docker exec -u 1000:1000 claude-harness-<project>-1` in global mode).
2. If the failure was in init.sh itself (yarn install, dashboard clone), check whether init needs to re-run. `/workspace/.init-done` may be missing. If so, fix the underlying issue manually, then `touch /workspace/.init-done` so the wrapper proceeds.
3. Fire as above.

## What this skill does NOT do

- **Doesn't start sidecars.** Auto-fix often runs before sidecars are needed, and the fired agent brings them up itself via `wait-for-sidecars` when it reaches the repro. If the user explicitly wants them up first, `POST $CLAUDE_HARNESS_API/sidecars/start/<project>` separately, which is only reachable from the global session.
- **Doesn't create the project.** See the global CLAUDE.md workflows for that. This skill assumes the container exists.
- **Doesn't decide how the work is done.** That is `my-issue-fix` (and the phase skills it orchestrates) and `my-pr-review`. Change those, not this file, when you want the agent to behave differently. In particular, do not move phase detail into the prompt string here.

## Why the markers exist

`.auto-fix-fired` / `.auto-review-fired` make the wrapper idempotent under container restart. Without them, every host reboot or `docker restart` would re-fire the agent and produce duplicate commits or duplicate review passes. Don't delete them unless you actually want a re-run.
