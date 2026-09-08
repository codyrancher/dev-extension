#!/bin/bash
# Sourced by the other scripts in this directory. Everything here exists to
# answer one question: how does a process started by `docker exec` join the
# desktop session that Chromium is already running in?
#
# It can't inherit it — the session bus address, DISPLAY and the PulseAudio
# socket are all set up by s6 and openbox long before anyone execs in. So we
# read them back off the running browser instead of guessing, which also means
# these scripts keep working if the image changes where it puts them.

# The desktop session's user. PUID/PGID are 1000 in this template, and the
# image calls that user `abc`.
A11Y_USER="${A11Y_USER:-abc}"
A11Y_UID="$(id -u "$A11Y_USER" 2>/dev/null || echo 1000)"

# Read one variable out of a running process's environment.
_env_of() {
  local pid="$1" var="$2"
  tr '\0' '\n' < "/proc/$pid/environ" 2>/dev/null | sed -n "s/^${var}=//p" | head -1
}

# The browser process is the one that definitely has a working session.
a11y_session_pid() {
  pgrep -u "$A11Y_UID" -f 'chromium' 2>/dev/null | head -1
}

a11y_load_session() {
  local pid
  pid="$(a11y_session_pid)"
  if [ -z "$pid" ]; then
    # No browser: fall back to openbox, which owns the session bus itself.
    pid="$(pgrep -u "$A11Y_UID" -f 'openbox' 2>/dev/null | head -1)"
  fi
  if [ -n "$pid" ]; then
    export DISPLAY="$(_env_of "$pid" DISPLAY)"
    export DBUS_SESSION_BUS_ADDRESS="$(_env_of "$pid" DBUS_SESSION_BUS_ADDRESS)"
    export XDG_RUNTIME_DIR="$(_env_of "$pid" XDG_RUNTIME_DIR)"
    export HOME="$(_env_of "$pid" HOME)"
  fi
  export DISPLAY="${DISPLAY:-:1}"
  export HOME="${HOME:-/config}"
  export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$A11Y_UID}"
  # PulseAudio: this image points its clients at /defaults/native through
  # /etc/pulse/client.conf, so leave PULSE_SERVER unset unless a socket is
  # actually where the XDG default would put it. Setting it wrongly is worse
  # than not setting it — the client stops falling back to the config.
  if [ -z "${PULSE_SERVER:-}" ] && [ -S "${XDG_RUNTIME_DIR}/pulse/native" ]; then
    export PULSE_SERVER="unix:${XDG_RUNTIME_DIR}/pulse/native"
  fi
}

# Run a command as the session user with that environment. Anything that talks
# to X, to the session bus, or to PulseAudio has to be this user — root has its
# own bus and its own (empty) X authority.
#
# Being this user is also what makes the reads above work: /proc/PID/environ
# needs either the same uid or CAP_SYS_PTRACE, and docker drops CAP_SYS_PTRACE
# even for root. So run this whole toolkit as `abc` (the exec endpoint's
# "user":"abc") and the setpriv branch never comes up.
a11y_as_user() {
  a11y_load_session
  local vars=(DISPLAY="$DISPLAY" XDG_RUNTIME_DIR="$XDG_RUNTIME_DIR" HOME="$HOME" NO_AT_BRIDGE=0)
  # Only pass what we actually resolved. An empty PULSE_SERVER or bus address
  # is worse than an absent one: the client stops falling back to its config.
  [ -n "${DBUS_SESSION_BUS_ADDRESS:-}" ] && vars+=(DBUS_SESSION_BUS_ADDRESS="$DBUS_SESSION_BUS_ADDRESS")
  [ -n "${PULSE_SERVER:-}" ] && vars+=(PULSE_SERVER="$PULSE_SERVER")
  if [ "$(id -u)" = "$A11Y_UID" ]; then
    env "${vars[@]}" "$@"
    return $?
  fi
  setpriv --reuid "$A11Y_UID" --regid "$A11Y_UID" --clear-groups env "${vars[@]}" "$@"
}

# Tell the accessibility bus an assistive technology is listening.
#
# This is the switch that actually matters. Chromium exports its tree over
# AT-SPI when something claims to be an AT — Orca sets these two properties
# when it starts, and without them a browser launched with
# --force-renderer-accessibility still shows an empty application node. So
# anything that reads the tree sets them first.
a11y_enable_bus() {
  a11y_as_user gdbus call --session \
    --dest org.a11y.Bus --object-path /org/a11y/bus \
    --method org.freedesktop.DBus.Properties.Set \
    org.a11y.Status IsEnabled '<true>' >/dev/null 2>&1
  a11y_as_user gdbus call --session \
    --dest org.a11y.Bus --object-path /org/a11y/bus \
    --method org.freedesktop.DBus.Properties.Set \
    org.a11y.Status ScreenReaderEnabled '<true>' >/dev/null 2>&1
}

# at-spi2-registryd is what actually holds the list of applications. It is
# meant to be D-Bus activated, but activation on the accessibility bus lands
# without a DISPLAY here and the client just sees "message recipient
# disconnected" — so start it deliberately instead of hoping.
a11y_ensure_registry() {
  pgrep -u "$A11Y_UID" -f 'at-spi2-registryd' >/dev/null 2>&1 && return 0
  a11y_load_session
  a11y_as_user /usr/libexec/at-spi2-registryd >/tmp/a11y-registryd.log 2>&1 &
  sleep 2
  pgrep -u "$A11Y_UID" -f 'at-spi2-registryd' >/dev/null 2>&1
}

# The applications currently registered on the accessibility bus.
a11y_apps() {
  a11y_as_user python3 -c '
import pyatspi
d = pyatspi.Registry.getDesktop(0)
for i in range(d.childCount):
    app = d.getChildAtIndex(i)
    if app is not None and app.name:
        print(app.name)
' 2>/dev/null
}

# Where recordings and dumps go. This is a bind mount of the project's
# /workspace/artifacts, so whatever is written here is immediately readable by
# the agent in the project container.
A11Y_OUT="${A11Y_OUT:-/artifacts/a11y}"
mkdir -p "$A11Y_OUT" 2>/dev/null || true
chown "$A11Y_UID:$A11Y_UID" "$A11Y_OUT" 2>/dev/null || true
