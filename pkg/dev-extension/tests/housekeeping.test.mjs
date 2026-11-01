// What the sweep may delete. The browser's version of this was a shell line nothing could test; each
// refusal below is one the extension relies on, and the sweep at the bottom runs against a real
// directory because a symlink or a hardlink is not something to take a fake's word for.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { numbersIn } from '../artifact-subjects.mjs';
import {
  housekeepingName, workspacesToKeep, treeCandidates, askCluster, treeMayGo, templatesToRemove, artifactTag, capturedTag,
  nextSweepDelay, firstSweepDelay, singleFlight, browserFallbackDue, sweepHousekeeping, sweepsAreWorking,
  TREE_AGE_FLOOR_MS, TREES_PER_SWEEP, SWEEP_EVERY_MS, SWEEP_FIRST_MS, BROWSER_FALLBACK_EVERY_MS, REGISTRAR_TRUSTED_MS,
} from '../dev-api/housekeeping.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const NOW = Date.parse('2026-11-01T12:00:00Z');
const OLD = NOW - TREE_AGE_FLOOR_MS - 60_000;
const registrar = (...names) => ({ at: new Date(NOW).toISOString(), workspaces: names.map((name) => ({ name })) });
const instances = (...names) => ({ items: names.map((name) => ({ metadata: { name } })) });
const dir = (name, mtimeMs = OLD, more = {}) => ({
  name, isDirectory: true, isSymbolicLink: false, mtimeMs, ctimeMs: mtimeMs, ...more
});
const gone = () => Object.assign(new Error('not found'), { status: 404 });

test('names: what may be interpolated into a removal', () => {
  for (const bad of ['', '.', '..', '../..', '.shared', '.artifacts', 'a/b', 'A', '-a', 'a b', `a${ 'b'.repeat(63) }`, null, undefined, 7]) {
    assert.equal(housekeepingName(bad), '', String(bad));
  }
  assert.equal(housekeepingName('lte-issue-14904'), 'lte-issue-14904');
});

test('keep: an empty workspace list is not an answer', () => {
  assert.equal(workspacesToKeep(registrar(), instances(), NOW), null);
});

test('keep: a list with no usable name in it is not an answer either', () => {
  assert.equal(workspacesToKeep({ at: new Date(NOW).toISOString(), workspaces: [{ name: '..' }, {}] }, instances(), NOW), null);
});

test('keep: a failed or malformed read is not an answer', () => {
  assert.equal(workspacesToKeep(null, instances(), NOW), null);
  assert.equal(workspacesToKeep({ at: new Date(NOW).toISOString() }, instances(), NOW), null);
  assert.equal(workspacesToKeep(registrar('a'), null, NOW), null);
  assert.equal(workspacesToKeep(registrar('a'), {}, NOW), null);
});

test('keep: a registrar that stopped being written, or has no date, is not an answer', () => {
  assert.equal(workspacesToKeep(registrar('a'), instances(), NOW + REGISTRAR_TRUSTED_MS + 1), null);
  assert.equal(workspacesToKeep({ at: '', workspaces: [{ name: 'a' }] }, instances(), NOW), null);
});

test('keep: an Installation counts even when the projection has not caught up', () => {
  const keep = workspacesToKeep(registrar('a'), { items: [{ metadata: { name: 'b', labels: { 'dev.rancher.io/workspace': 'c' } } }] }, NOW);

  assert.deepEqual([...keep].sort(), ['a', 'b', 'c']);
});

test('candidates: no list, no candidates, however old the trees are', () => {
  assert.deepEqual(treeCandidates([dir('a')], null, NOW), []);
  assert.deepEqual(treeCandidates([dir('a')], new Set(), NOW), []);
});

test('candidates: a tree that is listed is kept', () => {
  assert.deepEqual(treeCandidates([dir('a'), dir('b')], new Set(['a']), NOW), ['b']);
});

test('candidates: the sixty minute floor, including exactly sixty minutes', () => {
  const keep = new Set(['x']);

  assert.deepEqual(treeCandidates([dir('young', NOW - 60_000)], keep, NOW), []);
  assert.deepEqual(treeCandidates([dir('edge', NOW - TREE_AGE_FLOOR_MS)], keep, NOW), []);
  assert.deepEqual(treeCandidates([dir('old', NOW - TREE_AGE_FLOOR_MS - 1)], keep, NOW), ['old']);
});

