// The shared VPN's controller, run for real against a fake openvpn that speaks the management
// interface the way the ECM lab does: password, a CRV1 challenge, the code, connected - and then,
// a day later, a password query nobody can answer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import {
  vpnControllerSource, vpnStartScript, vpnObjects, vpnConfig,
} from '../vpn-pod.mjs';

const b64 = (s) => Buffer.from(s).toString('base64');
const freePort = () => 20000 + Math.floor(Math.random() * 20000);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** A stand-in for openvpn: the management interface on the config's Unix socket, scripted. */
const FAKE = `#!/usr/bin/env node
const net = require('node:net');
const fs = require('node:fs');
const conf = fs.readFileSync(process.argv[3], 'utf8');
if (!conf.includes('management-query-passwords') || !conf.includes('auth-retry interact')) { console.error('bad config'); process.exit(3); }
const server = net.createServer((c) => {
  let buf = '';
  let step = 0;
  const say = (l) => c.write(l + '\\n');
  say('>INFO:OpenVPN Management Interface Version 5');
  say('>HOLD:Waiting for hold release:0');
  c.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      fs.appendFileSync(process.env.FAKE_LOG, line + '\\n');
      if (line === 'hold release') { say('>PASSWORD:Need \\'Auth\\' username/password'); }
      if (line.startsWith('password "Auth"')) {
        step++;
        if (step === 1) { say(">PASSWORD:Verification Failed: 'Auth' ['CRV1:R,E:st42:" + Buffer.from('torchiaf').toString('base64') + ":Enter OTP']"); say('>PASSWORD:Need \\'Auth\\' username/password'); }
        else if (line.includes('CRV1::st42::') && !line.includes('::000000')) {
          say('>STATE:1700000000,CONNECTED,SUCCESS,10.8.0.6,91.193.113.211,1194,,');
          setTimeout(() => say('>PASSWORD:Need \\'Auth\\' username/password'), 600);
        } else { say(">PASSWORD:Verification Failed: 'Auth'"); }
      }
    }
  });
});
server.listen(/^management (\\S+) unix$/m.exec(conf)[1]);
process.on('SIGTERM', () => process.exit(0));
`;

async function controller() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vpn-ctl-'));
  const control = freePort();

  fs.writeFileSync(path.join(dir, 'controller.mjs'), vpnControllerSource());
  fs.writeFileSync(path.join(dir, 'openvpn'), FAKE, { mode: 0o755 });
  const proc = spawn(process.execPath, [path.join(dir, 'controller.mjs')], {
    env: {
      ...process.env, VPN_TOKEN: 'tok', VPN_RUN_DIR: path.join(dir, 'run'), VPN_OPENVPN: path.join(dir, 'openvpn'), VPN_CONTROL_PORT: String(control), FAKE_LOG: path.join(dir, 'fake.log'),
    },
    stdio: 'ignore',
  });

  for (let i = 0; i < 50; i++) {
    if (await fetch(`http://127.0.0.1:${ control }/healthz`).then((r) => r.ok, () => false)) {
      break;
    }
    await wait(100);
  }
  const call = (method, p, body, token = 'tok') => fetch(`http://127.0.0.1:${ control }${ p }`, {
    method, headers: { authorization: `Bearer ${ token }`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
  }).then(async(r) => ({ status: r.status, body: await r.json() }));

  return {
    dir, call, stop: () => proc.kill('SIGTERM'), fakeLog: () => (fs.existsSync(path.join(dir, 'fake.log')) ? fs.readFileSync(path.join(dir, 'fake.log'), 'utf8') : ''),
  };
}

test('the controller source parses as a module', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vpn-src-'));

  fs.writeFileSync(path.join(dir, 'c.mjs'), vpnControllerSource());
  execFileSync(process.execPath, ['--check', path.join(dir, 'c.mjs')]);
});

