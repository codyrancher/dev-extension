#!/bin/bash
# The accessibility toolkit, browser-sidecar side. Everything here has to run
# in this container because AT-SPI, X and PulseAudio are all session-local: the
# project container shares this container's *network* namespace, not its
# desktop.
#
# The project container calls this through the harness API (`a11y <cmd>` in
# /workspace/bin). Called directly here it works the same way.
set -o pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$DIR/a11y-env.sh"

usage() {
  cat <<'USAGE'
a11y <command> [args]

  status                 what is installed, what is running, what the bus says
  enable                 announce an AT on the bus so Chromium exports its tree
  tree [ax-dump args]    dump Chromium's AT-SPI tree (--relations, --role, --name, --json)
  say "text" [file]      render text with espeak-ng to a wav under /artifacts/a11y
  record start [file]    start capturing what the desktop is playing
  record stop            stop capturing, print the file
  orca start|stop        run the Orca screen reader in the session
  orca mark              mark the speech log before an interaction
  orca speech            print what Orca has said since the mark, as text
  speech "text"          speak through speech-dispatcher (what Orca would use)
  key KEY [KEY ...]      send real key presses to the browser (Tab, Return, ...)
  type "text"            type text into the focused control
USAGE
}

have() { command -v "$1" >/dev/null 2>&1; }

# Orca's own process. Match the process NAME, not a command line: `pgrep -f
# orca` matches the `a11y.sh orca start` that is asking the question, and Orca
# renames itself to a bare "orca" so a path pattern misses it entirely.
orca_pid() {
  pgrep -u "$A11Y_UID" -x orca 2>/dev/null | head -1
}

cmd_status() {
  echo "tier:      ${A11Y_TIER:-off}"
  echo "session:   pid $(a11y_session_pid) display $(a11y_load_session; echo "$DISPLAY")"
  for tool in gdbus python3 espeak-ng spd-say parec sox orca; do
    printf '%-10s %s\n' "$tool:" "$(command -v "$tool" 2>/dev/null || echo '(not installed)')"
  done
  python3 -c 'import pyatspi' 2>/dev/null && echo "pyatspi:   yes" || echo "pyatspi:   (not installed)"
  echo -n "bus:       "
  a11y_as_user gdbus call --session --dest org.a11y.Bus --object-path /org/a11y/bus \
    --method org.freedesktop.DBus.Properties.GetAll org.a11y.Status 2>&1 | head -1
  echo -n "chromium:  "
  tr '\0' '\n' < "/proc/$(a11y_session_pid)/cmdline" 2>/dev/null \
    | grep -q -- '--force-renderer-accessibility' \
    && echo "launched with --force-renderer-accessibility" \
    || echo "NOT launched with --force-renderer-accessibility (set the a11y sidecar setting)"
  pgrep -u "$A11Y_UID" -f 'at-spi2-registryd' >/dev/null 2>&1 \
    && echo "registry:  running" || echo "registry:  stopped (run: a11y enable)"
  echo "on the bus: $(a11y_apps | tr '\n' ' ')"
  [ -n "$(orca_pid)" ] && echo "orca:      running (pid $(orca_pid))" || echo "orca:      stopped"
  [ -f /tmp/a11y-record.pid ] && echo "recording: $(cat /tmp/a11y-record.out 2>/dev/null)"
  true
}

cmd_tree() {
  a11y_enable_bus
  a11y_ensure_registry
  a11y_as_user python3 "$DIR/ax-dump.py" "$@"
}

# Bring the accessibility stack to the point where Chromium is actually on the
# bus, which takes three things: an AT announced on the session bus, a running
# registry, and a browser that started after both. The browser is the awkward
# one — it decides whether to export a tree when it starts — so restart it, but
# only when it is genuinely missing, since a restart closes whatever is open.
cmd_enable() {
  a11y_enable_bus
  a11y_ensure_registry || { echo "at-spi2-registryd did not start:"; tail -3 /tmp/a11y-registryd.log; exit 1; }
  if a11y_apps | grep -qi chrom; then
    echo "accessibility bus enabled; Chromium is on it"
    return 0
  fi
  echo "Chromium is not on the bus yet — restarting the desktop (this closes open tabs)"
  a11y_restart_browser
  for _ in $(seq 1 30); do
    sleep 3
    [ -n "$(a11y_browser_pid)" ] || continue
    # The restart brought a new session bus with it, so announce the AT again
    # before asking: the properties are per-bus, and the old bus is gone.
    a11y_enable_bus
    a11y_ensure_registry >/dev/null
    if a11y_apps | grep -qi chrom; then
      echo "accessibility bus enabled; Chromium is on it"
      return 0
    fi
  done
  echo "Chromium did not appear on the accessibility bus after 90s." >&2
  echo "Applications seen: $(a11y_apps | tr '\n' ' ')" >&2
  exit 1
}