test('candidates: an unreadable age is not an old one', () => {
  assert.deepEqual(treeCandidates([dir('a', NaN)], new Set(['x']), NOW), []);
  assert.deepEqual(treeCandidates([dir('a', OLD, { ctimeMs: NaN })], new Set(['x']), NOW), []);
  assert.deepEqual(treeCandidates([dir('a', OLD, { ctimeMs: undefined })], new Set(['x']), NOW), []);
});

test('candidates: an old mtime on a recent ctime is a tree that just arrived', () => {
  const keep = new Set(['x']);

  assert.deepEqual(treeCandidates([dir('moved', OLD, { ctimeMs: NOW - 5 })], keep, NOW), []);
  assert.deepEqual(treeCandidates([dir('touched', NOW - 5, { ctimeMs: OLD })], keep, NOW), []);
});

test('candidates: hidden directories, bad names, files and symlinks are never candidates', () => {
  const entries = [
    dir('.shared'), dir('.artifacts'), dir('.store'), dir('..'), dir('Upper'), dir('a b'),
    dir('afile', OLD, { isDirectory: false }),
    dir('alink', OLD, { isDirectory: false, isSymbolicLink: true }),
    dir('both', OLD, { isSymbolicLink: true }),
  ];

  assert.deepEqual(treeCandidates(entries, new Set(['x']), NOW), []);
});

test('the cluster: only a 404 is gone', async() => {
  assert.equal(await askCluster(async() => ({ metadata: { name: 'dev-a' } })), 'present');
  assert.equal(await askCluster(async() => {
    throw gone();
  }), 'absent');

  for (const status of [401, 403, 429, 500, 503, undefined]) {
    assert.equal(await askCluster(async() => {
      throw Object.assign(new Error('no'), { status });
    }), 'unknown', String(status));
  }
  assert.equal(await askCluster(async() => ({})), 'unknown');
  assert.equal(await askCluster(async() => null), 'unknown');
});

test('the cluster: a namespace or Installation standing, or any doubt, keeps the tree', () => {
  assert.equal(treeMayGo('absent', 'absent'), true);

  for (const a of ['present', 'unknown', 'absent']) {
    for (const b of ['present', 'unknown', 'absent']) {
      if (a !== 'absent' || b !== 'absent') {
        assert.equal(treeMayGo(a, b), false, `${ a } ${ b }`);
      }
    }
  }
});

test('templates: three newest kept, whatever order they are listed in', () => {
  const listed = [dir('c', 300), dir('e', 500), dir('a', 100), dir('d', 400), dir('b', 200)];

  assert.deepEqual(templatesToRemove(listed), ['b', 'a']);
});

test('templates: three or fewer, an unreadable directory or a silly count removes nothing', () => {
  assert.deepEqual(templatesToRemove([dir('a', 1), dir('b', 2), dir('c', 3)]), []);
  assert.deepEqual(templatesToRemove(null), []);
  assert.deepEqual(templatesToRemove([dir('a', 1), dir('b', 2)], 0), []);
  assert.deepEqual(templatesToRemove([dir('a', 1), dir('b', 2)], NaN), []);
});

test('templates: hidden, files, symlinks and path tricks are neither counted nor removed', () => {
  const listed = [
    dir('.hidden', 1), dir('..', 1), dir('.', 1), dir('../up', 1),
    dir('file', 1, { isDirectory: false }), dir('link', 1, { isDirectory: false, isSymbolicLink: true }),
    dir('a', 2), dir('b', 3), dir('c', 4), dir('d', 5),
  ];

  assert.deepEqual(templatesToRemove(listed), ['a']);
});

test('templates: one unreadable age and the order is a guess, so nothing goes', () => {
  assert.deepEqual(templatesToRemove([dir('a', NaN), dir('b', 2), dir('c', 3), dir('d', 4), dir('e', 5)]), []);
});

test('tags: the same bytes the browser wrote', () => {
  const at = '2026-11-01T12:00:00.000Z';

  assert.equal(artifactTag('lte-issue-14904', numbersIn('lte-issue-14904'), at), `{"workspace":"lte-issue-14904","issue":14904,"pr":0,"taggedAt":"${ at }"}`);
  assert.equal(artifactTag('lte-pr-7', numbersIn('lte-pr-7'), at), `{"workspace":"lte-pr-7","issue":0,"pr":7,"taggedAt":"${ at }"}`);
  assert.equal(capturedTag(null, 'lte-pr-7', numbersIn('lte-pr-7'), at), `{"workspace":"lte-pr-7","issue":0,"pr":7,"capturedAt":"${ at }"}`);
  assert.equal(capturedTag('{"issue":9}\n', 'x', numbersIn('x'), at), `{"issue":9,"capturedAt":"${ at }"}`);
});

