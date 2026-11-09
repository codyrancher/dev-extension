// Which repository a workspace's GitHub reads go to. A page loaded straight onto lte-pr-850
// (rancher/security-ui-exts) read before the sidebar had noted anything, asked rancher/dashboard
// about #850 - merged there - and stored the workspace as Merged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { noteRepo, notedRepo } from '../workspace-repos.mjs';

const source = (file) => fs.readFileSync(new URL(`../${ file }`, import.meta.url), 'utf8');

test('a reader that does not know the repository does not erase one that is known', () => {
  assert.equal(notedRepo('lte-pr-850'), '');

  // The page, from the Installation, before its first read.
  noteRepo('lte-pr-850', 'rancher/security-ui-exts');
  assert.equal(notedRepo('lte-pr-850'), 'rancher/security-ui-exts');

  // Then a list entry with no repo, which is what workspaceStatuses passed as ''.
  noteRepo('lte-pr-850', '');
  noteRepo('lte-pr-850', undefined);
  noteRepo('lte-pr-850', '  ');
  assert.equal(notedRepo('lte-pr-850'), 'rancher/security-ui-exts');

  noteRepo('lte-pr-1227', ' harvester/harvester-ui-extension ');
  assert.equal(notedRepo('lte-pr-1227'), 'harvester/harvester-ui-extension');
  assert.equal(notedRepo('lte-pr-850'), 'rancher/security-ui-exts');
  noteRepo('', 'rancher/dashboard');
  assert.equal(notedRepo(''), '');
});

test('repoOf reads the shared memo, and the sidebar still notes into it', () => {
  const status = source('workspace-status.ts');

  assert.match(status, /import \{ noteRepo, notedRepo \} from '\.\/workspace-repos\.mjs';/);
  assert.match(status, /export function repoOf\(name: string\): string \{\s+return notedRepo\(name\) \|\| DEFAULT_REPO;/);
  assert.match(status, /noteRepo\(w\.name, w\.repo \|\| ''\);/);
  assert.doesNotMatch(status, /const repos: Record/);
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