cmd_say() {
  local text="$1" out="${2:-$A11Y_OUT/say-$(date +%Y%m%d-%H%M%S).wav}"
  have espeak-ng || { echo "espeak-ng is not installed: this needs the 'speech' tier" >&2; exit 3; }
  [ "${out#/}" = "$out" ] && out="$A11Y_OUT/$out"
  a11y_as_user espeak-ng -w "$out" "$text" || exit $?
  chown "$A11Y_UID:$A11Y_UID" "$out" 2>/dev/null || true
  echo "$out"
}

# Capture what the desktop is playing, so an announcement can be attached to a
# recording as evidence instead of described. parec reads the monitor of the
# default sink — the same audio Selkies streams to the browser tab.
cmd_record() {
  case "$1" in
    start)
      have parec || { echo "parec is not installed: this needs the 'speech' tier" >&2; exit 3; }
      [ -f /tmp/a11y-record.pid ] && { echo "already recording: $(cat /tmp/a11y-record.out)"; exit 0; }
      local out="${2:-$A11Y_OUT/speech-$(date +%Y%m%d-%H%M%S).wav}"
      [ "${out#/}" = "$out" ] && out="$A11Y_OUT/$out"
      a11y_load_session
      # PulseAudio suspends an idle sink, and a suspended sink's monitor
      # produces nothing at all — so a recording of a page that stays quiet for
      # ten seconds and then speaks comes out as half a second of speech with
      # no timeline. Unload the module and the monitor keeps emitting silence,
      # which is what makes the wav line up with a screen recording.
      a11y_as_user pactl unload-module module-suspend-on-idle >/dev/null 2>&1 || true
      setsid bash -c "
        . '$DIR/a11y-env.sh'
        a11y_as_user parec --format=s16le --rate=44100 --channels=2 -d @DEFAULT_MONITOR@ \
          | a11y_as_user sox -t raw -r 44100 -e signed -b 16 -c 2 - '$out'
      " >/tmp/a11y-record.log 2>&1 &
      echo $! > /tmp/a11y-record.pid
      echo "$out" > /tmp/a11y-record.out
      echo "recording to $out"
      ;;
    stop)
      [ -f /tmp/a11y-record.pid ] || { echo "not recording" >&2; exit 1; }
      # parec is the process that has to end for sox to close the file, and sox
      # needs a moment after that to drain the pipe — kill it early and the
      # last second or two of audio (usually the announcement you were after)
      # never reaches the file.
      pkill -INT -u "$A11Y_UID" -x parec 2>/dev/null
      for _ in $(seq 1 10); do
        pgrep -u "$A11Y_UID" -x sox >/dev/null 2>&1 || break
        sleep 0.5
      done
      kill "$(cat /tmp/a11y-record.pid)" 2>/dev/null
      local out; out="$(cat /tmp/a11y-record.out 2>/dev/null)"
      rm -f /tmp/a11y-record.pid /tmp/a11y-record.out
      chown "$A11Y_UID:$A11Y_UID" "$out" 2>/dev/null || true
      echo "$out"
      ;;
    *) usage; exit 2 ;;
  esac
}

# Orca's debug log carries a `SPEECH OUTPUT: '...'` line for every phrase it
# sends to the synthesiser. That turns "the screen reader says X" from an
# unverifiable wav into text you can quote, diff and paste into a PR, so this
# always starts Orca with one.
ORCA_DEBUG=/tmp/orca-debug.txt
ORCA_MARK=/tmp/orca-mark

