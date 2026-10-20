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

# agy, installed here if it is not here yet.
#
# terminal-tools.sh installs it at boot only when TOOLS_AGY=1, and nothing sets that: it is a
# couple of hundred megabytes of a CLI most panes never run, so paying for it in every pod's
# boot to serve the occasional Antigravity conversation is the wrong trade. The right moment is
# this one - somebody has just asked for an Antigravity conversation, so install it for them.
# It lands in the pane's own durable home, so this happens once per pod and not once per pane.
#
# The lock is for two panes opened together: the second waits for the first's binary rather
# than running a second installer over the top of it. `mkdir` is the test and the claim in one
# step, which is what makes it a lock; the stale check is for an installer whose pane was closed
# mid-download.
AGY_BIN="$HOME/.local/bin/agy"
LOCK="$HOME/.agy-install.lock"

if ! command -v agy >/dev/null 2>&1 && [ ! -x "$AGY_BIN" ]; then
  if [ -d "$LOCK" ] && [ -n "$(find "$LOCK" -maxdepth 0 -mmin +10 2>/dev/null)" ]; then
    rmdir "$LOCK" 2>/dev/null || true
  fi

  if mkdir "$LOCK" 2>/dev/null; then
    echo "[installing the antigravity cli - a minute, once for this pod]"
    # `--dir` is the only option this installer has besides `--help`. Given anything else it
    # prints its usage and exits 0, which is how agy came to be "installed" in pods that did not
    # have it: a successful-looking log line and no binary.
    mkdir -p "$HOME/.local/bin"
    curl -fsSL https://antigravity.google/cli/install.sh | bash -s -- --dir "$HOME/.local/bin"
    rmdir "$LOCK" 2>/dev/null || true
  else
    echo "[another pane is installing the antigravity cli - waiting for it]"
    for _ in $(seq 1 120); do
      [ -x "$AGY_BIN" ] && break
      sleep 5
    done
  fi
  # The installer writes into a directory this shell already had on its PATH, so the shell's
  # cache of "there is no agy" is what would be consulted next.
  hash -r 2>/dev/null || true
fi

# Installed somewhere PATH does not look: the installer is told --skip-path, because a pane's
# PATH is set by the pod rather than by a shell profile.
if ! command -v agy >/dev/null 2>&1 && [ -x "$AGY_BIN" ]; then
  export PATH="$HOME/.local/bin:$PATH"
fi

if ! command -v agy >/dev/null 2>&1; then
  echo "[agy could not be installed - the installer's output is above, and $(dirname "$HOME")/.terminal-tools.log]"
  echo "[dropping to a shell]"
  exec /bin/bash
fi

# This directory, trusted, before agy is asked to work in it.
#
# agy stops on "Do you trust the contents of this project?" in a directory it has not seen
# before, and a pane holding a modal dialog is a pane that looks hung: the chat sees a CLI that
# is running and says nothing, because nothing has been written to a transcript that does not
# exist yet. claude has the same first-run question and claude-defaults.mjs answers it in
# advance (hasTrustDialogAccepted); this is the same answer for the same reason.
#
# The file is agy's own `settings.json` and `trustedWorkspaces` is a list of paths. Merged
# rather than written: somebody may have trusted other directories, and a pane is not the place
# to forget them. node, because node is the one thing every one of these pods is guaranteed to
# have, and a half-written settings file is worse than an unanswered dialog - so it is written
# beside and renamed over.
trust_here() {
  node -e '
    const fs = require("fs"), path = require("path");
    const file = process.argv[1], here = process.argv[2];
    let settings = {};
    try { settings = JSON.parse(fs.readFileSync(file, "utf8")) || {}; } catch {}
    const trusted = Array.isArray(settings.trustedWorkspaces) ? settings.trustedWorkspaces : [];
    if (trusted.includes(here)) { process.exit(0); }
    settings.trustedWorkspaces = [...trusted, here];
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(`${ file }.tmp`, `${ JSON.stringify(settings, null, 2) }\n`);
      fs.renameSync(`${ file }.tmp`, file);
    } catch {}
  ' "$HOME/.gemini/antigravity-cli/settings.json" "$(pwd)" 2>/dev/null || true
}

trust_here

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

# Every conversation in agy's brain, one id per line, sorted - the set this pane diffs against
# to find the one agy makes for it. The brain is a directory per conversation, so this is a
# listing and nothing more.
brain_ids() {
  ls -1 "$HOME/.gemini/antigravity-cli/brain" 2>/dev/null | sort
}

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

