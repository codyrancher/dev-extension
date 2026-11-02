// Prime images pull anonymously from both SUSE registries: their 401 names a token server that
// issues a pull token with no login. A Prime instance must not be refused for having no login.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (file) => fs.readFileSync(new URL(`../${ file }`, import.meta.url), 'utf8');

test('no login means an anonymous pull, and only half of one is refused', () => {
  const ranchers = read('ranchers.ts');
  const auth = ranchers.slice(ranchers.indexOf('export async function primeAuth'), ranchers.indexOf('export async function createRancherInstance'));

  assert.match(auth, /if \(!user && !password\) \{\s+return btoa\('\{\}'\);/);
  assert.ok(auth.indexOf('!user && !password') < auth.indexOf('Only half'), 'none is checked before half');
  assert.doesNotMatch(auth, /refuses an anonymous pull/);

  const ec2 = read('seed/agent/rancher-ec2.mjs');
  const login = ec2.slice(ec2.indexOf('function registryAuth'), ec2.indexOf('function registryAuth') + 1200);

  assert.match(login, /if \(!user && !password\) \{\s+return '';/);
});

test('nothing tells a person Prime needs a login any more', () => {
  // Not apps-rancher.ts: its old claim is inside the App's template, and changing a word there
  // re-renders every Rancher instance already running.
  for (const file of ['ranchers.ts', 'seed/agent/rancher-ec2.mjs', 'components/DevSidebar.vue', 'secrets.ts']) {
    assert.doesNotMatch(read(file), /refuses? an anonymous pull|Needs SUSE registry credentials|Prime images are pulled as you/, file);
  }
});