test('timing: jittered around ten minutes, and the first run waits', () => {
  assert.ok(Math.abs(nextSweepDelay(() => 0) - (SWEEP_EVERY_MS * 0.8)) < 1);
  assert.ok(Math.abs(nextSweepDelay(() => 1) - (SWEEP_EVERY_MS * 1.2)) < 1);
  assert.equal(firstSweepDelay(() => 0), SWEEP_FIRST_MS);
  assert.ok(firstSweepDelay(() => 0) >= 60_000);
});

test('single flight: a sweep called during a sweep does nothing', async() => {
  let runs = 0;
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const once = singleFlight(async() => {
    runs += 1;
    await held;

    return 'done';
  });
  const first = once();

  assert.equal(await once(), false);
  release();
  assert.equal(await first, 'done');
  assert.equal(runs, 1);
  assert.equal(await once(), 'done');
});

test('single flight: a sweep that throws does not stop the next one', async() => {
  let n = 0;
  const once = singleFlight(async() => {
    n += 1;
    if (n === 1) {
      throw new Error('boom');
    }

    return n;
  });

  await assert.rejects(once());
  assert.equal(await once(), 2);
});

test('the browser: at most once per half hour, whatever the last answer was', () => {
  assert.equal(browserFallbackDue(0, NOW), true);
  assert.equal(browserFallbackDue(NOW, NOW), false);
  assert.equal(browserFallbackDue(NOW - BROWSER_FALLBACK_EVERY_MS + 1, NOW), false);
  assert.equal(browserFallbackDue(NOW - BROWSER_FALLBACK_EVERY_MS, NOW), true);
  assert.equal(browserFallbackDue(NaN, NOW), true);
});

test('the page no longer does this on a refresh', () => {
  const sidebar = fs.readFileSync(path.join(here, '..', 'components', 'DevSidebar.vue'), 'utf8');
  const api = fs.readFileSync(path.join(here, '..', 'api.ts'), 'utf8');

  assert.doesNotMatch(sidebar, /pruneWorkspaceTrees|tagWorkspaceArtifacts|pruneModuleTemplates/);
  assert.doesNotMatch(api, /pruneWorkspaceTrees/);
});

test('the wiring: dev-api really sweeps, and a page really waits and really listens', () => {
  const server = fs.readFileSync(path.join(here, '..', 'dev-api', 'server.mjs'), 'utf8');
  const api = fs.readFileSync(path.join(here, '..', 'api.ts'), 'utf8');
  const fallback = api.slice(api.indexOf('export async function runHousekeepingFallback'));

  // Advertising housekeeping with nothing sweeping would leave the work to nobody.
  assert.match(server.slice(server.indexOf('server.listen(PORT')), /scheduleHousekeeping\(firstSweepDelay\(\)\)/);
  assert.match(server, /sweepsAreWorking\(lastHousekeeping\)/);
  // Without the clock this is a request per refresh; without the answer, the exec work in every tab.
  assert.match(fallback, /!browserFallbackDue\(lastHousekeepingAsk\(\), now\)/);
  assert.match(fallback, /answer\?\.housekeeping === true/);
});

test('the wiring: a workspace on another cluster is still tagged, and only such a one', () => {
  const api = fs.readFileSync(path.join(here, '..', 'api.ts'), 'utf8');
  const fallback = api.slice(api.indexOf('export async function runHousekeepingFallback'));

  assert.match(fallback.slice(0, fallback.indexOf('note(')), /tagWorkspaceArtifacts\(workspaces\.filter\(\(w\) => \(w\.cluster \|\| DEFAULT_CLUSTER\) !== DEFAULT_CLUSTER\)\)/);
});

test('the wiring: reads that were given up on stay given up on', () => {
  const tools = fs.readFileSync(path.join(here, '..', 'workspace-tools.ts'), 'utf8');
  const agent = fs.readFileSync(path.join(here, '..', 'agent.ts'), 'utf8');

  assert.match(tools, /held && Date\.now\(\) - held\.at < DEV_SERVER_FRESH_MS/);
  assert.match(agent, /podStateText\(pod, '\/origins'\)/);
});

