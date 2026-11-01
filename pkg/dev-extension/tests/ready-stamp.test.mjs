// The ready stamp, three ways round: the pod's real service reading files a tree could have planted,
// the real ensureWorkspaceReady and ensureWorkspaceOnOpen against a recording exec, and the real
// stamp-writing script run in a shell with the real service reading what it wrote back.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { READY_TTL_MS, readyFields, readyStampCurrent } from '../agent-reads.mjs';

const PKG = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOKEN = 'b'.repeat(64);
const PORT = 21000 + (process.pid % 2000);
const WS = 'issue-123-thing';
const IDENTITY = 'c'.repeat(64);
const NOW_S = 1_800_000_000;
// What dev-api's seedVersion really serves. See the test that holds this to its source.
const SERVED = '4f1a2b3c+0123456789ab';

const stampOf = (over = {}) => ({
  workspace: WS,
  pod:       'dev-issue-123-thing-5f7-abcde',
  boot:      0,
  seed:      `${ SERVED }:123::issue-123-thing`,
  tools:     'gh-2.76.1,jq-1.7.1',
  rancher:   'https://rancher.example.com',
  identity:  IDENTITY,
  bundle:    '0.3.622',
  at:        NOW_S,
  expires:   0,
  ...over,
});

/* ── What the file may say ───────────────────────────────────────────────────────────────────── */

test('a stamp keeps the fields it should and nothing else', () => {
  const read = readyFields(JSON.stringify({ ...stampOf(), token: 'token-x:secret', extra: 1 }), WS);

  assert.deepEqual(read, stampOf());
});

test('a stamp with any field wrong is no stamp', () => {
  const bad = {
    workspace: 'other',
    pod:       'POD/../x',
    boot:      -1,
    seed:      "x'; touch /tmp/owned; '",
    tools:     'gh',
    rancher:   'javascript:alert(1)',
    identity:  'token-abc:secret',
    at:        0,
    expires:   1.5,
  };

  for (const [field, value] of Object.entries(bad)) {
    assert.equal(readyFields(JSON.stringify(stampOf({ [field]: value })), WS), null, field);
  }
  for (const field of Object.keys(stampOf())) {
    const missing = stampOf();

    delete missing[field];
    assert.equal(readyFields(JSON.stringify(missing), WS), null, `without ${ field }`);
  }
  for (const text of ['', 'nope', '[]', 'null', 'RANCHER_TOKEN=token-x:secret\n']) {
    assert.equal(readyFields(text, WS), null, text);
  }
});

test('every seed version dev-api can serve fits the shape, and seedVersion still says what this assumes', () => {
  const server = fs.readFileSync(path.join(PKG, 'dev-api/server.mjs'), 'utf8');

  assert.match(server, /return `\$\{ bakedVersion \}\+\$\{ sha\.slice\(0, 12\) \}\$\{ version \? `\+\$\{ version \}` : '' \}`;/);
  for (const served of [SERVED, `${ SERVED }+77`, 'a+0123456789ab']) {
    for (const [issue, pr] of [['123', ''], ['', '45'], ['', '']]) {
      const seed = `${ served }:${ issue }:${ pr }:${ WS }`;

      assert.equal(readyFields(JSON.stringify(stampOf({ seed })), WS)?.seed, seed);
    }
  }
});

test('no field takes a token as it is written', () => {
  const token = 'token-abcde:shhhhsecretvalue';
  const github = 'ghp_0123456789abcdefABCDEF';

  for (const field of ['seed', 'rancher', 'pod', 'tools', 'identity', 'bundle']) {
    for (const value of [token, github, `https://${ token }/`, `https://${ token }@rancher.example.com`, `${ token }:1::${ WS }`, `${ SERVED }+${ github }:1::${ WS }`]) {
      assert.equal(readyFields(JSON.stringify(stampOf({ [field]: value })), WS), null, `${ field }: ${ value }`);
    }
  }
  for (const rancher of ['https://rancher.example.com', 'https://rancher.example.com:8443', 'http://10.0.0.1:30443', 'https://[fd00::1]:8443']) {
    assert.equal(readyFields(JSON.stringify(stampOf({ rancher })), WS)?.rancher, rancher);
  }
});

test('what it matches: every input, the age, and a token running out', () => {
  const now = NOW_S * 1000;
  const wanted = stampOf();

  assert.equal(readyStampCurrent(stampOf(), wanted, now), true);
  for (const field of ['workspace', 'pod', 'seed', 'tools', 'rancher', 'identity', 'bundle']) {
    assert.equal(readyStampCurrent(stampOf(), { ...wanted, [field]: 'different' }, now), false, field);
  }
  assert.equal(readyStampCurrent(stampOf(), { ...wanted, boot: 1 }, now), false, 'a restarted container');
  assert.equal(readyStampCurrent(stampOf(), wanted, now + READY_TTL_MS - 1), true);
  assert.equal(readyStampCurrent(stampOf(), wanted, now + READY_TTL_MS), false, 'as old as the TTL');
  assert.equal(readyStampCurrent(stampOf(), wanted, now - 120_000), false, 'from the future');
  assert.equal(readyStampCurrent(stampOf({ expires: NOW_S + 3600 }), wanted, now), false, 'expires inside the TTL');
  assert.equal(readyStampCurrent(stampOf({ expires: NOW_S + 3601 }), wanted, now), true);
  assert.equal(readyStampCurrent(null, wanted, now), false);
  assert.equal(readyStampCurrent(stampOf(), null, now), false);
  assert.equal(readyStampCurrent(stampOf(), wanted, NaN), false);
});

