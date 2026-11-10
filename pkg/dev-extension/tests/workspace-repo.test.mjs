// Which repository a workspace's GitHub reads go to, and which stored stage counts as its own. A
// tab that read lte-pr-850 (rancher/security-ui-exts) before anything had noted its repository
// asked rancher/dashboard about #850 - merged there - and stored the workspace as Merged.
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  noteRepo, notedRepo, resolveRepo, readFrom, forgetRepos
} from '../workspace-repos.mjs';

const source = (file) => fs.readFileSync(new URL(`../${ file }`, import.meta.url), 'utf8');
const DASHBOARD = 'rancher/dashboard';

/** A lookup that answers from `repos`, counting how often it is asked. */
function installations(repos) {
  const lookup = async() => {
    lookup.calls++;

    return repos === null ? null : new Map(Object.entries(repos));
  };

  lookup.calls = 0;

  return lookup;
}

beforeEach(() => forgetRepos());

test('a reader that does not know the repository does not erase one that is known', () => {
  noteRepo('lte-pr-850', 'rancher/security-ui-exts');
  noteRepo('lte-pr-850', '');
  noteRepo('lte-pr-850', undefined);
  noteRepo('lte-pr-850', '  ');
  assert.equal(notedRepo('lte-pr-850'), 'rancher/security-ui-exts');

  noteRepo('lte-pr-1227', ' harvester/harvester-ui-extension ');
  assert.equal(notedRepo('lte-pr-1227'), 'harvester/harvester-ui-extension');
  noteRepo('', DASHBOARD);
  assert.equal(notedRepo(''), '');
});

test('with nothing noted, the repository comes from the workspace\'s own record, asked once', async() => {
  const lookup = installations({ 'lte-pr-850': 'rancher/security-ui-exts', 'lte-pr-19811': '' });
  const [a, b] = await Promise.all([resolveRepo('lte-pr-850', lookup), resolveRepo('lte-pr-850', lookup)]);

  assert.equal(a, 'rancher/security-ui-exts');
  assert.equal(b, 'rancher/security-ui-exts');
  assert.equal(lookup.calls, 1, 'one lookup for every caller waiting on it');

  // The same answer named every workspace: a record with no repo is the default from then on.
  assert.equal(await resolveRepo('lte-pr-19811', lookup), '');
  assert.equal(await resolveRepo('lte-pr-850', lookup), 'rancher/security-ui-exts');
  assert.equal(lookup.calls, 1);
});

test('something noted is not looked up', async() => {
  const lookup = installations({ 'lte-pr-850': DASHBOARD });

  noteRepo('lte-pr-850', 'rancher/security-ui-exts');
  assert.equal(await resolveRepo('lte-pr-850', lookup), 'rancher/security-ui-exts');
  assert.equal(lookup.calls, 0);
});

test('a lookup that fails decides nothing, and the next read asks again', async() => {
  assert.equal(await resolveRepo('lte-pr-850', installations(null)), '');
  assert.equal(await resolveRepo('lte-pr-850', async() => { throw new Error('401'); }), '');

  const lookup = installations({ 'lte-pr-850': 'rancher/security-ui-exts' });

  assert.equal(await resolveRepo('lte-pr-850', lookup), 'rancher/security-ui-exts');
  assert.equal(lookup.calls, 1);
});

test('a workspace the lookup does not list is asked about again a minute later, not every read', async() => {
  const lookup = installations({});
  const t = 1_800_000_000_000;

  assert.equal(await resolveRepo('lte-pr-9', lookup, t), '');
  assert.equal(await resolveRepo('lte-pr-9', lookup, t + 30_000), '');
  assert.equal(lookup.calls, 1);
  assert.equal(await resolveRepo('lte-pr-9', lookup, t + 61_000), '');
  assert.equal(lookup.calls, 2);
});