for (const script of ['gen-dev-api.mjs', 'gen-seed.mjs']) {
  test(`${ script }: what is committed is what the generator writes`, () => {
    const check = spawnSync(process.execPath, [path.join(here, '..', '..', '..', 'scripts', script), '--check']);

    assert.equal(check.status, 0, `run node scripts/${ script }`);
  });
}

test('what a page is told: a sweep that could not run is no reason to leave it the work', () => {
  assert.equal(sweepsAreWorking(null), true, 'before the first sweep');
  assert.equal(sweepsAreWorking({ skipped: '' }), true);
  assert.equal(sweepsAreWorking({ skipped: 'registrar' }), true, 'tags and templates still happened');
  assert.equal(sweepsAreWorking({ skipped: 'installations' }), false);
  assert.equal(sweepsAreWorking({ skipped: 'disk' }), false);
});

test('the generated server inlined everything it imports', () => {
  const generated = fs.readFileSync(path.join(here, '..', 'dev-api.generated.ts'), 'utf8');
  const source = JSON.parse(generated.slice(generated.indexOf('= "') + 2, generated.lastIndexOf('";') + 1));

  assert.match(source, /function sweepHousekeeping/);
  assert.match(source, /function numbersIn/);
  assert.doesNotMatch(source, /^import .* from '\.\.?\//m);

  // Everything inlined shares one scope, so a name two of them declare would stop the pod starting.
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'generated-')), 'server.mjs');

  fs.writeFileSync(file, source);
  const check = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });

  fs.rmSync(path.dirname(file), { recursive: true, force: true });
  assert.equal(check.status, 0, check.stderr);
});

// -- The whole sweep, on a real disk ----------------------------------------------------------

const run = (cmd, args) => new Promise((resolve) => {
  spawn(cmd, args, { stdio: 'ignore' }).on('close', (code) => resolve(code)).on('error', () => resolve(1));
});

function rig(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'housekeeping-'));
  const root = path.join(base, 'root');

  fs.mkdirSync(root);
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));

  /*
   * Nothing can set a ctime back, and utimes moves it to now. So a directory made by `tree` is
   * reported with its ctime equal to its mtime, as a tree left alone for that long would be, and
   * the test that is about ctime goes round this with a real rename onto the real disk.
   */
  const aged = new Set();
  const aging = Object.create(fs.promises);

  aging.lstat = async(file) => {
    const seen = await fs.promises.lstat(file);

    if (aged.has(file)) {
      seen.ctimeMs = seen.mtimeMs;
    }

    return seen;
  };
  const agingFs = Object.create(fs, { promises: { value: aging } });

  const tree = (name, ageMs = TREE_AGE_FLOOR_MS + 60_000) => {
    const at = path.join(root, name);

    fs.mkdirSync(at, { recursive: true });
    fs.writeFileSync(path.join(at, 'file'), 'x');
    const when = (Date.now() - ageMs) / 1000;

    fs.utimesSync(at, when, when);
    aged.add(at);

    return at;
  };

  const deps = {
    fs:   agingFs,
    path,
    root,
    numbersIn,
    run,
    now:           Date.now,
    listInstances: async() => instances(),
    readRegistrar: async() => ({ at: new Date().toISOString(), workspaces: [{ name: 'kept' }] }),
    readNamespace: async() => {
      throw gone();
    },
    readInstance: async() => {
      throw gone();
    },
  };

  return {
    base, root, tree, deps
  };
}

const exists = (p) => fs.existsSync(p);

test('sweep: a tree with nothing behind it goes, and its artifacts are kept first', async(t) => {
  const { root, tree, deps } = rig(t);

  tree('kept');
  const old = tree('lte-pr-7');

  fs.mkdirSync(path.join(old, 'artifacts'));
  fs.writeFileSync(path.join(old, 'artifacts', 'clip.webm'), 'video');
  const when = (Date.now() - TREE_AGE_FLOOR_MS - 60_000) / 1000;

  fs.utimesSync(old, when, when);

  const report = await sweepHousekeeping(deps);

  assert.deepEqual(report.trees, ['lte-pr-7']);
  assert.equal(exists(old), false);
  assert.equal(exists(path.join(root, 'kept')), true);
  assert.equal(fs.readFileSync(path.join(root, '.artifacts', 'lte-pr-7', 'clip.webm'), 'utf8'), 'video');
  const tag = JSON.parse(fs.readFileSync(path.join(root, '.artifacts', 'lte-pr-7', '.set.json'), 'utf8'));

  assert.equal(tag.pr, 7);
  assert.ok(tag.capturedAt);
});

