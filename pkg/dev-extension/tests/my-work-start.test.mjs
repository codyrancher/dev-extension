// My Work's Start workspace buttons: each one names the workspace and hands over its row, whose
// repository is the one the workspace clones. The tracker's passed the row as the name, and none
// passed a repository, so a rancher/security-ui-exts row got a rancher/dashboard checkout.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const page = fs.readFileSync(new URL('../pages/MyWork.vue', import.meta.url), 'utf8');

test('every Start workspace on My Work passes a name and its row', () => {
  const calls = page.split('\n')
    .map((line) => /@click="\(done\) => startWorkspace\((.*), (\w+), done\)"/.exec(line) || (/startWorkspace\(/.test(line) && /@click/.test(line) ? [line] : null))
    .filter(Boolean);

  assert.equal(calls.length, 4, 'Reviewing, My PRs, Issues and Tracker');
  for (const [line, name, row] of calls) {
    assert.ok(name, `not (name, row, done): ${ line.trim() }`);
    assert.notEqual(name, 'row', `the row is not a name: ${ line.trim() }`);
    assert.equal(row, 'row', line.trim());
  }
});

test('Start workspace creates through ensureWorkspace with the row\'s repository', () => {
  const method = page.slice(page.indexOf('async startWorkspace('), page.indexOf('async startWorkspace(') + 600);

  assert.match(method, /ensureWorkspace\(this\.\$store, name, row\.title \|\| '', row\.repo \|\| this\.repo\)/);
  assert.doesNotMatch(method, /createWorkspace\(/);
});
