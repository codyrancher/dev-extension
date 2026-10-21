#!/usr/bin/env node
// Collapse identical files across the workspaces on this node into one inode each.
//
// Every workspace is a checkout of the same repository, so their node_modules are the same
// packages with a few differing versions. The install path already hardlinks a whole
// node_modules out of a template when the lockfile hash matches exactly (apps.ts, lte.ts) - and
// that is the trouble: a lockfile differing by one package shares nothing, and every PR branch
// has its own lockfile. Measured on this node: seven workspaces, three templates, 6.3 GiB of
// node_modules of which five workspaces held a full private copy.
//
// So this is the other half, and it keys on content rather than on a lockfile: files of equal
// size and equal SHA-1 become one inode. It is safe here for the reason the install path's
// comment already gives - nothing patches installed packages in place, and yarn replaces a file
// rather than editing it, so a workspace that installs later breaks its own link and leaves
// everybody else's copy alone.
//
// What it will not touch, because those ARE written in place - and a write through one path of a
// hardlink is a write to every path that holds it:
//   - a checkout's own working files: an editor and an agent's edit tool both write O_TRUNC
//   - anything under a `.cache`, `.vite`, `.turbo` or `.git` directory
//   - `node_modules/.bin` (symlinks, and rewritten by every install)
//   - anything that is not a regular file, or is already the same inode
//
// Run from boot.sh: once a few minutes after start, then daily. It is interruptible - a link is
// one rename-free `link()` call - and re-running it is a no-op.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/** Where the trees are. One filesystem, which is what makes a hardlink possible at all. */
const ROOTS = process.argv.slice(2).length ? process.argv.slice(2) : ['/workspaces'];

/** Below this a link saves nothing worth the inode churn: a block is 4 KiB. */
const MIN_BYTES = 4096;

/*
 * What is never collapsed, and why each one.
 *
 * `.git` - git rewrites an index and a packfile by writing a new one and renaming over the old,
 *   which is safe for a hardlink, but it also keeps a lock file and a reflog it appends to. A
 *   repository is not worth the argument: it is 71 MiB of the ~1 GiB this sweep is after, and
 *   sharing git objects properly is `alternates`, not inode tricks.
 * `.cache`, `.vite`, `.turbo` - build caches, written in place by design.
 * `.bin` - symlinks and shims an install rewrites.
 * `.home/.claude`, `.home/.gemini` - a CLI's state: transcripts, settings and a conversation's
 *   own files, appended to while it runs.
 */
const SKIP_DIRS = new Set([
  '.cache', '.vite', '.turbo', '.git', '.bin', '.yarn-integrity', '.claude', '.gemini', '.npm',
]);

/**
 * The trees worth walking: the ones nothing edits in place.
 *
 * It began as node_modules only, which is where the duplication was assumed to be. Measured
 * afterwards, node_modules was 3.9 GiB of it and the rest was everywhere else - 380 MiB of
 * `bin` across seven workspaces because each carries its own 54 MiB `gh`, and 1.3 GiB of homes
 * carrying their own copies of claude, jq and gh again.
 *
 * It is deliberately NOT the whole workspace. A hardlink is shared by every path that holds it,
 * so a write THROUGH one path is a write to all of them - and the one thing a workspace exists
 * for is somebody editing its checkout. An editor saving a file, or an agent's edit tool, opens
 * it O_TRUNC and writes in place: collapse two branches' identical `Card.vue` and an edit in one
 * workspace silently rewrites the other's checkout and leaves it dirty. So the checkout's own
 * working files are off limits, and what is left is the three kinds of tree nothing writes
 * through: installed packages, the tool binaries, and a home's cached toolchain.
 */
function trees(root) {
  const found = [];
  const add = (...parts) => {
    const candidate = path.join(...parts);

    if (isDir(candidate)) {
      found.push(candidate);
    }
  };

  for (const entry of read(root)) {
    if (entry === '.shared') {
      for (const hash of read(path.join(root, entry, 'template'))) {
        add(root, entry, 'template', hash, 'node_modules');
      }
      continue;
    }
    // `.artifacts` is somebody's evidence, already hardlinked into place by the capture.
    if (entry.startsWith('.')) {
      continue;
    }

    const workspace = path.join(root, entry);

    if (!isDir(workspace)) {
      continue;
    }

    // The leased tools and the home's own `.local/bin`: `gh`, `jq`, `claude`, `agy`.
    add(workspace, 'bin');
    add(workspace, '.home');
    add(workspace, 'node_modules');

    // Each checkout beside them contributes its node_modules and nothing else.
    for (const child of read(workspace)) {
      if (child === 'bin' || child === '.home' || child === 'artifacts' || child.startsWith('.')) {
        continue;
      }
      add(workspace, child, 'node_modules');
    }
  }

  return found;
}

function read(dir) {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Every regular file in a tree, with the facts a dedupe decides on. */
function* files(dir) {
  let entries = [];

  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const full = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) {
        yield* files(full);
      }
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }

    try {
      const stat = fs.lstatSync(full);

      if (stat.isFile() && stat.size >= MIN_BYTES) {
        yield { path: full, size: stat.size, ino: stat.ino, dev: stat.dev, mode: stat.mode };
      }
    } catch { /* a file that went away mid-walk is not this run's business */ }
  }
}

function sha1(file) {
  try {
    return crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex');
  } catch {
    return '';
  }
}

/**
 * Link `from` to `to`, via a temporary name.
 *
 * `link()` refuses an existing target, so the replacement is link-then-rename: at no point is
 * the path missing, and a crash leaves either the old file or the new link, never a gap. If
 * anything fails the original is untouched - which is the whole safety argument for doing this
 * to somebody's dependencies while they work.
 */
function relink(keep, drop) {
  const temp = `${ drop }.dedupe-${ process.pid }`;

  try {
    fs.linkSync(keep, temp);
    fs.renameSync(temp, drop);

    return true;
  } catch {
    try {
      fs.unlinkSync(temp);
    } catch { /* nothing to clean */ }

    return false;
  }
}

function main() {
  const bySize = new Map();
  let seen = 0;

  for (const root of ROOTS) {
    for (const tree of trees(root)) {
      for (const file of files(tree)) {
        seen++;
        const key = `${ file.dev }:${ file.size }`;

        (bySize.get(key) || bySize.set(key, []).get(key)).push(file);
      }
    }
  }

  let linked = 0;
  let saved = 0;

  for (const group of bySize.values()) {
    if (group.length < 2) {
      continue;
    }
    const byHash = new Map();

    for (const file of group) {
      const digest = sha1(file.path);

      if (!digest) {
        continue;
      }
      const same = byHash.get(digest);

      if (!same) {
        byHash.set(digest, file);
        continue;
      }
      // Already one inode: nothing to do, and linking would be a no-op that costs a rename.
      if (same.ino === file.ino) {
        continue;
      }
      if (relink(same.path, file.path)) {
        linked++;
        saved += file.size;
      }
    }
  }

  const mib = (saved / (1024 * 1024)).toFixed(0);

  console.log(`[dedupe] ${ seen } files considered, ${ linked } linked, ${ mib } MiB reclaimed`);
}

main();
