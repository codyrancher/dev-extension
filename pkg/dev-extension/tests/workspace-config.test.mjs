// The wrapper vue.config.js a workspace's dev server runs with, loaded the way vue-cli loads it:
// required from the checkout's directory, and called when it is a function. A checkout whose own
// config is a function (the extension template's shape, rancher/security-ui-exts) lost every
// override, and its dev server answered "Invalid Host header" behind the proxy.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { WORKSPACE_VUE_CONFIG } from '../workspace-config.ts';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-config-'));
const wrapper = path.join(root, 'config', 'vue.config.js');

fs.mkdirSync(path.dirname(wrapper));
fs.writeFileSync(wrapper, WORKSPACE_VUE_CONFIG);
fs.writeFileSync(path.join(root, 'config', 'package.json'), '{"name": "dev-workspace-config", "private": true}');
after(() => fs.rmSync(root, { recursive: true, force: true }));

/** What vue-cli ends up with for a checkout whose own vue.config.js is `source`. */
function resolved(name, source) {
  const checkout = path.join(root, name);

  fs.mkdirSync(checkout);
  fs.writeFileSync(path.join(checkout, 'vue.config.js'), source);
  const run = spawnSync(process.execPath, ['-e', `
    const loaded = require(${ JSON.stringify(wrapper) });
    const config = typeof loaded === 'function' ? loaded() : loaded;
    const calls = [];
    const chain = { plugin: () => ({ tap: (fn) => calls.push(fn([{}])[0].publicPath) }) };

    if (typeof config.chainWebpack === 'function') config.chainWebpack(chain);
    console.log(JSON.stringify({ ...config, chainWebpack: undefined, chained: calls, own: global.chainedByRepo || false }));
  `], { cwd: checkout, encoding: 'utf8', env: { ...process.env, DEV_PROXY_PATH: '' } });

  assert.equal(run.status, 0, run.stderr);

  return JSON.parse(run.stdout);
}

const checks = (config) => {
  assert.equal(config.publicPath, 'auto');
  assert.equal(config.devServer.allowedHosts, 'all');
  assert.equal(config.devServer.compress, false);
  assert.deepEqual(config.chained, ['/']);
};

test('a checkout whose vue.config.js is an object keeps it, with the overrides on top', () => {
  const config = resolved('object', `module.exports = {
    devServer: { port: 8005, allowedHosts: ['localhost'] },
    chainWebpack: () => { global.chainedByRepo = true; },
    transpileDependencies: ['shell'],
  };`);

  checks(config);
  assert.equal(config.devServer.port, 8005);
  assert.deepEqual(config.transpileDependencies, ['shell']);
  assert.equal(config.own, true);
});

test('a checkout whose vue.config.js is a function is called, and gets the overrides', () => {
  const config = resolved('function', `module.exports = () => ({
    devServer: { port: 8005, allowedHosts: ['localhost'] },
    chainWebpack: () => { global.chainedByRepo = true; },
    transpileDependencies: ['shell'],
  });`);

  checks(config);
  assert.equal(config.devServer.port, 8005);
  assert.deepEqual(config.transpileDependencies, ['shell']);
  assert.equal(config.own, true);
});
