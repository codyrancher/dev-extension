#!/bin/sh
# One copy of the repository, for every checkout on this node.
#
# Seven workspaces on this node, seven checkouts of rancher/dashboard, 873 MiB of `.git` between
# them - and nearly all of it the same objects, because they are the same repository. It is the
# last of the three per-workspace costs: the package caches became one store, the tool binaries
# became one install, and this is the history.
#
# WHY NOT THE OBVIOUS THING. The dedupe sweep cannot touch a `.git` (it is written in place by
# too much), and `cp -al`/`clone --local` hardlinking does not apply either, because every
# checkout here is SHALLOW: the bootstrap in apps.ts does `git fetch --depth 1`, which is the
# right thing for a workspace that wants one branch quickly, and git refuses to hardlink out of
# a shallow source. So the mechanism has to be the one git provides for exactly this: an
# ALTERNATE, a second object directory a repository is allowed to read from.
#
# WHAT THE STORE IS. A full mirror of upstream, kept here, plus the fork's branches under
# `refs/fork/*`. Full rather than shallow on purpose: a shallow repository cannot serve as
# anybody's alternate - a shallow boundary is a property of one repository, and lending objects
# across one is how a repository ends up believing it has history it has not got.
#
# WHAT ATTACHING DOES, and the order matters:
#
#   1. The workspace's own refs are fetched INTO the mirror, under `refs/workspaces/<name>/*`.
#      First, and the whole safety argument. Once a workspace reads its objects out of the
#      mirror, a `git gc` in the mirror that pruned an unreferenced object would break that
#      workspace with no warning and no way back. After this step every object any workspace
#      depends on is reachable from a ref the mirror itself holds.
#   2. The alternate is written, so the workspace can see the mirror's objects.
#   3. The workspace is unshallowed against the mirror - locally, no network. With the alternate
#      already in place this transfers almost nothing: the objects are already visible.
#   4. `fsck`, BEFORE anything is deleted. If the repository is not whole at this point the
#      alternate comes straight back off and the workspace is exactly as it was.
#   5. `repack -a -d -l`: `-l` packs only what is NOT in the alternate, `-d` drops what is now
#      redundant. This is the step that reclaims the disk, and it is deliberately last.
#   6. `fsck` again. If this fails - it should not, the objects are in the mirror - the local
#      packs are refetched from the mirror rather than left broken.
#
# Nothing here touches a worktree. Uncommitted changes, the index and stashes are untouched by
# every command above; `refs/stash` is one of the refs step 1 copies into the mirror.
#
# Run from boot.sh: once at start, then daily to keep the mirror current.
set -u

