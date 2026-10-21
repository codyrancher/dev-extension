/**
 * One directory of a real filesystem, as a pod reports it.
 *
 * The listing this replaces was `ls -1Ap`, which answers one question - is this a directory -
 * and throws the rest away. That is enough to walk a tree and not enough to understand one:
 * this node's workspaces are held together by symlinks (`bin/gh` is one name for a binary that
 * lives in the shared store) and by hardlinks (a daily sweep collapses identical files across
 * workspaces into one inode), and neither is visible in a list of names. A file explorer that
 * cannot show them is showing a tidier filesystem than the one that is there.
 *
 * So the pod runs `find -printf` instead, which prints what `lstat` knows, one line per entry,
 * no two-pass guessing and no locale-dependent columns to parse:
 *
 *   %y  the entry's own type       - `l` for a symlink, never the thing it points at
 *   %Y  the type after following it - `N` broken, `L` a loop, `?` unreadable
 *   %n  hardlink count             - above 1, this file has other names somewhere
 *   %i  inode                      - which is WHICH other names, when two paths agree
 *   %s  size in bytes
 *   %T@ modified, epoch seconds
 *   %l  the symlink's target, empty for everything else
 *   %f  the entry's name
 *
 * The name goes last because a filename may contain anything at all, a tab included: every
 * other field is fixed-shape, so the parser splits off the ones it knows and keeps the whole
 * remainder as the name. A newline in a name is the one case this cannot survive, and it shows
 * up as a line that does not parse rather than as a wrong answer.
 *
 * Plain JavaScript and no imports, so `node --test` loads it directly - see
 * tests/fs-listing.test.mjs.
 */

/** How many entries a listing will show. A node_modules has tens of thousands. */
export const MAX_ENTRIES = 2000;

/** The printf format the pod is asked for. Shared so the parser and the command cannot drift. */
export const FIND_FORMAT = '%y\\t%Y\\t%n\\t%i\\t%s\\t%T@\\t%l\\t%f\\n';

/** What `%y` says, in words the UI can switch on. Anything else is a device, socket or fifo. */
function kindOf(letter) {
  if (letter === 'd') {
    return 'dir';
  }
  if (letter === 'f') {
    return 'file';
  }
  if (letter === 'l') {
    return 'link';
  }

  return 'other';
}

/**
 * One line of `find -printf FIND_FORMAT`, or null if it is not one.
 *
 * Null rather than a half-filled entry: a line this does not understand is a line whose name
 * cannot be trusted either, and inventing an entry for it would put a wrong path in front of
 * somebody about to click it.
 */
export function parseEntry(line) {
  const parts = String(line || '').split('\t');

  if (parts.length < 8) {
    return null;
  }
  const [type, resolved, links, inode, size, mtime, target] = parts;
  // Everything from the eighth field on is the name, tabs and all.
  const name = parts.slice(7).join('\t');

  if (!name || name === '.' || name === '..') {
    return null;
  }

  const kind = kindOf(type);
  // Where a click goes. A symlink to a directory is a directory to walk into; a broken one is
  // not, and must not be offered as one.
  const points = kind === 'link' ? kindOf(resolved) : kind;

  return {
    name,
    kind,
    /** For a symlink, what it resolves to; otherwise the same as `kind`. */
    points: resolved === 'N' || resolved === 'L' || resolved === '?' ? 'none' : points,
    /** A symlink that resolves to nothing, which is worth saying out loud. */
    broken: kind === 'link' && resolved === 'N',
    /** A symlink that points at itself, eventually. */
    loop:   kind === 'link' && resolved === 'L',
    target: kind === 'link' ? target : '',
    links:  Number(links) || 1,
    inode:  Number(inode) || 0,
    size:   Number(size) || 0,
    mtime:  Math.round(Number(mtime) || 0) * 1000,
  };
}

/**
 * A whole listing, sorted the way a directory is read: directories first, then by name.
 *
 * A symlink to a directory sorts with the directories, because that is what it behaves like
 * when clicked. A broken one sorts with the files, because it behaves like nothing at all.
 */
export function parseListing(out, { max = MAX_ENTRIES } = {}) {
  const all = String(out || '').split('\n').map(parseEntry).filter(Boolean);
  const walkable = (e) => e.kind === 'dir' || (e.kind === 'link' && e.points === 'dir');

  all.sort((a, b) => (
    (Number(walkable(b)) - Number(walkable(a))) ||
    a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
  ));

  return {
    entries: all.slice(0, max),
    /** How many were left out, so a capped listing never reads as a complete one. */
    omitted: Math.max(0, all.length - max),
    total:   all.length,
  };
}

/**
 * Whether this file has other names elsewhere on the disk - the hardlink badge.
 *
 * Regular files only, and that is the whole point of the function. Every directory has a link
 * count of at least two (itself and `.`), and one with subdirectories has more - /proc in this
 * pod reports 1936 - so a badge drawn straight from `links > 1` would sit on every directory in
 * the tree and tell nobody anything. On a regular file it means what it says: the daily sweep
 * collapsed this and some other workspace's copy into one inode, and writing through either
 * name writes through both.
 */
export function shared(entry) {
  return entry?.kind === 'file' && Number(entry?.links) > 1;
}

/** Whether clicking this entry walks into it. */
export function isWalkable(entry) {
  return entry?.kind === 'dir' || (entry?.kind === 'link' && entry?.points === 'dir');
}

/**
 * The absolute path of a child, without the double slash at the root that `${dir}/${name}`
 * gives and that then appears in every breadcrumb below it.
 */
export function childPath(dir, name) {
  const base = String(dir || '/');

  return base.endsWith('/') ? `${ base }${ name }` : `${ base }/${ name }`;
}

/** The directory above this one, and '/' for the root, which has no above. */
export function parentPath(dir) {
  const path = String(dir || '/');
  const cut = path.replace(/\/+$/, '').lastIndexOf('/');

  return cut <= 0 ? '/' : path.replace(/\/+$/, '').slice(0, cut);
}

/**
 * A path as the pieces a breadcrumb is made of, each with the path that gets back to it.
 * The root is always the first crumb, so there is always a way back out.
 */
export function crumbs(dir) {
  const parts = String(dir || '/').split('/').filter(Boolean);
  const out = [{ name: '/', path: '/' }];
  let at = '';

  for (const part of parts) {
    at += `/${ part }`;
    out.push({ name: part, path: at });
  }

  return out;
}

/** A size a person reads, in the units a filesystem is talked about in. */
export function humanSize(bytes) {
  const n = Number(bytes) || 0;

  if (n < 1024) {
    return `${ n } B`;
  }
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = n / 1024;
  let unit = 0;

  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }

  return `${ value >= 10 || Number.isInteger(value) ? Math.round(value) : value.toFixed(1) } ${ units[unit] }`;
}