test('a stored stage counts only for the repository it was read from', () => {
  // The record lte-pr-850 got: rancher/dashboard#850, merged.
  assert.equal(readFrom({ stage: 'approved', repo: DASHBOARD }, 'rancher/security-ui-exts', DASHBOARD), false);
  assert.equal(readFrom({ stage: 'agent', repo: 'rancher/security-ui-exts' }, 'rancher/security-ui-exts', DASHBOARD), true);
  // From before records said: every one of those was read from rancher/dashboard.
  assert.equal(readFrom({ stage: 'approved' }, DASHBOARD, DASHBOARD), true);
  assert.equal(readFrom({ stage: 'approved' }, '', DASHBOARD), true);
  assert.equal(readFrom({ stage: 'approved' }, 'rancher/security-ui-exts', DASHBOARD), false);
  assert.equal(readFrom(undefined, DASHBOARD, DASHBOARD), true);
});

test('the stage store keeps the repository and ignores a record from another', () => {
  // The rules are stage-derive.mjs's now, shared with dev-api; stages.ts hands them the default.
  const derive = source('stage-derive.mjs');
  const stages = source('stages.ts');
  const reconcile = stages.slice(stages.indexOf('export async function reconcileStage('), stages.indexOf('/** The person sets the stage'));

  assert.match(derive, /export function recordOf\([^)]*\) \{\s+return \{[^}]*repo: d\.repo \|\| fallbackRepo/);
  assert.match(derive, /const stored = stored0 && readFrom\(stored0, d\.repo, fallbackRepo\) \? stored0 : undefined;/);
  assert.match(reconcile, /reconcileRecord\(cache\[name\], d, \{ now: [^}]*fallbackRepo: DEFAULT_REPO \}\)/);
  assert.match(stages, /export async function setManualStage\(name: string, stage: Stage, repo = DEFAULT_REPO\)/);
  assert.match(source('components/WorkspaceRail.vue'), /setManualStage\(this\.workspace\.name, key, this\.repo\)/);
});

test('every read that stores a stage knows the repository first', () => {
  const status = source('workspace-status.ts');
  const readWork = status.slice(status.indexOf('async function readWork('), status.indexOf('/** What the name alone says'));

  assert.match(status, /async function repoFor\(name: string\): Promise<string> \{\s+return \(await resolveRepo\(name, installationRepos\)\) \|\| DEFAULT_REPO;/);
  assert.match(readWork, /const repo = await repoFor\(name\);/);
  assert.doesNotMatch(readWork, /repoOf\(/);
  assert.ok(readWork.indexOf('await repoFor(name)') < readWork.indexOf('prDetail('));

  const calls = status.split('reconcileStage(name, toDerived(').length - 1;
  const withRepo = status.match(/reconcileStage\(name, toDerived\('(?:review|fix)', w, (?:pr|n|0), (?:repo|await repoFor\(name\))\)\)/g) || [];

  assert.equal(calls, 4);
  assert.equal(withRepo.length, calls, 'every derived stage carries the repository');
  assert.match(status, /noteRepo\(w\.name, w\.repo \|\| ''\);/);
  assert.match(status, /export function repoOf\(name: string\): string \{\s+return notedRepo\(name\) \|\| DEFAULT_REPO;/);
});

test('the rail notes its workspace\'s repository before it reads anything', () => {
  const rail = source('components/WorkspaceRail.vue');
  const load = rail.slice(rail.indexOf('    async load() {'), rail.indexOf('    async onBodyClick('));
  const noted = load.indexOf('noteRepo(this.workspace.name, this.workspace.repo);');

  assert.ok(noted > -1, 'load() notes the repo');
  for (const read of ['knownStatus(', 'this.refreshEvidence()', 'await this.refreshStatus()']) {
    assert.ok(noted < load.indexOf(read), `before ${ read }`);
  }
  assert.match(rail, /'workspace\.repo'\(repo\) \{\s+noteRepo\(this\.workspace\.name, repo\);/);
  assert.doesNotMatch(rail, /forgetPrDetail\(pr\)/);
  assert.ok(rail.includes('combinedFiles(item.pr, item.items.map((c) => c.sha), this.repo)'));
});

test('every GitHub read in the rail\'s evidence names a repository', () => {
  const reads = source('workspace-rail.ts');
  const calls = [...reads.matchAll(/\b(prDetail|ciFailures|commitsDiff)\(([^;]*?)\)\.(?:catch|then)/g)];

  assert.ok(calls.length >= 4, `found ${ calls.length }`);
  for (const [call, , args] of calls) {
    assert.match(args, /repoOf\(workspace\)|\brepo\b/, call);
  }
});