cmd_orca() {
  have orca || { echo "orca is not installed: this needs the 'orca' tier" >&2; exit 3; }
  case "$1" in
    start)
      if [ -n "$(orca_pid)" ]; then
        echo "orca already running (pid $(orca_pid))"
        [ -s "$ORCA_DEBUG" ] || echo "no speech log: run 'orca stop' then 'orca start' to capture what it says"
        exit 0
      fi
      a11y_enable_bus
      a11y_ensure_registry
      rm -f "$ORCA_DEBUG" "$ORCA_MARK"
      # setsid: the exec'd shell goes away when the API call returns, and Orca
      # has to outlive it.
      setsid bash -c ". '$DIR/a11y-env.sh'; a11y_as_user orca --replace --debug-file=$ORCA_DEBUG" \
        >/tmp/a11y-orca.log 2>&1 &
      for _ in $(seq 1 10); do
        sleep 2
        [ -n "$(orca_pid)" ] && { echo "orca started (pid $(orca_pid)), speech log $ORCA_DEBUG"; exit 0; }
      done
      echo "orca failed to start:"; tail -5 /tmp/a11y-orca.log; exit 1
      ;;
    stop)
      pid="$(orca_pid)"
      [ -n "$pid" ] && kill "$pid" 2>/dev/null
      # Wait for it to actually go: an immediate `orca start` after this used to
      # see the old process and decline, leaving you without the speech log.
      for _ in $(seq 1 10); do
        [ -z "$(orca_pid)" ] && break
        sleep 1
      done
      [ -n "$(orca_pid)" ] && kill -9 "$(orca_pid)" 2>/dev/null
      echo "orca stopped" ;;
    # Drop a marker before the interaction you care about, so `orca speech`
    # afterwards returns that announcement rather than the whole session.
    mark)
      wc -l < "$ORCA_DEBUG" 2>/dev/null | tr -d ' ' > "$ORCA_MARK" || echo 0 > "$ORCA_MARK"
      echo "marked at line $(cat "$ORCA_MARK")" ;;
    speech)
      [ -s "$ORCA_DEBUG" ] || { echo "no speech log: is orca running?" >&2; exit 1; }
      local from=1
      [ -f "$ORCA_MARK" ] && from="$(cat "$ORCA_MARK")"
      # The style dict after the phrase is noise for evidence purposes.
      tail -n "+$from" "$ORCA_DEBUG" | grep -a 'SPEECH OUTPUT' | sed 's/{.*//' ;;
    *) usage; exit 2 ;;
  esac
}

# Drive the keyboard in the desktop session. A screen reader says nothing until
# something moves focus, and CDP-synthesised keys do not move the *platform*
# focus that AT-SPI reports — so real X key events are the only way to make
# Orca announce a control.
cmd_key() {
  have xdotool || { echo "xdotool is not installed in this image" >&2; exit 3; }
  a11y_load_session
  local win
  win="$(a11y_as_user xdotool search --onlyvisible --class chromium 2>/dev/null | head -1)"
  [ -n "$win" ] && a11y_as_user xdotool windowactivate "$win" >/dev/null 2>&1
  sleep 0.5
  for key in "$@"; do
    a11y_as_user xdotool key "$key"
    sleep 1
  done
  echo "sent: $*"
}

cmd_type() {
  have xdotool || { echo "xdotool is not installed in this image" >&2; exit 3; }
  a11y_load_session
  a11y_as_user xdotool type --delay 60 "$1"
  echo "typed"
}

cmd_speech() {
  have spd-say || { echo "speech-dispatcher is not installed: this needs the 'speech' tier" >&2; exit 3; }
  a11y_as_user spd-say -w "$1"
}

case "${1:-}" in
  status)  shift; cmd_status "$@" ;;
  enable)  cmd_enable ;;
  tree)    shift; cmd_tree "$@" ;;
  say)     shift; cmd_say "$@" ;;
  record)  shift; cmd_record "$@" ;;
  orca)    shift; cmd_orca "$@" ;;
  speech)  shift; cmd_speech "$@" ;;
  key)     shift; cmd_key "$@" ;;
  type)    shift; cmd_type "$@" ;;
  ''|-h|--help|help) usage ;;
  *) echo "unknown command: $1" >&2; usage; exit 2 ;;
esac