/* ── The service, reading what a tree could have planted ─────────────────────────────────────── */

let dir;
let trees;
let child;

const treeOf = (name) => path.join(trees, name);
const mountTable = () => path.join(dir, 'mountinfo');
// proc(5)'s format: the mount point is the fifth field.
const MOUNT_LINE = (at, type = 'ext4') => `36 35 98:0 / ${ at } rw,noatime master:1 - ${ type } /dev/root rw\n`;

/** What provisioning leaves that a stamp vouches for, so a test's stamp is refused for its own reason. */
function furnish(name) {
  const root = treeOf(name);

  for (const file of ['.env', '.git-credentials', 'bin/dev-shell', '.kube/config']) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), '#\n');
  }
  fs.chmodSync(path.join(root, 'bin/dev-shell'), 0o755);
}

function plant(name, text) {
  furnish(name);
  fs.writeFileSync(path.join(treeOf(name), '.dev-ready'), text);
}

// The real one: the tests of the browser's half replace the global with GitHub's stand-in.
const realFetch = globalThis.fetch;

async function ask(url) {
  const resp = await realFetch(`http://127.0.0.1:${ PORT }${ url }`, { headers: { 'x-state-token': TOKEN } });

  return { status: resp.status, header: resp.headers.get('x-state-api'), answer: await resp.json() };
}

const ready = async(name) => (await ask(`/ready?workspace=${ encodeURIComponent(name) }`)).answer;
const good = (name) => JSON.stringify(stampOf({ workspace: name }));

