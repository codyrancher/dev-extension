#!/bin/sh
# Keep every live workspace's artifacts, continuously, instead of only as it is deleted.
#
# The capture used to run in one place: removeWorkspaceTree, just before the `rm -rf`. That is
# the right moment but the only one, and it makes the evidence depend on the delete going
# through this code - a workspace removed by deleting its Installation, a tree cleaned up by
# hand, a node that lost the pod, and the recordings a review comment points at are gone with
# no way back. The files are meant to be the sticky half of a workspace that is meant to be
# disposable; something has to hold them that is not the delete path.
#
# So: the same `cp -al` the capture does, on a timer. It costs nothing to repeat - a hardlink to
# an inode that is already linked here is skipped by `cp -n`, and a file that has not changed is
# the same inode - so this walks a few thousand names and writes almost nothing.
#
# The set keeps the workspace's name, which is what the Artifacts page already reads a subject
# out of (`artifact-subjects.mjs`: `lte-pr-19612` is pull request 19612, and a live workspace and
# every kept set that agree about that are one subject on the page). Nothing here needs to know
# that - it only has to put the files where that page looks.
#
# What it will not do is delete anything, here or there. A file removed from a workspace stays
# in the set: "it stays until somebody decides to remove it" is the whole contract.
set -u

ROOT=${1:-/workspaces}
SETS="$ROOT/.artifacts"

mkdir -p "$SETS" 2>/dev/null || true

kept=0
for src in "$ROOT"/*/artifacts; do
  [ -d "$src" ] || continue

  ws=$(basename "$(dirname "$src")")
  case "$ws" in .*) continue ;; esac

  # Nothing recorded is not a failure, and must not leave an empty set behind.
  [ -n "$(ls -A "$src" 2>/dev/null)" ] || continue

  dst="$SETS/$ws"
  mkdir -p "$dst" 2>/dev/null || continue

  # `-n` so a name already in the set is left exactly as it is: this must never write over
  # evidence that was kept from an earlier run, whatever the workspace holds now.
  cp -aln "$src/." "$dst/" 2>/dev/null || cp -an "$src/." "$dst/" 2>/dev/null || true

  # Only when there is nothing there to say it: a tag written at capture time carries a
  # `capturedAt` and may say what the name cannot, and this is not the place to overrule it.
  if [ ! -f "$dst/.set.json" ]; then
    printf '{"workspace":"%s","keptBy":"live"}' "$ws" > "$dst/.set.json" 2>/dev/null || true
  fi

  kept=$((kept + 1))
done

echo "[artifacts] $kept live workspace(s) kept into $SETS"