for (const [why, change] of [
  ['the namespace still stands', { readNamespace: async() => ({ metadata: { name: 'dev-old' } }) }],
  ['the namespace read fails', {
    readNamespace: async() => {
      throw Object.assign(new Error('blip'), { status: 503 });
    }
  }],
  ['the Installation still stands', { readInstance: async() => ({ metadata: { name: 'old' } }) }],
]) {
  test(`sweep: nothing goes when ${ why }`, async(t) => {
    const { tree, deps } = rig(t);
    const old = tree('old');
    const report = await sweepHousekeeping({ ...deps, ...change });

    assert.deepEqual(report.trees, []);
    assert.deepEqual(report.kept, ['old']);
    assert.equal(exists(old), true);
  });
}

for (const [why, change] of [
  ['the Installations cannot be read', { listInstances: async() => null }],
  ['the Installations read throws', {
    listInstances: async() => {
      throw new Error('blip');
    }
  }],
]) {
  test(`sweep: no tree and no template goes when ${ why }`, async(t) => {
    const { root, tree, deps } = rig(t);
    const old = tree('old');

    for (const name of ['t1', 't2', 't3', 't4', 't5']) {
      fs.mkdirSync(path.join(root, '.shared', 'template', name), { recursive: true });
    }
    const report = await sweepHousekeeping({ ...deps, ...change });

    assert.equal(report.skipped, 'installations');
    assert.equal(sweepsAreWorking(report), false, 'so a page does the trimming');
    assert.equal(exists(old), true);
    assert.equal(fs.readdirSync(path.join(root, '.shared', 'template')).length, 5);
  });
}

for (const [why, change] of [
  ['the workspace list is empty', { readRegistrar: async() => ({ at: new Date().toISOString(), workspaces: [] }) }],
  ['the registrar read fails', {
    readRegistrar: async() => {
      throw new Error('blip');
    }
  }],
  ['the registrar is stale', { readRegistrar: async() => ({ at: new Date(Date.now() - REGISTRAR_TRUSTED_MS - 1000).toISOString(), workspaces: [{ name: 'kept' }] }) }],
]) {
  test(`sweep: no tree goes when ${ why }, and templates are still trimmed`, async(t) => {
    const { root, tree, deps } = rig(t);
    const old = tree('old');

    for (const [i, name] of ['t1', 't2', 't3', 't4', 't5'].entries()) {
      const at = path.join(root, '.shared', 'template', name);
      const when = (Date.now() - (i * 60_000)) / 1000;

      fs.mkdirSync(at, { recursive: true });
      fs.utimesSync(at, when, when);
    }
    const report = await sweepHousekeeping({ ...deps, ...change });

    assert.equal(report.skipped, 'registrar');
    assert.equal(exists(old), true);
    assert.deepEqual(report.trees, []);
    assert.deepEqual(fs.readdirSync(path.join(root, '.shared', 'template')).sort(), ['t1', 't2', 't3']);
  });
}

test('sweep: a mistake is bounded, and a tree that is kept does not use up the bound', async(t) => {
  const { tree, deps } = rig(t);

  ['aa-held', 'ab-held', 'ac-held', 'ad-held', 'w1', 'w2', 'w3', 'w4', 'w5'].forEach((name) => tree(name));
  const report = await sweepHousekeeping({
    ...deps,
    readNamespace: async(name) => {
      if (name.endsWith('-held')) {
        return { metadata: { name } };
      }
      throw gone();
    },
  });

  assert.deepEqual(report.trees, ['w1', 'w2', 'w3'].slice(0, TREES_PER_SWEEP));
});

test('sweep: a missing root removes nothing and does not throw', async(t) => {
  const { base, deps } = rig(t);
  const report = await sweepHousekeeping({ ...deps, root: path.join(base, 'nowhere') });

  assert.equal(report.skipped, 'disk');
});

test('sweep: a symlink in the root is not followed, and what it points at survives', async(t) => {
  const { base, root, deps } = rig(t);
  const outside = path.join(base, 'outside');

  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'precious'), 'x');
  fs.symlinkSync(outside, path.join(root, 'alink'));
  const report = await sweepHousekeeping(deps);

  assert.deepEqual(report.trees, []);
  assert.equal(exists(path.join(outside, 'precious')), true);
  assert.equal(exists(path.join(root, 'alink')), true);
});