before(async() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ready-stamp-'));
  fs.chmodSync(dir, 0o755);
  trees = path.join(dir, 'workspaces');
  fs.mkdirSync(trees);

  const seed = path.join(dir, 'seed');

  fs.mkdirSync(seed);
  fs.copyFileSync(path.join(PKG, 'seed/agent/state-api.mjs'), path.join(seed, 'state-api.mjs'));
  fs.copyFileSync(path.join(PKG, 'agent-reads.mjs'), path.join(seed, 'agent-reads.mjs'));
  fs.writeFileSync(path.join(dir, 'token'), TOKEN);
  fs.writeFileSync(mountTable(), MOUNT_LINE('/'));
  child = spawn(process.execPath, [path.join(seed, 'state-api.mjs')], {
    env: {
      ...process.env,
      STATE_API_PORT:       String(PORT),
      STATE_API_SEED:       seed,
      STATE_API_TOKEN_FILE: path.join(dir, 'token'),
      STATE_API_WORKSPACES: trees,
      STATE_API_MOUNT_TABLE: mountTable(),
    },
    stdio: 'ignore',
  });
  for (let i = 0; i < 100; i++) {
    try {
      await ask('/healthz');
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
});

after(() => {
  child?.kill('SIGKILL');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('/ready answers with the validated fields, the pod\'s clock and the unchanged version', async() => {
  plant('fine', `${ JSON.stringify({ ...stampOf({ workspace: 'fine' }), token: 'token-x:secret' }) }\n`);

  const before = Date.now();
  const { status, header, answer } = await ask('/ready?workspace=fine');
  const fields = JSON.parse(answer.text);

  assert.equal(status, 200);
  assert.equal(header, '3');
  assert.equal(answer.ok, true);
  assert.equal(answer.age, 0);
  assert.equal(fields.now >= before, true);
  assert.equal(fields.autoShared, false);
  delete fields.now;
  delete fields.autoShared;
  assert.deepEqual(fields, stampOf({ workspace: 'fine' }));
  assert.doesNotMatch(answer.text, /secret/);
});

test('/ready wants the token like every other route', async() => {
  const resp = await realFetch(`http://127.0.0.1:${ PORT }/ready?workspace=fine`);

  assert.equal(resp.status, 401);
});

test('/ready refuses a name that is not one before touching the disk', async() => {
  for (const name of ['', '..', '../fine', 'a/b', 'a b', '.hidden', 'x'.repeat(121)]) {
    const answer = await ready(name);

    assert.equal(answer.ok, false, name);
    assert.equal(answer.text, '', name);
  }
});

test('/ready has nothing to say about what is not there, or is another workspace\'s', async() => {
  assert.deepEqual([(await ready('no-such-tree')).ok, (await ready('no-such-tree')).text], [true, '']);
  furnish('empty');
  assert.equal((await ready('empty')).text, '');
  plant('copied', good('someone-else'));
  assert.equal((await ready('copied')).text, '');
  plant('not-a-stamp', 'RANCHER_TOKEN=token-x:secret\nGH_TOKEN=ghp_secret\n');

  const answer = await ready('not-a-stamp');

  assert.equal(answer.text, '');
  assert.doesNotMatch(JSON.stringify(answer), /secret/);
});

test('/ready follows no link, opens no FIFO, reads no giant and takes no second name', async() => {
  const secret = path.join(dir, 'outside-stamp');

  fs.writeFileSync(secret, good('linked'));
  furnish('linked');
  fs.symlinkSync(secret, path.join(treeOf('linked'), '.dev-ready'));
  assert.equal((await ready('linked')).text, '', 'the file is a symlink');

  fs.mkdirSync(path.join(dir, 'elsewhere'));
  fs.writeFileSync(path.join(dir, 'elsewhere', '.dev-ready'), good('tree-link'));
  fs.symlinkSync(path.join(dir, 'elsewhere'), treeOf('tree-link'));
  assert.equal((await ready('tree-link')).text, '', 'the tree is a symlink');

  furnish('hardlinked');
  fs.writeFileSync(path.join(dir, 'other-file'), good('hardlinked'));
  fs.linkSync(path.join(dir, 'other-file'), path.join(treeOf('hardlinked'), '.dev-ready'));
  assert.equal((await ready('hardlinked')).text, '', 'the file has a second name');

  furnish('fifo');
  execFileSync('mkfifo', [path.join(treeOf('fifo'), '.dev-ready')]);
  assert.equal((await ready('fifo')).text, '', 'a FIFO');

  furnish('directory');
  fs.mkdirSync(path.join(treeOf('directory'), '.dev-ready'));
  assert.equal((await ready('directory')).text, '', 'a directory');

  plant('huge', JSON.stringify({ ...stampOf({ workspace: 'huge' }), padding: 'x'.repeat(4096) }));
  assert.equal((await ready('huge')).text, '', 'over the cap, even with good fields');

  const healthy = await ask('/healthz');

  assert.equal(healthy.status, 200, 'and the service is still up');
});

test('/ready does not touch a tree that is a mount, however good the stamp in it', async() => {
  plant('mounted', good('mounted'));
  plant('mounted-too', good('mounted-too'));
  plant('inside', good('inside'));
  assert.notEqual((await ready('mounted')).text, '', 'believed while it is a plain directory');

  fs.appendFileSync(mountTable(), MOUNT_LINE(treeOf('mounted'), 'fuse.sshfs') + MOUNT_LINE(path.join(treeOf('inside'), 'dashboard'), 'fuse.sshfs'));
  assert.equal((await ready('mounted')).text, '', 'the tree itself');
  assert.equal((await ready('inside')).text, '', 'something under it');
  assert.notEqual((await ready('mounted-too')).text, '', 'a name that only starts the same is another tree');

  const table = fs.readFileSync(mountTable());

  fs.rmSync(mountTable());
  assert.equal((await ready('mounted-too')).text, '', 'a table that cannot be read is not a local tree');
  fs.writeFileSync(mountTable(), table);
});

test('/ready has no stamp for a tree that has lost what the stamp vouches for', async() => {
  const elsewhere = path.join(dir, 'elsewhere-needs');

  fs.mkdirSync(elsewhere);
  fs.writeFileSync(path.join(elsewhere, 'dev-shell'), '#!/bin/sh\n');
  fs.chmodSync(path.join(elsewhere, 'dev-shell'), 0o755);

  for (const need of ['.env', 'bin/dev-shell', '.git-credentials', '.kube/config']) {
    const name = `lost${ need.replace(/\W/g, '-') }`;
    const file = path.join(treeOf(name), need);

    plant(name, good(name));
    assert.notEqual((await ready(name)).text, '', `${ need }: believed with everything there`);
    fs.rmSync(file);
    assert.equal((await ready(name)).text, '', `${ need }: gone`);
    fs.symlinkSync(path.join(elsewhere, 'dev-shell'), file);
    assert.equal((await ready(name)).text, '', `${ need }: a link`);
    fs.rmSync(file);
    fs.mkdirSync(file);
    assert.equal((await ready(name)).text, '', `${ need }: a directory`);
  }

  plant('shell-link', good('shell-link'));
  fs.rmSync(path.join(treeOf('shell-link'), 'bin'), { recursive: true });
  fs.symlinkSync(elsewhere, path.join(treeOf('shell-link'), 'bin'));
  assert.equal((await ready('shell-link')).text, '', 'a link on the way to it');

  plant('shell-plain', good('shell-plain'));
  fs.chmodSync(path.join(treeOf('shell-plain'), 'bin/dev-shell'), 0o644);
  assert.equal((await ready('shell-plain')).text, '', 'a dev-shell that cannot run');
});

test('/ready says whether the default share has been made, through no link', async() => {
  const shared = async(name) => JSON.parse((await ready(name)).text).autoShared;

  plant('share-yes', good('share-yes'));
  assert.equal(await shared('share-yes'), false);
  fs.mkdirSync(path.join(treeOf('share-yes'), '.share'));
  fs.writeFileSync(path.join(treeOf('share-yes'), '.share/auto'), '');
  assert.equal(await shared('share-yes'), true);

  plant('share-link', good('share-link'));
  fs.symlinkSync(path.join(treeOf('share-yes'), '.share'), path.join(treeOf('share-link'), '.share'));
  assert.equal(await shared('share-link'), false);
});

test('/ready is plain file reads: the route and its reader start no process', () => {
  const service = fs.readFileSync(path.join(PKG, 'seed/agent/state-api.mjs'), 'utf8');
  const reader = service.slice(service.indexOf('async function treeIsMounted'), service.indexOf('const ROUTES = ['));
  const route = service.slice(service.indexOf("['/ready', async"), service.indexOf("['/origins'"));

  assert.match(reader, /O_NOFOLLOW/);
  for (const text of [reader, route]) {
    assert.doesNotMatch(text, /runScript|runOnce|settled|cached\(|spawn|asPane|execFile/);
  }
  assert.match(service, /^const VERSION = 3;$/m);
  assert.match(fs.readFileSync(path.join(PKG, 'pod-state.ts'), 'utf8'), /^const WANT_VERSION = 3;$/m);
});

/* ── The browser's half, with everything around it stubbed ───────────────────────────────────── */

const moduleDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ready-tools-'));

process.on('exit', () => fs.rmSync(moduleDir, { recursive: true, force: true }));

fs.chmodSync(moduleDir, 0o755);
fs.copyFileSync(path.join(PKG, 'agent-reads.mjs'), path.join(moduleDir, 'agent-reads.mjs'));
fs.writeFileSync(path.join(moduleDir, 'api-stub.mjs'), `
const s = () => globalThis.stub;
export const WORKSPACE_CONTAINER = 'workspace';
export const GITHUB_BROWSER_CDP = 'http://github-browser:9222';
export const GITHUB_BROWSER_CDP_DOWNSTREAM = 'http://127.0.0.1:9223';
export const workspaceNamespace = (name) => 'dev-' + name;
export const clusterBase = () => '';
export const activeCluster = () => s().cluster;
export const OUR_VERSION = '0.3.622';
export const workspacePod = async() => s().pod;
export const workspaceContainerRestarts = async() => s().boot;
export const githubToken = async() => s().secrets.GH_TOKEN || '';
export const secretValue = async(key) => s().secrets[key] || '';
export const sharedBrowserCdp = async() => s().sharedCdp;
export const devFetch = async(url) => {
  if (url.includes('/agent-seed/version')) {
    return s().served ? { version: s().served } : null;
  }
  if (url.includes('/v3/tokens')) {
    s().minted += 1;
    return { token: 'token-new:minted' };
  }
  return null;
};
export const podExecDetail = (...args) => s().exec(...args);
`);
fs.writeFileSync(path.join(moduleDir, 'agent-stub.mjs'), 'export const agentPod = async() => globalThis.stub.agentPod;\n');
fs.writeFileSync(path.join(moduleDir, 'pod-state-stub.mjs'), 'export const podStateText = (...args) => globalThis.stub.state(...args);\n');
fs.writeFileSync(path.join(moduleDir, 'seed-stub.mjs'), "export const AGENT_SEED = { a: 'b' };\n");
fs.writeFileSync(path.join(moduleDir, 'apps-stub.mjs'), "export const UNREWRITE_B64 = '';\n");
fs.writeFileSync(path.join(moduleDir, 'constants-stub.mjs'), `
export const DEV_API_IN_CLUSTER = 'http://dev-api';
export const workspaceRoot = (name) => globalThis.stub.root + '/' + name;
export const isLte = (name) => name.startsWith('lte-');
`);
fs.writeFileSync(path.join(moduleDir, 'workspace-tools.ts'), fs.readFileSync(path.join(PKG, 'workspace-tools.ts'), 'utf8')
  .replace("from './api'", "from './api-stub.mjs'")
  .replace("from './agent'", "from './agent-stub.mjs'")
  .replace("from './pod-state'", "from './pod-state-stub.mjs'")
  .replace("from './agent-seed.generated'", "from './seed-stub.mjs'")
  .replace("from './apps'", "from './apps-stub.mjs'")
  .replace("from './config/constants'", "from './constants-stub.mjs'"));

const toolsUrl = pathToFileURL(path.join(moduleDir, 'workspace-tools.ts')).href;
const GOOD_SECRETS = { GH_TOKEN: 'ghp_realtoken', GIT_NAME: 'Someone', GIT_EMAIL: 'someone@example.com' };

const scriptOf = (command) => Buffer.from(/echo (\S+) \| base64 -d/.exec(command[2])[1], 'base64').toString();

/** Which step a script is, by the marker only that one prints or the check only that one makes. */
function stepOf(script) {
  const steps = {
    'BASE-OK': 'base', 'SEED-OK': 'seed-write', 'TUNNEL-OK': 'seed-read', readlink: 'tools', 'ENV-OK': 'environment', 'CHECKOUT-OK': 'checkout', 'READY-OK': 'stamp',
  };

  for (const [mark, step] of Object.entries(steps)) {
    if (script.includes(mark)) {
      return step;
    }
  }

  return 'token';
}

const PROVISIONED = ['base', 'seed-read', 'seed-write', 'tools', 'token', 'environment', 'checkout'];

/** A workspace this page provisioned a moment ago, and the identity hash that goes with it. */
async function world(over = {}) {
  const it = {
    root:      '/workspaces',
    cluster:   'local',
    pod:       stampOf().pod,
    boot:      0,
    served:    SERVED,
    secrets:   { ...GOOD_SECRETS },
    sharedCdp: 'http://10.0.0.9:9222',
    agentPod:  'agent-0',
    minted:    0,
    ran:       [],
    scripts:   [],
    commands:  [],
    answers:   {},
    written:   null,
    asked:     [],
    ...over,
  };

  it.exec = async(namespace, pod, container, command) => {
    const script = scriptOf(command);
    const step = stepOf(script);

    it.ran.push(step);
    it.scripts.push(script);
    it.commands.push(command.join(' '));
    if (it.answers[step] instanceof Error) {
      throw it.answers[step];
    }

    const printed = {
      base:         'BASE-OK',
      'seed-read':  '',
      'seed-write': 'SEED-OK',
      tools:        'gh jq ',
      token:        'token-abc:secret',
      environment:  'ENV-OK',
      checkout:     'CHECKOUT-OK',
      stamp:        'READY-OK',
    };

    return { out: it.answers[step] ?? printed[step], status: '' };
  };
  it.state = async(pod, url) => {
    it.asked.push(url);
    if (it.stateFails) {
      throw new Error('unavailable');
    }

    return it.stampText ?? '';
  };
  globalThis.stub = it;
  globalThis.window = { location: { origin: 'https://rancher.example.com' } };
  globalThis.fetch = async() => new Response(JSON.stringify({ login: 'someone', name: 'Someone' }), { status: 200 });

  return it;
}

/** The body the writer would write, taken from the script it actually ran. */
function writtenBody(it) {
  const script = it.scripts[it.ran.indexOf('stamp')];

  return JSON.parse(`${ /BODY='(.*)'/.exec(script)[1] }}`);
}

/** The stamp this page itself would leave, by provisioning once and reading the script. */
async function currentStampText(tools) {
  const it = await world();

  await tools.ensureWorkspaceReady(WS);

  return JSON.stringify({ ...writtenBody(it), at: Math.floor(Date.now() / 1000), expires: 0, now: Date.now() });
}

const tools = await import(toolsUrl);

test('a stamp saying the same thing: not one exec, and the pod\'s address still comes back', async() => {
  const stampText = await currentStampText(tools);
  const it = await world({ stampText });
  const target = await tools.ensureWorkspaceOnOpen(WS);

  assert.deepEqual(it.ran, []);
  assert.deepEqual(target, { workspace: WS, namespace: `dev-${ WS }`, pod: it.pod });
  assert.deepEqual(it.asked, [`/ready?workspace=${ WS }`]);
});

test('everything that changes what would be provisioned provisions again, and stamps', async() => {
  const stampText = await currentStampText(tools);
  const changes = {
    'a changed GitHub token': { secrets: { ...GOOD_SECRETS, GH_TOKEN: 'ghp_rotated' } },
    'a changed Git name':     { secrets: { ...GOOD_SECRETS, GIT_NAME: 'Somebody Else' } },
    'a changed Git email':    { secrets: { ...GOOD_SECRETS, GIT_EMAIL: 'else@example.com' } },
    'a seed upgrade':         { served: '4f1a2b3c+ba9876543210' },
    'a skill edited':         { served: `${ SERVED }+77` },
    'a new pod':              { pod: 'dev-issue-123-thing-5f7-zzzzz' },
    'a restarted container':  { boot: 1 },
  };

  for (const [what, over] of Object.entries(changes)) {
    const it = await world({ stampText, ...over });

    await tools.ensureWorkspaceOnOpen(WS);
    assert.deepEqual(it.ran, [...PROVISIONED, 'stamp'], what);
  }

  const moved = await world({ stampText });

  globalThis.window = { location: { origin: 'https://other-rancher.example.com' } };
  await tools.ensureWorkspaceOnOpen(WS);
  assert.deepEqual(moved.ran, [...PROVISIONED, 'stamp'], 'a changed Rancher URL');
});

test('a stamp from another release of this extension provisions, and the new one says so', async() => {
  const fresh = JSON.parse(await currentStampText(tools));

  assert.equal(fresh.bundle, '0.3.622');

  const it = await world({ stampText: JSON.stringify({ ...fresh, bundle: '0.3.621' }) });

  await tools.ensureWorkspaceOnOpen(WS);
  assert.deepEqual(it.ran, [...PROVISIONED, 'stamp']);
  assert.equal(writtenBody(it).bundle, '0.3.622');
});

test('another cluster\'s workspace is provisioned as it always was: nothing asked, nothing stamped', async() => {
  const stampText = await currentStampText(tools);
  const it = await world({ stampText, cluster: 'c-abcde' });

  await tools.ensureWorkspaceOnOpen(WS);
  // The agent pod lays a downstream workspace's seed out, so those two steps are not this page's.
  assert.deepEqual(it.ran, PROVISIONED.filter((step) => !step.startsWith('seed')));
  assert.deepEqual(it.asked, []);
});

test('the default share: the service\'s word when it has one, and otherwise ask', async() => {
  const fresh = JSON.parse(await currentStampText(tools));
  const asks = [
    [JSON.stringify({ ...fresh, autoShared: true }), true],
    [JSON.stringify({ ...fresh, autoShared: false }), false],
    ['', false],
    [JSON.stringify({ workspace: 'nonsense', autoShared: true }), false],
  ];

  for (const [stampText, marked] of asks) {
    const it = await world({ stampText });

    assert.equal(await tools.defaultShareMarked(WS), marked, stampText);
    assert.deepEqual(it.ran, [], 'not one exec');
  }

  const previews = fs.readFileSync(path.join(PKG, 'previews.ts'), 'utf8');
  const share = previews.slice(previews.indexOf('export async function ensureDefaultShare'));

  assert.ok(share.indexOf('defaultShareMarked(workspace)') > -1);
  assert.ok(share.indexOf('defaultShareMarked(workspace)') < share.indexOf('readInWorkspace('), 'before the exec');
});

test('a leased workspace\'s shared browser moving is a change too', async() => {
  const name = 'lte-thing';
  const first = await world();

  await tools.ensureWorkspaceReady(name);

  const stampText = JSON.stringify({ ...writtenBody(first), at: Math.floor(Date.now() / 1000), expires: 0, now: Date.now() });
  const same = await world({ stampText });

  await tools.ensureWorkspaceOnOpen(name);
  assert.deepEqual(same.ran, []);

  const moved = await world({ stampText, sharedCdp: 'http://10.0.0.77:9222' });

  await tools.ensureWorkspaceOnOpen(name);
  assert.deepEqual(moved.ran, [...PROVISIONED, 'stamp']);
});

test('a stale stamp, a token running out, and every way of not having a stamp all provision', async() => {
  const fresh = JSON.parse(await currentStampText(tools));
  const texts = {
    'older than the TTL':      JSON.stringify({ ...fresh, at: fresh.at - 3601 }),
    'token expires soon':      JSON.stringify({ ...fresh, expires: fresh.at + 60 }),
    'no stamp':                '',
    'a stamp that is nonsense': 'nonsense',
    'no clock in the answer':  JSON.stringify({ ...fresh, now: undefined }),
  };

  for (const [what, stampText] of Object.entries(texts)) {
    const it = await world({ stampText });

    await tools.ensureWorkspaceOnOpen(WS);
    assert.deepEqual(it.ran, [...PROVISIONED, 'stamp'], what);
  }

  const down = await world({ stateFails: true });

  await tools.ensureWorkspaceOnOpen(WS);
  assert.deepEqual(down.ran, [...PROVISIONED, 'stamp'], 'the service is unavailable, or older than the route');

  const noAgent = await world({ agentPod: null, stampText: JSON.stringify(fresh) });

  await tools.ensureWorkspaceOnOpen(WS);
  assert.deepEqual(noAgent.ran, [...PROVISIONED, 'stamp'], 'no agent pod');
});

test('an action is never skipped, and checks the token, whatever the stamp says', async() => {
  const stampText = await currentStampText(tools);
  const it = await world({ stampText });

  await tools.ensureWorkspaceReady(WS);
  assert.deepEqual(it.ran, [...PROVISIONED, 'stamp']);
  assert.deepEqual(it.asked, [], 'it does not even ask');
});

test('what cannot be vouched for is provisioned and not stamped', async() => {
  const stampText = await currentStampText(tools);
  const cases = {
    'a blank secret store':    { secrets: {} },
    'the API cannot be asked': { served: '' },
    'restarts unknown':        { boot: null },
    'a plain-http origin':     { noHash: true },
  };

  for (const [what, over] of Object.entries(cases)) {
    const it = await world({ stampText, ...over });
    const subtle = Object.getOwnPropertyDescriptor(globalThis, 'crypto');

    if (over.noHash) {
      Object.defineProperty(globalThis, 'crypto', { value: {}, configurable: true });
    }
    try {
      await tools.ensureWorkspaceOnOpen(WS);
    } finally {
      Object.defineProperty(globalThis, 'crypto', subtle);
    }
    assert.equal(it.ran.includes('base'), true, `${ what }: provisioned`);
    assert.equal(it.ran.includes('stamp'), false, `${ what }: not stamped`);
    assert.deepEqual(it.asked, [], `${ what }: nothing to compare, so nothing to ask`);
  }
});

test('a clone still running is not a checkout done', async() => {
  const it = await world({ answers: { checkout: 'NO-CHECKOUT' } });

  await tools.ensureWorkspaceOnOpen(WS);
  assert.deepEqual(it.ran, PROVISIONED);
});

test('a GitHub login that did not come back is corrected on the next load, not an hour later', async() => {
  const it = await world();

  globalThis.fetch = async() => new Response('{}', { status: 401 });

  const fresh = await import(`${ toolsUrl }?login-failed`);

  await fresh.ensureWorkspaceOnOpen(WS);
  assert.deepEqual(it.ran, PROVISIONED);
});

test('a run that fails partway leaves no stamp behind it, and fails the way it did', async() => {
  const it = await world({ answers: { environment: 'nope' } });

  await assert.rejects(tools.ensureWorkspaceReady(WS), /environment could not be written/);
  assert.deepEqual(it.ran, ['base', 'seed-read', 'seed-write', 'tools', 'token', 'environment']);
  assert.match(it.scripts[0], /rm -f \$WS\/\.dev-ready/);
  assert.ok(it.scripts[0].indexOf('.dev-ready') < it.scripts[0].indexOf('mkdir -p'), 'first thing it does');
});

test('a stamp that cannot be written fails nothing', async() => {
  const it = await world({ answers: { stamp: new Error('the pod went away') } });

  await tools.ensureWorkspaceReady(WS);
  assert.equal(it.ran.at(-1), 'stamp');
});

test('the stamp\'s exec carries no secret, and only provisioning\'s write does', async() => {
  const it = await world();

  await tools.ensureWorkspaceOnOpen(WS);

  const decoded = it.scripts[it.ran.indexOf('stamp')];
  const sent = it.commands[it.ran.indexOf('stamp')];

  for (const secret of ['ghp_realtoken', 'token-abc:secret', 'Someone', 'someone@example.com']) {
    assert.equal(decoded.includes(secret), false, secret);
    assert.equal(sent.includes(Buffer.from(secret).toString('base64')), false, secret);
  }
  assert.match(decoded, /\$RANCHER_TOKEN/);
  assert.equal(it.scripts[it.ran.indexOf('environment')].includes('ghp_realtoken'), true);
});

/* ── The real script, in a real shell, read back by the real service ─────────────────────────── */

const asOwner = process.getuid?.() === 0;

/** A tree with everything provisioning leaves, and a `curl` answering as Rancher would. */
function preparedTree(name, curlBody) {
  const root = treeOf(name);

  furnish(name);
  fs.mkdirSync(path.join(root, 'node_modules/playwright-core'), { recursive: true });
  fs.writeFileSync(path.join(root, '.env'), 'RANCHER_TOKEN=token-abc:thesecret\nRANCHER_URL=https://rancher.example.com\n');
  for (const tool of ['dev-shell', 'ffmpeg', 'lsof']) {
    fs.writeFileSync(path.join(root, 'bin', tool), '#!/bin/sh\n');
    fs.chmodSync(path.join(root, 'bin', tool), 0o755);
  }
  fs.writeFileSync(path.join(root, 'bin', 'curl'), `#!/bin/sh\ncase "$*" in\n${ curlBody }\nesac\n`);
  fs.chmodSync(path.join(root, 'bin', 'curl'), 0o755);
  if (asOwner) {
    execFileSync('chown', ['-R', 'node:node', root]);
  }
}

/** Provision with a stubbed exec, except that the stamp's script really runs. */
async function stampForReal(name) {
  const it = await world({ root: trees });
  const canned = it.exec;

  it.exec = async(namespace, pod, container, command) => {
    if (stepOf(scriptOf(command)) !== 'stamp') {
      return canned(namespace, pod, container, command);
    }
    it.ran.push('stamp');

    const out = execFileSync(command[0], command.slice(1), { encoding: 'utf8', env: { ...process.env, PATH: process.env.PATH } });

    it.printed = out;

    return { out, status: '' };
  };
  await tools.ensureWorkspaceReady(name);

  return it;
}

const ANSWERS_200 = '*users*) echo 200 ;;';

test('the real script writes what the real service accepts, and a page matches it', async() => {
  const name = 'real-one';
  const expires = Math.floor(Date.now() / 1000) + (90 * 86400);

  preparedTree(name, `${ ANSWERS_200 }\n*tokens/token-abc*) echo '{"expired":false,"enabled":true,"expiresAt":"${ new Date(expires * 1000).toISOString() }"}' ;;`);

  const it = await stampForReal(name);

  assert.match(it.printed, /READY-OK/);

  const raw = fs.readFileSync(path.join(treeOf(name), '.dev-ready'), 'utf8');

  assert.doesNotMatch(raw, /thesecret|ghp_/);
  assert.equal(fs.statSync(path.join(treeOf(name), '.dev-ready')).mode & 0o777, 0o644);
  assert.deepEqual(fs.readdirSync(treeOf(name)).filter((f) => f.startsWith('.dev-ready.')), [], 'no temporary left');

  const answer = await ready(name);
  const fields = JSON.parse(answer.text);

  assert.equal(fields.expires, expires);
  assert.equal(fields.pod, it.pod);

  const again = await world({ stampText: answer.text });

  await tools.ensureWorkspaceOnOpen(name);
  assert.deepEqual(again.ran, []);
});

test('a token with no expiry, or whose record will not say, is 0 and only the TTL bounds it', async() => {
  for (const [name, body] of [['real-never', `echo '{"expired":false,"enabled":true,"expiresAt":""}'`], ['real-forbidden', `echo '{"type":"error","status":403}'`], ['real-garbage', 'echo oops']]) {
    preparedTree(name, `${ ANSWERS_200 }\n*tokens*) ${ body } ;;`);
    await stampForReal(name);
    assert.equal(JSON.parse((await ready(name)).text).expires, 0, name);
  }
});

test('the real script writes nothing for a token that is bad, or anything still missing', async() => {
  const missing = (name, file) => fs.rmSync(path.join(treeOf(name), file), { recursive: true });
  const fine = `${ ANSWERS_200 }\n*tokens*) echo '{"expired":false}' ;;`;
  const cases = {
    'real-revoked':  { curl: "*users*) echo 401 ;;\n*tokens*) echo '{}' ;;" },
    'real-expired':  { curl: `${ ANSWERS_200 }\n*tokens*) echo '{"expired":true}' ;;` },
    'real-disabled': { curl: `${ ANSWERS_200 }\n*tokens*) echo '{"enabled":false}' ;;` },
    'real-no-apt':   { curl: fine, remove: 'bin/ffmpeg' },
    'real-no-shell': { curl: fine, remove: 'bin/dev-shell' },
    'real-no-pw':    { curl: fine, remove: 'node_modules/playwright-core' },
  };

  for (const [name, { curl, remove }] of Object.entries(cases)) {
    preparedTree(name, curl);
    if (remove) {
      missing(name, remove);
    }

    const it = await stampForReal(name);

    assert.match(it.printed, /READY-NOT/, name);
    assert.doesNotMatch(it.printed, /thesecret/, name);
    assert.equal(fs.existsSync(path.join(treeOf(name), '.dev-ready')), false, name);
  }
});

/* ── The real checkout script, in a real shell, against a real repository ────────────────────── */

const gitIn = (cwd, ...args) => execFileSync('git', args, {
  cwd,
  stdio: 'pipe',
  env:   {
    ...process.env, GIT_AUTHOR_NAME: 'a', GIT_AUTHOR_EMAIL: 'a@b', GIT_COMMITTER_NAME: 'a', GIT_COMMITTER_EMAIL: 'a@b',
  },
});

/** A checkout as `shape` leaves it, then a provision whose only real step is the checkout's. */
async function checkoutForReal(name, shape) {
  preparedTree(name, '*) ;;');

  const root = treeOf(name);
  const repo = path.join(root, 'dashboard');

  fs.mkdirSync(repo);
  gitIn(repo, 'init', '-q', '-b', 'master');
  gitIn(repo, 'remote', 'add', 'upstream', path.join(root, 'no-such-remote'));
  shape((...args) => gitIn(repo, ...args), root);
  if (asOwner) {
    execFileSync('chown', ['-R', 'node:node', root]);
  }

  const it = await world({ root: trees });
  const canned = it.exec;

  it.exec = async(namespace, pod, container, command) => {
    if (stepOf(scriptOf(command)) !== 'checkout') {
      return canned(namespace, pod, container, command);
    }
    it.ran.push('checkout');

    return { out: execFileSync(command[0], command.slice(1), { encoding: 'utf8' }), status: '' };
  };
  await tools.ensureWorkspaceOnOpen(name);

  return it;
}

const committed = (git) => git('commit', '-q', '--allow-empty', '-m', 'first');

test('the real checkout script: stamped only once the checkout is what the workspace is for', async() => {
  const stamped = async(name, shape) => (await checkoutForReal(name, shape)).ran.includes('stamp');

  assert.equal(await stamped('issue-900-born', committed), true, 'an issue on a commit');
  assert.equal(await stamped('issue-901-unborn', () => {}), false, 'the App has run git init and not finished fetching');
  assert.equal(await stamped('pr-902-unborn', () => {}), false, 'the same, for a PR');

  assert.equal(await stamped('pr-903-fetch-fails', committed), false, 'on the default branch because the fetch failed');
  assert.equal(fs.existsSync(path.join(treeOf('pr-903-fetch-fails'), '.pr-checkout')), false);

  assert.equal(await stamped('pr-904-theirs', (git) => {
    committed(git);
    git('checkout', '-q', '-b', 'somebodys-work');
  }), true, 'somebody moved it on themselves');

  assert.equal(await stamped('pr-905-lands', (git, root) => {
    const far = path.join(root, 'far');

    fs.mkdirSync(far);
    gitIn(far, 'init', '-q', '-b', 'master');
    committed((...args) => gitIn(far, ...args));
    gitIn(far, 'update-ref', 'refs/pull/905/head', 'HEAD');
    committed(git);
    git('remote', 'set-url', 'upstream', far);
  }), true, 'the fetch worked');
  assert.equal(fs.existsSync(path.join(treeOf('pr-905-lands'), '.pr-checkout')), true);

  assert.equal(await stamped('pr-906-returned', (git, root) => {
    committed(git);
    fs.writeFileSync(path.join(root, '.pr-checkout'), '906\n');
  }), true, 'checked out once, and back on the default branch by choice');
});

test('the wiring: only opening a page believes a stamp', () => {
  const rail = fs.readFileSync(path.join(PKG, 'components/WorkspaceRail.vue'), 'utf8');
  const reviews = fs.readFileSync(path.join(PKG, 'reviews.ts'), 'utf8');
  const tunnel = rail.slice(rail.indexOf('async ensureTunnel()'), rail.indexOf('noteError(e)'));
  const prepare = reviews.slice(reviews.indexOf('export async function prepareWorkspace'));

  assert.match(tunnel, /ensureWorkspaceOnOpen\(this\.workspace\.name\)/);
  assert.match(prepare.slice(0, 120), /ensureWorkspaceOnOpen\(workspace\)/);
  for (const file of ['components/WorkspaceRail.vue', 'components/WorkspaceReview.vue', 'skills.ts', 'reviews.ts']) {
    const text = fs.readFileSync(path.join(PKG, file), 'utf8');

    assert.match(text, /await ensureWorkspaceReady\(/, file);
  }
  assert.equal((rail.match(/ensureWorkspaceOnOpen\(/g) || []).length, 1);
});