# Whether another pane already owns a conversation.
#
# agy's map is keyed by WORKING DIRECTORY, and every conversation in this pod shares one -
# /workspace/conversations, so that any pane's resume picker can see all of them. So the map's
# entry for this directory is whichever conversation was touched last by ANY pane, not this
# pane's. Adopting it is how a brand-new conversation came up as somebody else's: agy was handed
# `--conversation <that id>` and said so - "it was already open in another CLI instance on this
# machine ... use /fork" - with the previous conversation's turns above the prompt.
#
# Each pane records its own id beside the sessions (`<session>.id`, written by shell.sh's
# MC_CONVERSATION), so those files are the register of what is spoken for. An id in the map that
# is in one of them belongs to another pane, and this one starts fresh instead.
claimed_elsewhere() {
  [ -n "$1" ] || return 1
  [ -n "$IDFILE" ] || return 1

  for f in "$(dirname "$IDFILE")"/*.id; do
    [ -f "$f" ] || continue
    [ "$f" = "$IDFILE" ] && continue
    [ "$(cat "$f" 2>/dev/null)" = "$1" ] && return 0
  done

  return 1
}

# The conversation THIS pane made: the one that appeared in the brain since it started.
#
# Not the map's entry for this directory, which was the first attempt and was wrong twice over.
# The map says which conversation agy touched last in a directory every pane shares, so a new
# pane read somebody else's and resumed it - and once that somebody's tab was closed, taking its
# id file with it, the entry was unclaimed as well as stale, so the ownership check below let it
# through and a brand-new conversation opened on a dead one's turns.
#
# A set difference cannot be wrong that way: whatever is in the brain now and was not there when
# this pane started is this pane's, by construction. Exactly one, or nothing - two conversations
# appearing at once means another pane is starting beside this one, and guessing between them is
# how this went wrong in the first place. claude-session.sh finds its transcript the same way.
own_conversation() {
  [ -f "$BRAIN_BEFORE" ] || return 0

  fresh=$(comm -13 "$BRAIN_BEFORE" <(brain_ids) 2>/dev/null)

  [ "$(printf '%s' "$fresh" | grep -c .)" = "1" ] || return 0
  claimed_elsewhere "$fresh" && return 0

  printf '%s' "$fresh"
}

# Where the pre-run listing of the brain is kept. One file per pane, in the pane's own home, so
# two panes starting together do not read each other's snapshot.
BRAIN_BEFORE="$HOME/.agy-brain-$$.before"
trap 'rm -f "$BRAIN_BEFORE"' EXIT

STARTS=0

while true; do
  # Nothing is adopted from the map before agy runs.
  #
  # The map is keyed by working directory and every conversation here shares one, so its entry
  # before this pane has run is somebody else's conversation, or a dead one whose pane was ended.
  # This pane's own id comes from its IDFILE, written by the watcher below the moment agy makes a
  # conversation - which is the only moment the map says anything about THIS pane.

  # The opening prompt goes to the first start only, and interactively: -i runs it and stays in
  # the session, which is the whole point of a pane. Cleared after the start that carried it, so
  # a restart carries on rather than asking the same thing again.
  OPEN=()
  if [ -n "$PROMPT" ]; then
    OPEN=(--prompt-interactive "$PROMPT")
  fi

  # The brain as it is before agy runs, which is what makes the id it creates identifiable.
  brain_ids > "$BRAIN_BEFORE"

  # Record which conversation this is as soon as agy has made one, rather than when agy exits -
  # which, for a pane somebody is sitting in, is never. The chat finds a transcript by this id,
  # so without it a conversation that was answering perfectly well in the terminal read as
  # "Waiting for the conversation to begin" in the view, with the message sent to it marked as
  # having no record. claude-session.sh carries the same watcher for the same reason.
  #
  # `own_conversation` rather than the raw map: until agy writes this pane's conversation the map
  # still names the one next door, and recording that would be the adoption bug again, dressed as
  # a watcher. It returns nothing until the id is one no other pane has claimed.
  if [ -n "$IDFILE" ] && [ ! -s "$IDFILE" ]; then
    (
      for _ in $(seq 1 150); do
        sleep 2
        mine=$(own_conversation)
        if [ -n "$mine" ]; then
          printf '%s' "$mine" > "$IDFILE" 2>/dev/null || true
          break
        fi
      done
    ) &
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
  # Which conversation that was, now that agy has written it down - and only if no other pane
  # has it, because a pane that was handed no id and created none (agy refused, the login
  # expired) must not then claim the conversation next door.
  if [ -z "$CONVERSATION" ]; then
    CONVERSATION=$(own_conversation)
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