test('sweep: a symlink inside a removed tree is removed, not followed', async(t) => {
  const { base, tree, deps } = rig(t);
  const outside = path.join(base, 'outside');

  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'precious'), 'x');
  const old = tree('old');

  fs.symlinkSync(outside, path.join(old, 'artifacts'));
  fs.symlinkSync(outside, path.join(old, 'escape'));
  const when = (Date.now() - TREE_AGE_FLOOR_MS - 60_000) / 1000;

  fs.utimesSync(old, when, when);
  const report = await sweepHousekeeping(deps);

  assert.deepEqual(report.trees, ['old']);
  assert.equal(exists(path.join(outside, 'precious')), true);
});

test('sweep: a tree moved into the root is not old, whatever mtime it brought', async(t) => {
  const { base, root, deps } = rig(t);
  const away = path.join(base, 'lte-pr-7');

  // A real rename on the real disk, with nothing in the way of the kernel's ctime.
  fs.mkdirSync(path.join(away, 'dashboard'), { recursive: true });
  fs.writeFileSync(path.join(away, 'dashboard', 'uncommitted'), 'work');
  const when = (Date.now() - TREE_AGE_FLOOR_MS - 60_000) / 1000;

  fs.utimesSync(away, when, when);
  fs.renameSync(away, path.join(root, 'lte-pr-7'));
  assert.ok(Date.now() - fs.lstatSync(path.join(root, 'lte-pr-7')).mtimeMs > TREE_AGE_FLOOR_MS, 'the mtime came with it');

  const report = await sweepHousekeeping({ ...deps, fs });

  assert.deepEqual(report.trees, []);
  assert.equal(fs.readFileSync(path.join(root, 'lte-pr-7', 'dashboard', 'uncommitted'), 'utf8'), 'work');

  // And the floor is all that kept it: an hour on, nothing has touched it and it goes.
  const later = () => Date.now() + TREE_AGE_FLOOR_MS + 60_000;
  const after = await sweepHousekeeping({
    ...deps,
    fs,
    now:           later,
    readRegistrar: async() => ({ at: new Date(later()).toISOString(), workspaces: [{ name: 'kept' }] }),
  });

  assert.deepEqual(after.trees, ['lte-pr-7']);
});

/** A tree the sweep will take, with `artifacts` made by `build`. */
function candidate(tree, name, build) {
  const old = tree(name);

  build(old);
  const when = (Date.now() - TREE_AGE_FLOOR_MS - 60_000) / 1000;

  fs.utimesSync(old, when, when);

  return old;
}

test('sweep: artifacts that are a link inside the tree are kept before the tree goes', async(t) => {
  const { root, tree, deps } = rig(t);
  const old = candidate(tree, 'lte-pr-8', (at) => {
    fs.mkdirSync(path.join(at, 'dashboard', 'out'), { recursive: true });
    fs.writeFileSync(path.join(at, 'dashboard', 'out', 'clip.webm'), 'video');
    fs.symlinkSync('dashboard/out', path.join(at, 'artifacts'));
  });
  const report = await sweepHousekeeping(deps);

  assert.deepEqual(report.trees, ['lte-pr-8']);
  assert.equal(exists(old), false);
  assert.equal(fs.readFileSync(path.join(root, '.artifacts', 'lte-pr-8', 'clip.webm'), 'utf8'), 'video');
});

for (const [why, target] of [
  ['resolves to nothing here, and may mean something in the pod that wrote it', '/workspaces/lte-pr-9/dashboard/out'],
  ['is the whole tree', '.'],
]) {
  test(`sweep: a tree whose artifacts link ${ why } is kept`, async(t) => {
    const { root, tree, deps } = rig(t);
    const old = candidate(tree, 'lte-pr-9', (at) => fs.symlinkSync(target, path.join(at, 'artifacts')));
    const report = await sweepHousekeeping(deps);

    assert.deepEqual(report.trees, []);
    assert.ok(report.errors.some((e) => e.includes('capture')));
    assert.equal(exists(old), true);
    assert.equal(exists(path.join(root, '.artifacts', 'lte-pr-9')), false);
  });
}

