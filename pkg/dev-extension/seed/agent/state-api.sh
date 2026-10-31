#!/bin/sh
# Keep the pod's state service running, without ever being the reason something else stops.
#
# ── Why this is not started from boot.sh ────────────────────────────────────────────────────
#
# Because boot.sh is the one file in this seed that cannot change for free. `agentBootVersion`
# in agent.ts hashes boot.sh, terminal-tools.sh and tmux.conf into the pod template, so editing
# any of them rolls the pod - and rolling this pod ends every conversation in it. Everything
# else in /seed is a ConfigMap mount that the kubelet updates in place, which is why a new
# script reaches a running pod without a restart.
#
# So this file arrives in a pod that is already up, and the browser starts it with one exec the
# first time it finds nothing listening. After that the browser talks HTTP and never forks
# anything here again. A pod that has never been asked simply has no service, which costs
# nothing and is exactly the state every pod is in today.
#
# ── What it guarantees ──────────────────────────────────────────────────────────────────────
#
# One supervisor per pod, one server under it, restarted if it dies, and a log that cannot grow
# without bound. If this script is wrong, the worst case is no service - and no service means
# the browser keeps using exec, which is what it did before any of this existed.
set -e

SEED=${SEED:-/seed}
RUN=${STATE_API_RUN:-/tmp/.state-api}
LOG="$RUN/log"
LOCK="$RUN/lock"
PIDFILE="$RUN/pid"
TOKENFILE="$RUN/token"
PORT=${STATE_API_PORT:-8111}
# Two hundred kilobytes of log is already more than anyone will read; past that the oldest half
# goes. A service meant to be invisible must not be able to fill a disk somebody is working on.
MAX_LOG=204800

mkdir -p "$RUN"
chmod 700 "$RUN" 2>/dev/null || true

# The token, minted here and once.
#
# Not in the seed: a token in the ConfigMap travels in the extension bundle, so every holder of
# the bundle would know it, and it would change the seed's fingerprint and have the ConfigMap
# rewritten on every page load. Generated in the pod it is a real secret with the right
# lifetime - this pod's - and the browser learns it from the output of this script, over the one
# exec that starts the service. Printed on every run, including "already running", because the
# caller needs it whether or not it was the one that started anything.
if [ ! -s "$TOKENFILE" ]; then
  (
    head -c 32 /dev/urandom 2>/dev/null | od -An -tx1 | tr -d ' \n' ||
      node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))'
  ) > "$TOKENFILE.new" 2>/dev/null
  if [ -s "$TOKENFILE.new" ]; then
    chmod 600 "$TOKENFILE.new" 2>/dev/null || true
    mv "$TOKENFILE.new" "$TOKENFILE"
  else
    rm -f "$TOKENFILE.new"
    echo 'state-api: could not mint a token'
    exit 1
  fi
fi

# `mkdir` is the lock, because it is the one filesystem operation that is atomic everywhere and
# needs no tooling. A stale lock from a supervisor that was killed is cleared below rather than
# waited on: the pid it names is the only evidence that matters.
held() {
  [ -f "$PIDFILE" ] || return 1
  pid=$(cat "$PIDFILE" 2>/dev/null) || return 1
  [ -n "$pid" ] || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  return 0
}

case "${1:-start}" in
  status)
    if held; then echo "running $(cat "$PIDFILE")"; else echo 'not running'; fi
    echo "token $(cat "$TOKENFILE" 2>/dev/null)"
    exit 0
    ;;
  stop)
    # The GROUP, not the pid.
    #
    # `setsid` makes the supervisor a process-group leader with the node server inside its
    # group, so killing the pid alone left the server holding the port with nothing supervising
    # it. The next start then got EADDRINUSE, stood down as designed, and removed the lock and
    # the pidfile - leaving a service that worked but that no supervisor would ever restart.
    # The negative pid is the group.
    if held; then
      pid=$(cat "$PIDFILE")
      kill -TERM "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
      i=0
      while [ "$i" -lt 30 ] && kill -0 "$pid" 2>/dev/null; do
        i=$((i + 1))
        sleep 0.1 2>/dev/null || sleep 1
      done
      kill -KILL "-$pid" 2>/dev/null || true
    fi
    # Anything still on the port is a server orphaned by an older version of this script.
    pkill -f "$SEED/state-api.mjs" 2>/dev/null || true
    # The token stays: a restart that kept it means every tab holding it keeps working.
    rm -rf "$LOCK" "$PIDFILE"
    exit 0
    ;;
esac