test('login: password, the CRV1 challenge, the code, connected; then the daily kick is need-login', async() => {
  const c = await controller();

  try {
    assert.equal((await c.call('GET', '/status', null, 'wrong')).status, 401, 'the token is required');
    assert.equal((await c.call('GET', '/status')).body.phase, 'need-login');
    assert.equal((await c.call('POST', '/login', { username: 'torchiaf', password: 'pw' })).status, 400, 'a login needs the code and the profile');
    const r = await c.call('POST', '/login', {
      username: 'torchiaf', password: 'pw', otp: '654321', ca: 'CA', ta: 'TA', waitMs: 8000,
    });

    assert.equal(r.status, 200);
    assert.equal(r.body.phase, 'connected', JSON.stringify(r.body));
    assert.equal(r.body.address, '10.8.0.6');
    const sent = c.fakeLog();

    assert.match(sent, /^hold release$/m);
    assert.match(sent, /^password "Auth" "pw"$/m);
    assert.match(sent, /^username "Auth" "torchiaf"$/m);
    assert.match(sent, /^password "Auth" "CRV1::st42::654321"$/m);
    await wait(1500);
    const after = (await c.call('GET', '/status')).body;

    assert.equal(after.phase, 'need-login', 'the session ended and the code was spent');
    assert.ok(!fs.existsSync(path.join(c.dir, 'run')), 'the profile and credentials are gone with the session');
  } finally {
    c.stop();
  }
});

test('a code the VPN refuses is a failed login, and says to use a fresh one', async() => {
  const c = await controller();

  try {
    const r = await c.call('POST', '/login', {
      username: 'torchiaf', password: 'pw', otp: '000000', ca: 'CA', ta: 'TA', waitMs: 8000,
    });

    assert.equal(r.body.phase, 'failed', JSON.stringify(r.body));
    assert.match(r.body.note, /fresh code/);
  } finally {
    c.stop();
  }
});

test('config, start script and objects: the shape dev-api applies', () => {
  const conf = vpnConfig({}, '/run/vpn');

  // SUSE's InfraVPN, as NetworkManager has it on the desktop.
  assert.deepEqual(conf.match(/^remote .*$/gm), ['remote us.vpn1.suse.net 1194 udp', 'remote us.vpn2.suse.net 1194 udp']);
  assert.match(conf, /^remote-random$/m);
  assert.match(conf, /^auth SHA512$/m);
  assert.match(conf, /^data-ciphers AES-256-GCM$/m);
  assert.match(conf, /^data-ciphers-fallback AES-256-GCM$/m);
  assert.match(conf, /^ping 10$/m);
  assert.match(conf, /^ping-restart 120$/m);
  assert.match(conf, /^tls-auth \/run\/vpn\/ta\.pem 1$/m);
  // The server's routes, as the desktop takes them; never its default route.
  assert.match(conf, /^pull-filter ignore "redirect-gateway"$/m);
  assert.doesNotMatch(conf, /route-nopull/);
  assert.match(conf, /^management \/run\/vpn\/mgmt\.sock unix$/m, 'a socket in the pod\'s files, not a port on the node\'s network');
  assert.doesNotMatch(conf, /auth-nocache/, 'the server\'s session token carries reconnects without a new code');
  // With the server's routes off: none of them, and only the ones given.
  const fixed = vpnConfig({ pullRoutes: false }, '/run/vpn');

  assert.match(fixed, /^route-nopull$/m);
  assert.deepEqual(fixed.match(/^route .*$/gm), ['route 10.115.0.0 255.255.0.0']);
  assert.match(vpnStartScript(), /apk add --no-cache openvpn .*\n.*\nexec node \/app\/controller\.mjs/);
  const objs = vpnObjects({ namespace: 'dev-system', token: 't' });

  assert.deepEqual(objs.map((o) => o.kind), ['Secret', 'ConfigMap', 'Deployment', 'Service']);
  const pod = objs[2].spec.template.spec;

  assert.deepEqual(pod.containers[0].securityContext.capabilities.add, ['NET_ADMIN']);
  assert.equal(pod.hostNetwork, true, 'the tunnel and its route are the node\'s, so every pod reaches the lab');
  assert.equal(pod.dnsPolicy, 'ClusterFirstWithHostNet');
  assert.deepEqual(objs[3].spec.ports.map((p) => p.port), [18091]);
  assert.equal(pod.volumes.find((v) => v.name === 'tun').hostPath.type, 'CharDevice');
  assert.deepEqual(Object.keys(objs[0].stringData), ['token'], 'the only secret in the objects is dev-api\'s own token');
  assert.deepEqual(pod.containers[0].env.map((e) => e.name), ['VPN_TOKEN'], 'no credentials in the pod\'s environment');
  assert.match(objs[2].spec.template.metadata.annotations['dev.rancher.io/vpn-app'], /^[0-9a-f]{8}$/);
});