test('sweep: artifacts that link out of the tree are not copied in', async(t) => {
  const { base, root, tree, deps } = rig(t);
  const secret = path.join(base, 'secrets');

  fs.mkdirSync(secret);
  fs.writeFileSync(path.join(secret, 'token'), 'hunter2');
  candidate(tree, 'lte-pr-9', (at) => fs.symlinkSync(secret, path.join(at, 'artifacts')));
  const report = await sweepHousekeeping(deps);

  assert.deepEqual(report.trees, ['lte-pr-9']);
  assert.equal(exists(path.join(root, '.artifacts', 'lte-pr-9', 'token')), false);
  assert.equal(fs.readFileSync(path.join(secret, 'token'), 'utf8'), 'hunter2');
});

test('sweep: a tag that is a link is not read into the store', async(t) => {
  const { base, root, tree, deps } = rig(t);
  const secret = path.join(base, 'token');

  fs.writeFileSync(secret, 'hunter2');
  candidate(tree, 'gone-a', (at) => {
    fs.mkdirSync(path.join(at, 'artifacts'));
    fs.writeFileSync(path.join(at, 'artifacts', 'clip'), 'x');
    fs.symlinkSync(secret, path.join(at, 'artifacts', '.set.json'));
  });
  const report = await sweepHousekeeping(deps);
  const tag = path.join(root, '.artifacts', 'gone-a', '.set.json');

  assert.deepEqual(report.trees, ['gone-a']);
  assert.equal(fs.lstatSync(tag).isFile(), true);
  assert.doesNotMatch(fs.readFileSync(tag, 'utf8'), /hunter2/);
  assert.equal(JSON.parse(fs.readFileSync(tag, 'utf8')).workspace, 'gone-a');
  assert.equal(fs.readFileSync(secret, 'utf8'), 'hunter2');
});

test('sweep: a tag\'s temporary name that is a link is not written through', async(t) => {
  const { base, root, tree, deps } = rig(t);
  const victim = path.join(base, 'victim');

  fs.writeFileSync(victim, 'untouched');
  candidate(tree, 'gone-b', (at) => {
    fs.mkdirSync(path.join(at, 'artifacts'));
    fs.writeFileSync(path.join(at, 'artifacts', '.set.json'), '{"workspace":"chosen"}');
    fs.symlinkSync(victim, path.join(at, 'artifacts', '.set.json.new'));
  });
  const report = await sweepHousekeeping(deps);

  assert.deepEqual(report.trees, ['gone-b']);
  assert.equal(fs.readFileSync(victim, 'utf8'), 'untouched');
  assert.equal(exists(path.join(root, '.artifacts', 'gone-b', '.set.json.new')), false);
  assert.equal(fs.lstatSync(path.join(root, '.artifacts', 'gone-b', '.set.json')).isFile(), true);
});

test('sweep: a fifo where the tag should be cannot hang the sweep', async(t) => {
  const { root, tree, deps } = rig(t);

  candidate(tree, 'gone-c', (at) => {
    fs.mkdirSync(path.join(at, 'artifacts'));
    fs.writeFileSync(path.join(at, 'artifacts', 'clip'), 'x');
    spawnSync('mkfifo', [path.join(at, 'artifacts', '.set.json')]);
  });
  const report = await sweepHousekeeping(deps);

  assert.deepEqual(report.trees, ['gone-c']);
  assert.equal(fs.lstatSync(path.join(root, '.artifacts', 'gone-c', '.set.json')).isFile(), true);
});

test('sweep: a store entry that is a link keeps the tree and copies nothing through it', async(t) => {
  const { base, root, tree, deps } = rig(t);
  const elsewhere = path.join(base, 'elsewhere');

  fs.mkdirSync(elsewhere);
  fs.mkdirSync(path.join(root, '.artifacts'));
  fs.symlinkSync(elsewhere, path.join(root, '.artifacts', 'gone-d'));
  const old = candidate(tree, 'gone-d', (at) => {
    fs.mkdirSync(path.join(at, 'artifacts'));
    fs.writeFileSync(path.join(at, 'artifacts', 'clip'), 'x');
  });
  const report = await sweepHousekeeping(deps);

  assert.deepEqual(report.trees, []);
  assert.equal(exists(old), true);
  assert.deepEqual(fs.readdirSync(elsewhere), []);
});

