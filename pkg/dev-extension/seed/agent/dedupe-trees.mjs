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
// What it will not touch, because those ARE edited in place:
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

const SKIP_DIRS = new Set(['.cache', '.vite', '.turbo', '.git', '.bin', '.yarn-integrity']);

/** Every node_modules tree worth looking at, without walking the whole disk to find them. */
function trees(root) {
  const found = [];

  for (const entry of read(root)) {
    // /workspaces/<name>/dashboard/node_modules and /workspaces/.shared/template/<hash>/node_modules
    for (const candidate of [
      path.join(root, entry, 'dashboard', 'node_modules'),
      path.join(root, entry, 'node_modules'),
    ]) {
      if (isDir(candidate)) {
        found.push(candidate);
      }
    }
    if (entry === '.shared') {
      for (const hash of read(path.join(root, entry, 'template'))) {
        const candidate = path.join(root, entry, 'template', hash, 'node_modules');

        if (isDir(candidate)) {
          found.push(candidate);
        }
      }
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
