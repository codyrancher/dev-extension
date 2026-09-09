#!/bin/sh
# Build this workspace's dashboard (or Storybook) as a static site and refresh its public
# preview, then print the sslip.io URL on the last line. Mirrors the dev-extension Share tab
# (buildShare + rebuildPreview): the build runs in a worktree so it never disturbs the dev
# server, and the built site is served by the workspace's preview deployment on its Rancher.
#
#   share.sh dashboard    -> https://preview-<ws>.dev-extension.<ip>.sslip.io/dashboard/
#   share.sh storybook    -> https://preview-<ws>.dev-extension.<ip>.sslip.io/
#
# Creating a preview the first time is a browser action (Apps Plus renders it), so if none is
# live yet this still builds and prints the URL, and says to press the Share tab's button once.
set -e
KIND="${1:-dashboard}"
case "$KIND" in dashboard|storybook) ;; *) echo "usage: share.sh dashboard|storybook" >&2; exit 2 ;; esac

# The workspace root is /workspaces/<name>. The pane sources .env (PROJECT_NAME), but fall back
# to the path so this works however it is invoked.
WS=""
if [ -n "$PROJECT_NAME" ] && [ -d "/workspaces/$PROJECT_NAME/dashboard" ]; then WS="/workspaces/$PROJECT_NAME"; fi
if [ -z "$WS" ]; then case "$(pwd)" in /workspaces/*/*) WS="/workspaces/$(pwd | cut -d/ -f3)" ;; /workspaces/*) WS="$(pwd)" ;; esac; fi
[ -n "$WS" ] && [ -d "$WS/dashboard" ] || { echo "share: cannot find the workspace checkout (WS='$WS')" >&2; exit 1; }
WSNAME="$(basename "$WS")"

set -a; . "$WS/.env" 2>/dev/null || true; set +a
R="${RANCHER_URL:-$API}"; T="$RANCHER_TOKEN"
IP="$(printf '%s' "$R" | sed -n 's#.*\.dev-extension\.\([0-9][0-9.]*\)\.sslip\.io.*#\1#p')"
PREV="preview-$WSNAME"
if [ "$KIND" = storybook ]; then URLPATH="/"; BASE="/"; else URLPATH="/dashboard/"; BASE="/dashboard/"; fi
URL=""; [ -n "$IP" ] && URL="https://$PREV.dev-extension.$IP.sslip.io$URLPATH"

# Build helpers, laid down the same way the extension does.
mkdir -p "$WS/.share"
printf '%s' 'Ly8gUmFuY2hlciBwcm94aWVzIGEgU2VydmljZSB0aHJvdWdoIHRoZSBhcGlzZXJ2ZXIsIGFuZCB0aGUgYXBpc2VydmVyIHJld3JpdGVzIGV2ZXJ5IGFic29sdXRlCi8vIFVSTCBpbiBhbiBIVE1MIHJlc3BvbnNlIHRvIHNpdCB1bmRlciBpdHMgb3duIHByb3h5IHBhdGggLSBhIHBhdGggUmFuY2hlciB0aGVuIGRvZXMgbm90IHNlcnZlLgovLyBTbyB0aGUgYnVpbHQgaW5kZXgncyBzY3JpcHQgYW5kIGxpbmsgdGFncyBhcmUgdGFrZW4gb3V0IG9mIHRoZSBtYXJrdXAgYW5kIHB1dCBiYWNrIGJ5IGEKLy8gc2NyaXB0LCB3aGljaCB0aGUgcmV3cml0ZXIgZG9lcyBub3QgcmVhZC4gRXZlcnl0aGluZyB0aGUgYXBwIGxvYWRzIGFmdGVyIHRoYXQgaXMgSmF2YVNjcmlwdCdzCi8vIGRvaW5nLCBhdCB0aGUgYmFzZSBpdCB3YXMgYnVpbHQgZm9yLgpjb25zdCBmcyA9IHJlcXVpcmUoJ2ZzJyk7CmNvbnN0IGZpbGUgPSBwcm9jZXNzLmFyZ3ZbMl07CmxldCBodG1sID0gZnMucmVhZEZpbGVTeW5jKGZpbGUsICd1dGY4Jyk7CmNvbnN0IHRhZ3MgPSBbXTsKaHRtbCA9IGh0bWwucmVwbGFjZSgvPHNjcmlwdFxiW14+XSpcc3NyYz0iKFteIl0rKSJbXj5dKj48XC9zY3JpcHQ+L2csICh3aG9sZSwgc3JjKSA9PiB7IHRhZ3MucHVzaCh7IHQ6ICdzY3JpcHQnLCB1OiBzcmMgfSk7IHJldHVybiAnJzsgfSk7Cmh0bWwgPSBodG1sLnJlcGxhY2UoLzxsaW5rXGJbXj5dKlxzaHJlZj0iKFteIl0rKSJbXj5dKj4vZywgKHdob2xlLCBocmVmKSA9PiB7CiAgY29uc3QgcmVsID0gKC9cYnJlbD0iKFteIl0rKSIvLmV4ZWMod2hvbGUpIHx8IFtdKVsxXSB8fCAnc3R5bGVzaGVldCc7CiAgY29uc3QgYXMgPSAoL1xiYXM9IihbXiJdKykiLy5leGVjKHdob2xlKSB8fCBbXSlbMV0gfHwgJyc7CiAgdGFncy5wdXNoKHsgdDogJ2xpbmsnLCB1OiBocmVmLCByZWwsIGFzIH0pOwogIHJldHVybiAnJzsKfSk7CmNvbnN0IGJvb3QgPSAnPHNjcmlwdD4oZnVuY3Rpb24oKXt2YXIgdGFncz0nICsgSlNPTi5zdHJpbmdpZnkodGFncykgKyAnO3RhZ3MuZm9yRWFjaChmdW5jdGlvbih4KXt2YXIgZTtpZih4LnQ9PT0ic2NyaXB0Iil7ZT1kb2N1bWVudC5jcmVhdGVFbGVtZW50KCJzY3JpcHQiKTtlLnNyYz14LnU7ZS5kZWZlcj10cnVlO31lbHNle2U9ZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgibGluayIpO2UuaHJlZj14LnU7ZS5yZWw9eC5yZWw7aWYoeC5hcyl7ZS5hcz14LmFzO319ZG9jdW1lbnQuaGVhZC5hcHBlbmRDaGlsZChlKTt9KTt9KSgpOzwvc2NyaXB0Pic7Cmh0bWwgPSBodG1sLnJlcGxhY2UoJzwvaGVhZD4nLCBib290ICsgJzwvaGVhZD4nKTsKZnMud3JpdGVGaWxlU3luYyhmaWxlLCBodG1sKTsKY29uc29sZS5sb2coJ2luZGV4OiAnICsgdGFncy5sZW5ndGggKyAnIHRhZ3MgbW92ZWQgaW50byBhIHNjcmlwdCcpOwo=' | base64 -d > "$WS/.share/unrewrite.js"

cat > "$WS/.share/build.sh" <<'BUILDSH'
#!/bin/bash
# Build a share into $WS/share/$KIND, from a worktree so the dev server's cache is never shared.
WS="${WS:?WS not set}"
KIND=$1; BASE=$2; REF=$3
cd "$WS/dashboard" || exit 1
mkdir -p "$WS/.share" "$WS/share"
S=$WS/.share/$KIND.status; L=$WS/.share/$KIND.log
branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null); sha=$(git rev-parse --short HEAD 2>/dev/null)
WT=$WS/.share/src-$KIND
git worktree remove --force "$WT" >/dev/null 2>&1; rm -rf "$WT"; mkdir -p "$WT"
if [ -n "$REF" ] && [ "$REF" != "$branch" ]; then
  rmdir "$WT"; git worktree add --detach "$WT" "$REF" >/dev/null 2>&1 || { echo "failed $(date -u +%FT%TZ) $REF unknown" > "$S"; exit 1; }
  branch=$REF; sha=$(git -C "$WT" rev-parse --short HEAD 2>/dev/null)
else
  tar --exclude=./node_modules --exclude='./*/node_modules' --exclude='./pkg/*/node_modules' --exclude=./.git -cf - . | tar -C "$WT" -xf -
fi
for d in $(find . -maxdepth 3 -name node_modules -type d -not -path '*/node_modules/*'); do mkdir -p "$WT/$(dirname "$d")"; cp -al "$d" "$WT/$d"; rm -rf "$WT/$d/.cache"; done
cd "$WT"
echo "building $(date -u +%FT%TZ) $branch $sha" > "$S"
CORES=$(nproc 2>/dev/null || echo 2); HALF=$(( CORES / 2 )); [ "$HALF" -lt 1 ] && HALF=1
RUN="nice -n 19 taskset -c 0-$((HALF - 1))"
{
  export NODE_OPTIONS=--max_old_space_size=4096
  rm -rf "$WS/share/$KIND.next"
  if [ "$KIND" = storybook ]; then
    $RUN yarn build-storybook && cp -r storybook/storybook-static "$WS/share/$KIND.next"
  else
    ROUTER_BASE=$BASE RESOURCE_BASE=$BASE OUTPUT_DIR="$WS/share/$KIND.next" $RUN yarn build && node "$WS/.share/unrewrite.js" "$WS/share/$KIND.next/index.html"
  fi
} > "$L" 2>&1
RC=$?
cd "$WS/dashboard" && git worktree remove --force "$WT" >/dev/null 2>&1; rm -rf "$WT"
if [ $RC -eq 0 ] && [ -f "$WS/share/$KIND.next/index.html" ]; then
  OLD=$WS/share/$KIND.old-$(date +%s)-$$
  [ -e "$WS/share/$KIND" ] && mv "$WS/share/$KIND" "$OLD"
  if mv "$WS/share/$KIND.next" "$WS/share/$KIND"; then
    echo "ok $(date -u +%FT%TZ) $branch $sha" > "$S"
  else
    [ -e "$OLD" ] && mv "$OLD" "$WS/share/$KIND"
    echo "failed $(date -u +%FT%TZ) $branch $sha" > "$S"
  fi
  rm -rf "$WS"/share/$KIND.old-* "$WS/share/$KIND.old" 2>/dev/null
else
  echo "failed $(date -u +%FT%TZ) $branch $sha" > "$S"
fi
BUILDSH
chmod +x "$WS/.share/build.sh"

echo "share: building $KIND for $WSNAME (this takes a few minutes) ..." >&2
if tmux has-session -t "mc-share-$KIND" 2>/dev/null; then
  echo "share: a $KIND build is already running; waiting for it" >&2
else
  # Clear the previous build's status so the poll waits for THIS build, not a stale "ok".
  : > "$WS/.share/$KIND.status"
  WS="$WS" tmux new-session -d -s "mc-share-$KIND" -c "$WS/dashboard" "WS='$WS' '$WS/.share/build.sh' $KIND $BASE ''"
fi
st=""
i=0
while [ $i -lt 240 ]; do
  st="$(cut -d' ' -f1 "$WS/.share/$KIND.status" 2>/dev/null)"
  [ "$st" = ok ] && break
  if [ "$st" = failed ]; then echo "share: build FAILED. Last lines of the log:" >&2; tail -n 25 "$WS/.share/$KIND.log" >&2; exit 1; fi
  sleep 5; i=$((i + 1))
done
[ "$st" = ok ] || { echo "share: build timed out after 20m" >&2; exit 1; }
echo "share: build ok ($(cat "$WS/.share/$KIND.status"))" >&2

# Refresh the live preview so it re-fetches the new build. The preview runs on the workspace's
# Rancher (dev-<preview> namespace, same-named deployment); a rollout restart makes its init
# container fetch the fresh tarball. Creating one the first time is the Share tab's job.
provisioned=no
if [ -n "$R" ] && [ -n "$T" ]; then
  dep="$R/k8s/clusters/local/apis/apps/v1/namespaces/dev-$PREV/deployments/dev-$PREV"
  code="$(curl -sk -m20 -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $T" "$dep")"
  if [ "$code" = 200 ]; then
    curl -sk -m30 -o /dev/null -X PATCH -H "Authorization: Bearer $T" \
      -H 'Content-Type: application/strategic-merge-patch+json' \
      -d "{\"spec\":{\"template\":{\"metadata\":{\"annotations\":{\"dev.rancher.io/restartedAt\":\"$(date -u +%FT%TZ)\"}}}}}" "$dep"
    echo "share: preview restarted to serve the new build" >&2
    provisioned=yes
  fi
fi

if [ -z "$URL" ]; then echo "share: built, but could not work out the preview host from RANCHER_URL='$R'" >&2; exit 1; fi
if [ "$provisioned" = no ]; then
  btn=$([ "$KIND" = storybook ] && echo "Build and share Storybook" || echo "Rebuild")
  echo "share: no live preview for $WSNAME yet - open the workspace's Share tab once and press '$btn' to publish it. The link will be:" >&2
fi
# The URL, alone on the last line, for the caller to capture.
echo "$URL"