test('sweep: a capture that fails keeps the tree', async(t) => {
  const { tree, deps } = rig(t);
  const old = tree('old');

  fs.mkdirSync(path.join(old, 'artifacts'));
  fs.writeFileSync(path.join(old, 'artifacts', 'clip'), 'x');
  const when = (Date.now() - TREE_AGE_FLOOR_MS - 60_000) / 1000;

  fs.utimesSync(old, when, when);
  const report = await sweepHousekeeping({ ...deps, run: async() => 1 });

  assert.deepEqual(report.trees, []);
  assert.equal(exists(old), true);
  assert.ok(report.errors.some((e) => e.includes('capture')));
});

test('sweep: templates past the newest three go, only inside the directory', async(t) => {
  const { root, deps } = rig(t);
  const dirOf = path.join(root, '.shared', 'template');

  ['a', 'b', 'c', 'd', 'e'].forEach((name, i) => {
    const at = path.join(dirOf, name);

    fs.mkdirSync(at, { recursive: true });
    const when = (Date.now() - ((10 - i) * 60_000)) / 1000;

    fs.utimesSync(at, when, when);
  });
  fs.mkdirSync(path.join(dirOf, '.hidden'));
  const report = await sweepHousekeeping(deps);

  assert.deepEqual(report.templates.sort(), ['a', 'b']);
  assert.deepEqual(fs.readdirSync(dirOf).sort(), ['.hidden', 'c', 'd', 'e']);
  assert.equal(exists(path.join(root, '.shared')), true);
});

test('sweep: a template directory that is a symlink out of the root is left alone', async(t) => {
  const { base, root, deps } = rig(t);
  const outside = path.join(base, 'elsewhere');

  ['a', 'b', 'c', 'd', 'e'].forEach((name) => fs.mkdirSync(path.join(outside, name), { recursive: true }));
  fs.mkdirSync(path.join(root, '.shared'));
  fs.symlinkSync(outside, path.join(root, '.shared', 'template'));
  const report = await sweepHousekeeping(deps);

  assert.deepEqual(report.templates, []);
  assert.equal(fs.readdirSync(outside).length, 5);
});

test('sweep: no template directory is what a failed cd was: nothing happens', async(t) => {
  const { deps } = rig(t);
  const report = await sweepHousekeeping(deps);

  assert.deepEqual(report.templates, []);
  assert.deepEqual(report.errors, []);
});

test('sweep: tags what has none, the browser\'s tag exactly, and never rewrites one', async(t) => {
  const { root, tree, deps } = rig(t);
  const fresh = tree('lte-issue-14904', 1000);
  const done = tree('lte-pr-9', 1000);

  tree('no-artifacts', 1000);
  fs.mkdirSync(path.join(fresh, 'artifacts'));
  fs.mkdirSync(path.join(done, 'artifacts'));
  const edited = '{"workspace":"lte-pr-9","issue":19517,"pr":0}';

  fs.writeFileSync(path.join(done, 'artifacts', '.set.json'), edited);

  const report = await sweepHousekeeping(deps);
  const tag = JSON.parse(fs.readFileSync(path.join(fresh, 'artifacts', '.set.json'), 'utf8'));

  assert.equal(report.tagged, 1);
  assert.equal(tag.workspace, 'lte-issue-14904');
  assert.equal(tag.issue, 14904);
  assert.equal(tag.pr, 0);
  assert.ok(tag.taggedAt);
  assert.equal(fs.readFileSync(path.join(done, 'artifacts', '.set.json'), 'utf8'), edited);
  assert.equal(exists(path.join(root, 'no-artifacts', 'artifacts')), false);

  const again = await sweepHousekeeping(deps);

  assert.equal(again.tagged, 0);
  assert.deepEqual(again.errors, []);
});

test('sweep: tags are written even when deleting is off, because a tag deletes nothing', async(t) => {
  const { tree, deps } = rig(t);
  const fresh = tree('lte-pr-5', 1000);

  fs.mkdirSync(path.join(fresh, 'artifacts'));
  const report = await sweepHousekeeping({ ...deps, readRegistrar: async() => null });

  assert.equal(report.skipped, 'registrar');
  assert.equal(report.tagged, 1);
});

test('sweep: a tag does not write through a symlinked artifacts directory', async(t) => {
  const { base, tree, deps } = rig(t);
  const outside = path.join(base, 'outside');

  fs.mkdirSync(outside);
  const fresh = tree('lte-pr-5', 1000);

  fs.symlinkSync(outside, path.join(fresh, 'artifacts'));
  await sweepHousekeeping(deps);
  assert.deepEqual(fs.readdirSync(outside), []);
});
