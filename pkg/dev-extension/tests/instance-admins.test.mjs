// dev-system/dev-instance-admins becomes allow-list entries and admins of every new instance.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { rancherUserName, instanceAdminValues } from '../instance-admins.mjs';

test('a user is named the way Rancher names it on login', async() => {
  // u-ukjm7tnoza is the bootstrap's codyrancher; u-zjr6ohwgki was made by a GitHub login on otter.
  assert.equal(await rancherUserName('55104481'), 'u-ukjm7tnoza');
  assert.equal(await rancherUserName(233437), 'u-zjr6ohwgki');
});

test('each listed account is allowed in and made an admin', async() => {
  const values = await instanceAdminValues({ 'oboc-sts': '117346106' });

  assert.equal(values.adminPrincipals, '      - github_user://117346106 # oboc-sts');
  assert.match(values.adminUsers, /^ {4}---\n {4}apiVersion: management\.cattle\.io\/v3\n {4}kind: User\n {4}metadata:\n {6}name: u-zzgi63hdws\n/);
  assert.match(values.adminUsers, /\n {6}- local:\/\/u-zzgi63hdws\n/);
  assert.match(values.adminUsers, /\n {6}name: grb-admin-u-zzgi63hdws\n {4}globalRoleName: admin\n {4}userName: u-zzgi63hdws$/);
});

test('the App\'s own user, repeats and entries GitHub could not have are skipped', async() => {
  const values = await instanceAdminValues({
    codyrancher: '55104481', a: '1', b: ' 1 ', 'not a login': '2', c: 'abc', d: '',
  }, ['55104481']);

  assert.equal(values.adminPrincipals, '      - github_user://1 # a');
});

test('nobody listed leaves the App\'s defaults', async() => {
  assert.deepEqual(await instanceAdminValues(undefined), {});
  assert.deepEqual(await instanceAdminValues({ codyrancher: '55104481' }, ['55104481']), {});
});

test('the values are substituted on lines of their own and nowhere else', () => {
  const app = fs.readFileSync(new URL('../apps-rancher.ts', import.meta.url), 'utf8');

  for (const name of ['adminPrincipals', 'adminUsers']) {
    const uses = app.split('\n').filter((line) => line.includes(`\\\${${ name }}`));

    assert.deepEqual(uses, [`\\\${${ name }}`], name);
  }
});