STORE=${STORE:-/workspaces/.store}
MIRROR="$STORE/git/dashboard.git"
UPSTREAM=${UPSTREAM:-https://github.com/rancher/dashboard.git}
FORK=${FORK:-https://github.com/codyrancher/dashboard.git}

# Root owns this pod and the checkouts belong to the node user, which git calls dubious
# ownership and refuses to work with.
#
# A config FILE, not `-c` and not GIT_CONFIG_COUNT, and this was established by testing all
# three. Every local fetch here runs `git upload-pack` in the OTHER repository as a child
# process, and that child does the ownership check on its own: a `-c` does not survive the
# re-exec, and neither does GIT_CONFIG_COUNT/KEY/VALUE - measured, both still fail with
# "detected dubious ownership" naming the source repository. GIT_CONFIG_GLOBAL names a file,
# the child reads it like any global config, and the fetch goes through. The file is this
# store's own, so root's ~/.gitconfig is left alone.
GITCONFIG="$STORE/.gitconfig"
GIT_CONFIG_GLOBAL="$GITCONFIG"
export GIT_CONFIG_GLOBAL

say() {
  echo "[git-store] $*"
}

prepare() {
  mkdir -p "$STORE/git" 2>/dev/null
  [ -f "$GITCONFIG" ] || printf '[safe]\n\tdirectory = *\n' > "$GITCONFIG"
}

ensure_mirror() {
  if [ -d "$MIRROR" ]; then
    # --prune would delete a remote-tracking ref that upstream deleted; the workspace namespaces
    # are not touched by it, which is why they are where they are.
    git -C "$MIRROR" fetch --quiet --prune origin '+refs/heads/*:refs/heads/*' 2>&1 | tail -2
    git -C "$MIRROR" fetch --quiet --no-tags fork '+refs/heads/*:refs/fork/*' 2>&1 | tail -2
    say "mirror up to date ($(du -sh "$MIRROR" 2>/dev/null | cut -f1))"

    return 0
  fi

  say 'building the mirror; this is the one slow run'
  mkdir -p "$STORE/git" || return 1
  rm -rf "$MIRROR.partial"

  # Into a .partial name and moved when complete, so an interrupted clone is never mistaken for
  # a mirror - a half-built one would be attached to and would be missing objects.
  git clone --mirror "$UPSTREAM" "$MIRROR.partial" || { rm -rf "$MIRROR.partial"; return 1; }
  git -C "$MIRROR.partial" remote add fork "$FORK" 2>/dev/null
  git -C "$MIRROR.partial" fetch --no-tags fork '+refs/heads/*:refs/fork/*' || true
  mv "$MIRROR.partial" "$MIRROR" || return 1
  say "mirror built ($(du -sh "$MIRROR" 2>/dev/null | cut -f1))"
}

attached() {
  grep -qs "$MIRROR/objects" "$1/.git/objects/info/alternates" 2>/dev/null
}

detach() {
  rm -f "$1/.git/objects/info/alternates"
}

attach() {
  work=$1
  name=$(basename "$(dirname "$work")")

  [ -d "$work/.git" ] || return 0
  if attached "$work"; then
    say "$name: already attached"

    return 0
  fi

  before=$(du -sm "$work/.git" 2>/dev/null | cut -f1)

  # 1. Its refs into the mirror, so the mirror can never gc an object it depends on.
  if ! git -C "$MIRROR" fetch --quiet --no-tags "$work" "+refs/*:refs/workspaces/$name/*"; then
    say "$name: could not copy its refs into the mirror; leaving it alone"

    return 1
  fi

  # 2. The alternate.
  mkdir -p "$work/.git/objects/info"
  echo "$MIRROR/objects" >> "$work/.git/objects/info/alternates"

  # 3. Unshallow against the mirror. Local, and nearly free with the alternate in place.
  if [ -f "$work/.git/shallow" ]; then
    git -C "$work" fetch --quiet --unshallow "$MIRROR" 2>/dev/null ||
      git -C "$work" fetch --quiet "$MIRROR" 2>/dev/null || true
  fi

  # 4. Whole BEFORE anything is deleted, or the alternate comes back off.
  if ! git -C "$work" fsck --connectivity-only --no-progress >/dev/null 2>&1; then
    detach "$work"
    say "$name: not whole with the alternate attached; reverted, nothing deleted"

    return 1
  fi

  # 5. The step that reclaims the disk: pack only what the alternate has not got.
  git -C "$work" repack -a -d -l --quiet 2>/dev/null
  git -C "$work" prune-packed 2>/dev/null

  # 6. And whole afterwards. If not, take the objects back from the mirror rather than leave a
  # broken checkout - the mirror has them, that is the point of it.
  if ! git -C "$work" fsck --connectivity-only --no-progress >/dev/null 2>&1; then
    say "$name: not whole after repack; refetching from the mirror"
    detach "$work"
    git -C "$work" fetch --quiet "$MIRROR" '+refs/heads/*:refs/heads/*' 2>/dev/null

    return 1
  fi

  after=$(du -sm "$work/.git" 2>/dev/null | cut -f1)
  say "$name: attached, .git ${before}M -> ${after}M"
}

prepare
ensure_mirror || { say 'the mirror is not there and could not be built; nothing attached'; exit 1; }

# The checkouts run as the node user and read their objects out of here; the mirror is built by
# root. Owned by node so a workspace is never reading somebody else's repository.
chown -R node:node "$MIRROR" 2>/dev/null || true

# One spot. `.store` is where the node's durable data lives, and the two that were already
# central are given their place in it by name - a link, not a move, because dev-api and the
# capture address them by their own paths and a move would be a rename nothing else knows about.
[ -e "$STORE/artifacts" ] || ln -s /workspaces/.artifacts "$STORE/artifacts" 2>/dev/null
[ -e "$STORE/packages" ] || ln -s /workspaces/.shared "$STORE/packages" 2>/dev/null

# Named checkouts, or every one on the node. Naming one is how this was tested before it was
# ever pointed at somebody's working tree: the same code path, run against a copy.
if [ "$#" -gt 0 ]; then
  for work in "$@"; do
    attach "$work"
  done
else
  for work in /workspaces/*/dashboard; do
    [ -d "$work/.git" ] || continue
    attach "$work"
  done
fi

say "store: $(du -sh "$STORE/git" 2>/dev/null | cut -f1) of history, serving $(grep -ls "$MIRROR/objects" /workspaces/*/dashboard/.git/objects/info/alternates 2>/dev/null | wc -l) attached checkouts"