# Already supervised: say so and leave. Two tabs racing to start this is the normal case, not
# an error, and the second one has nothing to do.
if held; then
  echo "state-api already running ($(cat "$PIDFILE")) on $PORT"
  echo "token $(cat "$TOKENFILE")"
  exit 0
fi

# A lock whose supervisor is gone is not a lock - but a lock taken half a second ago by the
# other tab that noticed at the same moment is, and it has not written its pidfile yet.
#
# Waiting is the whole of the fix here. Both tabs run this within milliseconds of each other;
# the loser used to look once, see no pidfile, call the lock stale, and report that nothing came
# up - so a perfectly healthy service that the winner had just started was reported as a failure
# and that tab went back to exec for the rest of its life.
if ! mkdir "$LOCK" 2>/dev/null; then
  i=0
  while [ "$i" -lt 30 ]; do
    if held; then
      echo "state-api already running ($(cat "$PIDFILE")) on $PORT"
      echo "token $(cat "$TOKENFILE")"
      exit 0
    fi
    i=$((i + 1))
    sleep 0.1 2>/dev/null || sleep 1
  done
  # Three seconds and still nobody behind it: the holder is gone, not slow.
  rm -rf "$LOCK"
  mkdir "$LOCK" 2>/dev/null || { echo 'state-api: could not take the lock'; exit 1; }
fi

if [ ! -f "$SEED/state-api.mjs" ]; then
  rm -rf "$LOCK"
  echo "state-api: $SEED/state-api.mjs is not here"
  exit 1
fi

# `setsid` so the supervisor outlives the exec that started it. Without it the whole tree is in
# the exec's process group and dies the moment the browser's WebSocket closes - which is about
# two hundred milliseconds after it starts, and would look exactly like a service that crashes
# on startup for reasons nobody can find.
setsid /bin/sh -c '
  RUN='"$RUN"'; LOG='"$LOG"'; LOCK='"$LOCK"'; PIDFILE='"$PIDFILE"'
  SEED='"$SEED"'; PORT='"$PORT"'; MAX_LOG='"$MAX_LOG"'
  echo $$ > "$PIDFILE"
  # Take the server down with the supervisor. Without this a stopped supervisor left its node
  # child holding the port, which is the orphan `stop` above now has to sweep for.
  trap "kill \$child 2>/dev/null; rm -rf \"$LOCK\" \"$PIDFILE\"; exit 0" TERM INT

  # Backs off so a server that cannot start - a syntax error in a half-written ConfigMap, a port
  # taken by something else - does not become a fork bomb in a pod somebody is working in.
  wait=1
  while :; do
    [ -f "$SEED/state-api.mjs" ] || { echo "[supervisor] seed gone; stopping" >> "$LOG"; break; }

    if [ -f "$LOG" ]; then
      size=$(wc -c < "$LOG" 2>/dev/null || echo 0)
      if [ "$size" -gt "$MAX_LOG" ]; then
        tail -c $((MAX_LOG / 2)) "$LOG" > "$LOG.trimmed" 2>/dev/null && mv "$LOG.trimmed" "$LOG"
      fi
    fi

    started=$(date +%s)
    STATE_API_PORT="$PORT" STATE_API_SEED="$SEED" STATE_API_TOKEN_FILE="$RUN/token" \
      node "$SEED/state-api.mjs" >> "$LOG" 2>&1 &
    child=$!
    wait "$child"
    code=$?
    ran=$(( $(date +%s) - started ))

    # Exit 0 is a deliberate stand-down: the server found the port already taken, which means
    # another one is serving and this supervisor has nothing left to supervise.
    [ "$code" = "0" ] && { echo "[supervisor] server stood down; stopping" >> "$LOG"; break; }

    # A server that stayed up is a server that was working: start the backoff over, so one bad
    # night does not leave a healthy pod waiting thirty seconds for its service.
    if [ "$ran" -ge 30 ]; then wait=1; else wait=$(( wait * 2 )); fi
    [ "$wait" -gt 30 ] && wait=30
    echo "[supervisor] exited $code after ${ran}s; again in ${wait}s" >> "$LOG"
    sleep "$wait"
  done
  rm -rf "$LOCK" "$PIDFILE"
' >/dev/null 2>&1 &

# Give it long enough to have bound, so the caller is told something true. Not long enough to
# matter to the exec that is waiting on it.
i=0
while [ "$i" -lt 20 ]; do
  held && break
  i=$((i + 1))
  sleep 0.1 2>/dev/null || sleep 1
done

if held; then
  echo "state-api started ($(cat "$PIDFILE")) on $PORT"
  echo "token $(cat "$TOKENFILE")"
else
  echo 'state-api: did not come up; the browser will keep using exec'
  exit 1
fi
