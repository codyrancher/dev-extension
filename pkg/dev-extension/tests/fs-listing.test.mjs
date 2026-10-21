// The lines in here are real: they were produced by running the explorer's own find command in
// the agent pod against /workspaces and a workspace's bin, and pasted in. A parser tested
// against invented input is a parser tested against the author's idea of the format.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseEntry, parseListing, isWalkable, shared, childPath, parentPath, crumbs, humanSize, MAX_ENTRIES,
} from '../fs-listing.mjs';

/** `find /workspaces/lte-pr-19612/bin -maxdepth 1 -mindepth 1 -printf ...`, after the migration. */
const BIN = [
  'l\tf\t1\t946925\t35\t1792558841.7084721670\t/workspaces/.shared/tools/gh-2.76.1\tgh',
  'l\tf\t1\t946929\t34\t1792558841.7164722330\t/workspaces/.shared/tools/jq-1.7.1\tjq',
  'f\tf\t1\t952761\t2518\t1792528378.8041645200\t\tdev-shell',
  'd\td\t2\t952777\t4096\t1792528378.8041645200\t\tskills',
].join('\n');

/** `find / -maxdepth 1 ...` in the same pod: the root's `bin` is a RELATIVE symlink. */
const ROOT = [
  'd\td\t1\t3338219\t4096\t1792557055.0308256570\t\tetc',
  'd\td\t1936\t1\t0\t1792557045.9107622940\t\tproc',
  'l\td\t1\t3299418\t7\t1787529600.0000000000\tusr/bin\tbin',
].join('\n');

test('a symlink is a link, and says what it points at', () => {
  const gh = parseEntry(BIN.split('\n')[1]);

  assert.equal(gh.kind, 'link');
  assert.equal(gh.points, 'file');
  assert.equal(gh.target, '/workspaces/.shared/tools/jq-1.7.1');
  assert.equal(gh.broken, false);
  // The size of a symlink is the length of its target, not of the file - do not show it as the
  // binary's size, which is the mistake that makes a 54 MiB tool look like 34 bytes of nothing.
  assert.equal(gh.size, 34);
});

test('a plain file is not dressed up as a link', () => {
  const file = parseEntry(BIN.split('\n')[2]);

  assert.equal(file.kind, 'file');
  assert.equal(file.target, '');
  assert.equal(file.broken, false);
  assert.equal(file.links, 1);
});

test('a hardlinked file reports how many names it has', () => {
  // What the dedupe leaves behind: one inode, two names in two workspaces.
  const shared = parseEntry('f\tf\t7\t18350087\t56102912\t1760000004.0\t\tgh-2.76.1');

  assert.equal(shared.links, 7);
  assert.equal(shared.inode, 18350087);
});

test('a broken symlink is marked, and is not walkable', () => {
  const dead = parseEntry('l\tN\t1\t99\t12\t1760000005.0\t/workspaces/gone/bin/gh\tgh');

  assert.equal(dead.broken, true);
  assert.equal(dead.points, 'none');
  assert.equal(isWalkable(dead), false);
});

test('a symlink loop is marked rather than followed', () => {
  const loop = parseEntry('l\tL\t1\t100\t5\t1760000006.0\tloop\tloop');

  assert.equal(loop.loop, true);
  assert.equal(isWalkable(loop), false);
});

test('a symlink to a directory IS walkable, because clicking it works', () => {
  // The root's `bin` -> `usr/bin`, which is the real case: a RELATIVE target. Walking it works
  // because the walk is by path (`/bin`) and the kernel resolves the link, not by target.
  const bin = parseEntry(ROOT.split('\n')[2]);

  assert.equal(bin.kind, 'link');
  assert.equal(bin.points, 'dir');
  assert.equal(bin.target, 'usr/bin');
  assert.equal(isWalkable(bin), true);
  // A symlink to a FILE is not something to walk into.
  assert.equal(isWalkable(parseEntry(BIN.split('\n')[0])), false);
});

test('a directory\'s link count is not a hardlink story', () => {
  // /proc reports 1936 links; every directory reports at least 2. A "this file has N names"
  // badge drawn from that would be on every directory in the tree and mean nothing.
  const proc = parseEntry(ROOT.split('\n')[1]);

  assert.equal(proc.kind, 'dir');
  assert.equal(proc.links, 1936);
  assert.equal(shared(proc), false);
  assert.equal(shared(parseEntry('f\tf\t7\t18350087\t56102912\t1792528379.2\t\tgh-2.76.1')), true);
});

test('a high-precision mtime becomes milliseconds, not NaN', () => {
  // find prints %T@ with ten decimal places; Date.parse of that string is NaN.
  const gh = parseEntry(BIN.split('\n')[0]);

  assert.equal(gh.mtime, 1792558842000);
  assert.ok(Number.isFinite(new Date(gh.mtime).getTime()));
});

test('a name containing a tab survives, because the name is the last field', () => {
  const odd = parseEntry('f\tf\t1\t1\t10\t1760000007.0\t\tsome\tname');

  assert.equal(odd.name, 'some\tname');
});

test('a line that is not a listing line is dropped, not half-parsed', () => {
  assert.equal(parseEntry('find: /proc/1/task: Permission denied'), null);
  assert.equal(parseEntry(''), null);
  assert.equal(parseEntry('d\td\t2\t1\t4096'), null);
});

test('directories sort first, with symlinks-to-directories among them', () => {
  const { entries, total, omitted } = parseListing(BIN);

  assert.deepEqual(entries.map((e) => e.name), ['skills', 'dev-shell', 'gh', 'jq']);
  assert.equal(total, 4);
  assert.equal(omitted, 0);
});

test('a listing longer than the cap says how many it left out', () => {
  const many = Array.from({ length: MAX_ENTRIES + 5 }, (_, i) => (
    `f\tf\t1\t${ i }\t10\t1760000000.0\t\tfile-${ String(i).padStart(6, '0') }`
  )).join('\n');
  const { entries, omitted, total } = parseListing(many);

  assert.equal(entries.length, MAX_ENTRIES);
  assert.equal(omitted, 5);
  assert.equal(total, MAX_ENTRIES + 5);
});

test('paths join and climb without doubling the root slash', () => {
  assert.equal(childPath('/', 'workspaces'), '/workspaces');
  assert.equal(childPath('/workspaces', 'lte-pr-19612'), '/workspaces/lte-pr-19612');
  assert.equal(parentPath('/workspaces/lte-pr-19612'), '/workspaces');
  assert.equal(parentPath('/workspaces'), '/');
  assert.equal(parentPath('/'), '/');
  // A trailing slash is somebody's typing, not a different directory.
  assert.equal(parentPath('/workspaces/'), '/');
});

test('crumbs always start at the root, so there is a way back out', () => {
  assert.deepEqual(crumbs('/workspaces/.artifacts'), [
    { name: '/', path: '/' },
    { name: 'workspaces', path: '/workspaces' },
    { name: '.artifacts', path: '/workspaces/.artifacts' },
  ]);
  assert.deepEqual(crumbs('/'), [{ name: '/', path: '/' }]);
});

test('sizes read the way a filesystem is talked about', () => {
  assert.equal(humanSize(0), '0 B');
  assert.equal(humanSize(512), '512 B');
  assert.equal(humanSize(4096), '4 KB');
  assert.equal(humanSize(56102912), '54 MB');
  assert.equal(humanSize(1536), '1.5 KB');
});
