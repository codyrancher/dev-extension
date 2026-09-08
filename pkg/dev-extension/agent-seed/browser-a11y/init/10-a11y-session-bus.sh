#!/bin/bash
# Runs during container init (mounted at /custom-cont-init.d), before the
# desktop and Chromium start.
#
# Why this exists: AT-SPI lives on the D-Bus *session* bus — at-spi-bus-launcher
# owns `org.a11y.Bus` there, and that is how a client finds the accessibility
# bus at all. Under Wayland this image starts only a *system* bus, so there is
# nothing for anything to register on, and a Chromium launched with
# --force-renderer-accessibility still exports an empty tree.
#
# So, for that case: create the session bus here, at the fixed address the
# container's DBUS_SESSION_BUS_ADDRESS points at. Every s6 service inherits
# that variable, compositor and browser included, which is what puts the
# browser on the same bus as the tooling that reads it.
#
# Workspaces run the desktop under X11 instead (PIXELFLUX_WAYLAND=false), where
# startwm.sh's `dbus-launch --exit-with-session` already provides a session bus
# and DBUS_SESSION_BUS_ADDRESS is deliberately left unset — a second bus here
# would only split the session in half. This hook is a no-op in that case.
set -u

[ "${A11Y_TIER:-off}" = "off" ] && exit 0

ADDR="${DBUS_SESSION_BUS_ADDRESS:-}"
[ -z "$ADDR" ] && exit 0
case "$ADDR" in
  unix:path=*) SOCKET="${ADDR#unix:path=}" ;;
  *) echo "[a11y-init] DBUS_SESSION_BUS_ADDRESS is not a unix path ($ADDR), skipping"; exit 0 ;;
esac

if [ -S "$SOCKET" ]; then
  echo "[a11y-init] session bus already listening on $SOCKET"
  exit 0
fi

rm -f "$SOCKET"
# The desktop user, not root: everything that talks to this bus (the
# compositor, Chromium, at-spi2-registryd, Orca) runs as abc.
s6-setuidgid abc dbus-daemon --session --address="$ADDR" --fork --nosyslog \
  && echo "[a11y-init] session bus started on $SOCKET (tier ${A11Y_TIER})" \
  || echo "[a11y-init] FAILED to start the session bus on $SOCKET"
