// Which repository a /my-work request is about, when the caller does not say.
//
// A skill in a workspace asks for `$CLAUDE_HARNESS_API/my-work/pr/<n>` with no `?repo=`. Before,
// that always meant rancher/dashboard, so a review in a rancher/virtual-clusters-ui workspace read
// rancher/dashboard's PR of the same number. server.mjs cannot be imported (it reads a service
// account token at load), so this takes `callerOf` and `repoOf` out of its source and runs them
// against a stubbed cluster - the code under test is the code that ships.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../dev-api/server.mjs', import.meta.url), 'utf8');

function slice(name) {
  const start = source.indexOf(`async function ${ name }(`);
  const end = source.indexOf('\n}\n', start);

  assert.ok(start >= 0 && end > start, `server.mjs has no ${ name }`);

  return source.slice(start, end + 2);
}

/** `repoOf` bound to a cluster where `pods` maps a pod IP to its namespace and `instances` a workspace to its Installation. */
function load({ pods = {}, instances = {}, ip = '' } = {}) {
  const reads = [];
  const k8s = async(path) => {
    reads.push(path);
    const byIp = /status\.podIP%3D([^&]+)/.exec(path);

    if (byIp) {
      const namespace = pods[decodeURIComponent(byIp[1])];

      return { items: namespace ? [{ metadata: { namespace } }] : [] };
    }
    const name = decodeURIComponent(path.split('/').pop());

    if (!instances[name]) {
      throw new Error('404');
    }

    return instances[name];
  };
  const callerRequest = { getStore: () => ({ socket: { remoteAddress: ip } }) };
  const make = new Function('k8s', 'INSTANCES', 'callerRequest', 'REPO_NAME', 'DEFAULT_REPO', 'callerByIp',
    `${ slice('callerOf') }\n${ slice('repoOf') }\nreturn repoOf;`);
  const repoOf = make(k8s, '/apis/dev.rancher.io/v1/installations', callerRequest, /^[\w.-]+\/[\w.-]+$/, 'rancher/dashboard', new Map());

  return { repoOf, reads };
}

const url = (query = '') => new URL(`http://dev-api/my-work/pr/222${ query }`);
const installation = (repo) => ({ metadata: { labels: { 'dev.rancher.io/owner': 'u' } }, spec: { values: repo ? { repo } : {} } });

test('?repo= wins, without asking the cluster', async() => {
  const { repoOf, reads } = load({ ip: '10.42.0.9', pods: { '10.42.0.9': 'dev-lte-pr-222' }, instances: { 'lte-pr-222': installation('rancher/virtual-clusters-ui') } });

  assert.equal(await repoOf(url('?repo=harvester/harvester-ui-extension')), 'harvester/harvester-ui-extension');
  assert.deepEqual(reads, []);
});

test('no ?repo= from a workspace pod: the repository that workspace works in', async() => {
  const { repoOf } = load({ ip: '10.42.0.9', pods: { '10.42.0.9': 'dev-lte-pr-222' }, instances: { 'lte-pr-222': installation('rancher/virtual-clusters-ui') } });

  assert.equal(await repoOf(url()), 'rancher/virtual-clusters-ui');
});

test('a malformed ?repo= falls through to the workspace, not to the default', async() => {
  const { repoOf } = load({ ip: '10.42.0.9', pods: { '10.42.0.9': 'dev-lte-pr-222' }, instances: { 'lte-pr-222': installation('rancher/virtual-clusters-ui') } });

  assert.equal(await repoOf(url('?repo=not-a-repo')), 'rancher/virtual-clusters-ui');
});

test('the default for a dashboard workspace, the browser, and anything that is not a workspace', async() => {
  // A rancher/dashboard workspace records no repo at all (ensureWorkspace writes it only when it differs).
  assert.equal(await load({ ip: '10.42.0.9', pods: { '10.42.0.9': 'dev-issue-19000' }, instances: { 'issue-19000': installation('') } }).repoOf(url()), 'rancher/dashboard');
  // The browser arrives through the apiserver's proxy: a pod that is not in a workspace namespace.
  assert.equal(await load({ ip: '10.42.0.2', pods: { '10.42.0.2': 'kube-system' } }).repoOf(url()), 'rancher/dashboard');
  // A workspace-looking namespace with no Installation behind it.
  assert.equal(await load({ ip: '10.42.0.3', pods: { '10.42.0.3': 'dev-agents' } }).repoOf(url()), 'rancher/dashboard');
  assert.equal(await load({ ip: '127.0.0.1' }).repoOf(url()), 'rancher/dashboard');
});
