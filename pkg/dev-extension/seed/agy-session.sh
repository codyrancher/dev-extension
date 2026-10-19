#!/bin/bash
# What runs in the tmux pane when the conversation is held with Antigravity: `agy`, in a loop.
#
# The sibling of claude-session.sh, and deliberately the same shape, because the pane's problems
# are the CLI's only in their spelling: a CLI that exits would take the tmux session down with
# it, so the loop restarts it and the restart has to resume the same conversation rather than
# open a new one. What differs is three lines of vocabulary -
#
#   claude --resume <uuid>        agy --conversation <uuid>
#   claude --continue             agy --continue
#   ~/.claude/projects/<dir>/     ~/.gemini/antigravity-cli/brain/<uuid>/
#
# - and one real difference: agy already knows which conversation belongs to a directory. It
# keeps `cache/last_conversations.json`, a map of workspace path to conversation id, so the id
# this pane owns is read from there rather than inferred from which transcript file appeared
# while the pane was running.
#
# bash rather than sh, like its sibling: `read` with no variable is a bashism.
export HOME=${HOME:-/app/.home}

# Ctrl-C at the prompt below leaves you in a shell rather than closing the pane. While agy is
# running it is agy that gets the signal, not this script, so this only fires where it is offered.
trap 'echo; exec /bin/bash' INT

if ! command -v agy >/dev/null 2>&1; then
  echo "[agy is not installed in this pod - see /app/.terminal-tools.log]"
  echo "[dropping to a shell]"
  exec /bin/bash
fi

# A prompt somebody queued for this conversation, used once and then gone. Read before the loop
# and deleted before agy runs, so a crash on the prompt does not ask it again on every restart.
QUEUE=${1:-}
PROMPT=""

if [ -n "$QUEUE" ] && [ -f "$QUEUE" ]; then
  PROMPT=$(cat "$QUEUE")
  rm -f "$QUEUE"
fi

# Where this pane records which conversation is its own, so a restart resumes that one and not
# whichever conversation another pane in the same directory touched last.
IDFILE=${2:-}
CONVERSATION=""

if [ -n "$IDFILE" ] && [ -f "$IDFILE" ]; then
  CONVERSATION=$(cat "$IDFILE" 2>/dev/null)
fi

# agy's own record of which conversation belongs to this directory: `{"<path>": "<uuid>"}`.
LAST="$HOME/.gemini/antigravity-cli/cache/last_conversations.json"

# The id for this working directory out of that map, or empty. node rather than jq, because
# node is the one thing every one of these pods is guaranteed to have.
read_conversation() {
  [ -f "$LAST" ] || return 0
  node -e '
    const fs = require("fs");
    try {
      const map = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      const id = map[process.argv[2]] || "";
      if (/^[0-9a-f-]{8,}$/i.test(id)) { process.stdout.write(id); }
    } catch {}
  ' "$LAST" "$(pwd)" 2>/dev/null
}

STARTS=0

while true; do
  # The id as it stands, in case a previous run made the conversation this pane now owns.
  if [ -z "$CONVERSATION" ]; then
    CONVERSATION=$(read_conversation)
    if [ -n "$CONVERSATION" ] && [ -n "$IDFILE" ]; then
      printf '%s' "$CONVERSATION" > "$IDFILE" 2>/dev/null || true
    fi
  fi

  # The opening prompt goes to the first start only, and interactively: -i runs it and stays in
  # the session, which is the whole point of a pane. Cleared after the start that carried it, so
  # a restart carries on rather than asking the same thing again.
  OPEN=()
  if [ -n "$PROMPT" ]; then
    OPEN=(--prompt-interactive "$PROMPT")
  fi

  if [ -n "$CONVERSATION" ]; then
    # By id, falling back to a fresh session: a conversation the brain no longer holds - a home
    # that was cleared, an id written by a pane that died before its first turn - must not leave
    # the pane dead on an error.
    agy --dangerously-skip-permissions --conversation "$CONVERSATION" "${OPEN[@]}" 2>/dev/null ||
      agy --dangerously-skip-permissions "${OPEN[@]}"
  else
    agy --dangerously-skip-permissions "${OPEN[@]}"
  fi

  PROMPT=""

  # Which conversation that was, now that agy has written it down. Recorded after the run as
  # well as before it, because the first run of a pane is the one that creates the id.
  if [ -z "$CONVERSATION" ]; then
    CONVERSATION=$(read_conversation)
    if [ -n "$CONVERSATION" ] && [ -n "$IDFILE" ]; then
      printf '%s' "$CONVERSATION" > "$IDFILE" 2>/dev/null || true
    fi
  fi

  # A CLI that keeps exiting immediately is broken rather than exited, and restarting it is a
  # spin. The same rule its sibling uses: count the starts that died young, and stop asking.
  STARTS=$((STARTS + 1))
  if [ "$STARTS" -ge 5 ]; then
    echo
    echo "[agy keeps exiting immediately, which usually means an error.]"
    echo "[press Enter to try again, or Ctrl-C for a shell]"
    read -r || exec /bin/bash
    STARTS=0
  else
    echo "[agy exited - restarting, Ctrl-C for a shell]"
    sleep 1
  fi
done
