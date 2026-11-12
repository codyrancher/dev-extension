/**
 * The shared VPN: one OpenVPN pod in dev-system that puts the ECM lab on the node's routes.
 *
 * ONE, NOT ONE PER WORKSPACE. The lab's VPN wants a password and a one-time code, and ends every
 * session after a day. A connection per workspace would be a code per workspace; one shared
 * connection is one login a day for all of them, made by the person when something asks.
 *
 * TRANSPARENT, ON THE NODE'S NETWORK (the person's choice, 2026-11-11). The pod is hostNetwork, so
 * the tunnel and its routes are the node's, and every pod on it - a workspace's curl and kubectl,
 * the shared browser, Firefox, a dev server pointed at a Harvester - reaches the lab with nothing
 * configured, as it did over the person's desktop VPN. It is SUSE's InfraVPN, configured as the
 * desktop has it (VPN_SERVER_DEFAULTS): the routes the server pushes are taken as the desktop takes
 * them, and its default route is not. apps-vpn.ts is the earlier, proxy-only attempt, and says why
 * it avoided this; the person decided the reach was worth it.
 *
 * WHAT RUNS IN IT. `node:24-alpine` with openvpn added at start (there is no registry of ours to
 * push an image to - every pod here does this), and the controller below: it starts openvpn on a
 * login, answers its management interface (vpn-management.mjs, shipped as text) over a Unix socket
 * in the pod's own files - on the node's network a TCP port would be open to every other pod there
 * - and serves dev-api a small HTTP API (status, login, logout) behind a token only dev-api has.
 *
 * NOTHING SECRET IN THE SPEC. The profile's CA and TLS key and the person's username and password
 * come from the secret store with each login, in the request, and are written to an in-memory
 * volume only while openvpn needs them.
 */
import {
  vpnB64, vpnUnb64, mgmtQuote, readCrv1, newSession, managementStep,
} from './vpn-management.mjs';

export const VPN_NAME = 'dev-vpn';
/** On the node's network, so a port nothing else there is likely to hold. */
export const VPN_CONTROL_PORT = 18091;

/** The ECM lab's server, from the profile on the person's desktop: nothing here is a secret. */
/**
 * SUSE's InfraVPN (InfraVPN_Access_Corp_US), as NetworkManager runs it on the person's desktop,
 * which is the VPN that reaches the ECM lab: read off that connection (nmcli, 2026-11-11). Its
 * CA is /etc/openvpn/SUSE_Trust_Root.crt and its TLS key /etc/openvpn/ta.key, which the person
 * pastes into the secret store with their username and password.
 */
export const VPN_SERVER_DEFAULTS = {
  remotes:      [{ host: 'us.vpn1.suse.net', port: 1194, proto: 'udp' }, { host: 'us.vpn2.suse.net', port: 1194, proto: 'udp' }],
  remoteRandom: true,
  auth:         'SHA512',
  cipher:       'AES-256-GCM',
  keyDirection: 1,
  ping:         10,
  pingRestart:  120,
  // The routes the server pushes, as NetworkManager takes them: on the desktop that is 10.0.0.0/8
  // (the lab, 10.115.0.0/16, among them), 147.2.0.0/16 and 149.44.0.0/16. Never the default route.
  // The cluster's own ranges stay local inside 10/8: the node's pod route (10.42.0.0/24 on cni0) is
  // the more specific, and service addresses (10.43) are rewritten to pods before routing.
  pullRoutes:   true,
  // Used only with pullRoutes off: the routes to take instead of the server's.
  routes:       [{ network: '10.115.0.0', mask: '255.255.0.0' }],
};

/** openvpn's config for one login, the files beside it in `dir`. */
export function vpnConfig(server, dir) {
  const s = { ...VPN_SERVER_DEFAULTS, ...(server || {}) };

  return [
    'client',
    'dev tun',
    'nobind',
    ...s.remotes.map((r) => `remote ${ r.host } ${ r.port } ${ r.proto || 'udp' }`),
    ...(s.remoteRandom ? ['remote-random'] : []),
    'resolv-retry 30',
    'remote-cert-tls server',
    `auth ${ s.auth }`,
    // NetworkManager's `cipher`: the data channel cipher, and the one to fall back on with a server
    // that does not negotiate.
    ...(s.cipher ? [`data-ciphers ${ s.cipher }`, `data-ciphers-fallback ${ s.cipher }`] : []),
    ...(s.ping ? [`ping ${ s.ping }`] : []),
    ...(s.pingRestart ? [`ping-restart ${ s.pingRestart }`] : []),
    `ca ${ dir }/ca.pem`,
    `tls-auth ${ dir }/ta.pem ${ s.keyDirection }`,
    // No file: the controller answers on the management interface, which is how a code can be.
    'auth-user-pass',
    // After a refusal that carries a challenge, ask again rather than exit.
    'auth-retry interact',
    // The node's routes are every pod's. The server's, as the desktop takes them - but never its
    // default route, which would take every pod's traffic, the node's own included - or, with
    // pullRoutes off, none of the server's and only the ones given.
    ...(s.pullRoutes
      ? ['pull-filter ignore "redirect-gateway"']
      : ['route-nopull', ...s.routes.map((r) => `route ${ r.network } ${ r.mask }`)]),
    // DNS the server pushes is for the desktop's resolver; a pod uses the cluster's. Addresses work.
    'pull-filter ignore "dhcp-option"',
    `management ${ dir }/mgmt.sock unix`,
    'management-query-passwords',
    'management-hold',
    'verb 3',
  ].join('\n');
}

/* global net, http, fs, spawn, vpnConfig */
/**
 * The controller, as it runs in the pod. Never called here: shipped as text (vpnControllerSource),
 * where `net`, `http`, `fs` and `spawn` are the pod file's own imports.
 */
function vpnControllerMain() {
  const TOKEN = process.env.VPN_TOKEN || '';
  const RUN = process.env.VPN_RUN_DIR || '/run/vpn';
  const BIN = process.env.VPN_OPENVPN || 'openvpn';
  let child = null;
  let sock = null;
  let session = null;
  let log = [];
  let state = {
    phase: 'need-login', note: 'Nobody has logged in since the VPN pod started.', since: '', address: '', server: '', at: new Date().toISOString(),
  };
  let waiters = [];

  const note = (line) => {
    log.push(`${ new Date().toISOString() } ${ line }`);
    log = log.slice(-200);
  };
  const setState = (s) => {
    const connected = s.phase === 'connected';

    state = {
      ...state, ...s, since: connected ? (s.since || state.since) : '', address: connected ? (s.address || state.address) : '', server: connected ? (s.server || state.server) : '', at: new Date().toISOString(),
    };
    note(`state ${ state.phase }${ state.note ? `: ${ state.note }` : '' }`);
    const ready = waiters;

    waiters = [];
    ready.forEach((w) => w());
  };
  const settled = () => ['connected', 'need-login', 'failed', 'down'].includes(state.phase);

  function stop(why = '') {
    if (sock) {
      try {
        sock.write('signal SIGTERM\n');
      } catch { /* gone */ }
      sock.destroy();
      sock = null;
    }
    if (child) {
      try {
        child.kill('SIGTERM');
      } catch { /* gone */ }
      child = null;
    }
    session = null;
    try {
      fs.rmSync(RUN, { recursive: true, force: true });
    } catch { /* nothing there */ }
    if (why) {
      setState({ phase: 'need-login', note: why });
    }
  }

  function manage(attempt = 0) {
    const s = net.connect(`${ RUN }/mgmt.sock`);
    let buf = '';

    s.on('connect', () => {
      sock = s;
      s.write('state on\n');
    });
    s.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let i;

      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).replace(/\r$/, '');

        buf = buf.slice(i + 1);
        if (!line.startsWith('>')) {
          continue;
        }
        if (!line.startsWith('>PASSWORD') && !line.startsWith('>INFO') && !line.startsWith('>LOG')) {
          note(line.slice(0, 200));
        }
        const step = managementStep(line, session || newSession());

        for (const out of step.send) {
          s.write(`${ out }\n`);
        }
        if (step.state) {
          setState(step.state);
        }
        if (step.end) {
          const keep = state;

          stop();
          state = keep;
        }
      }
    });
    s.on('error', () => {
      if (!sock && child && attempt < 40) {
        setTimeout(() => manage(attempt + 1), 250);
      }
    });
  }

  function login(body) {
    stop();
    const server = body.server || {};

    fs.mkdirSync(RUN, { recursive: true, mode: 0o700 });
    fs.writeFileSync(`${ RUN }/ca.pem`, `${ String(body.ca || '').trim() }\n`, { mode: 0o600 });
    fs.writeFileSync(`${ RUN }/ta.pem`, `${ String(body.ta || '').trim() }\n`, { mode: 0o600 });
    fs.writeFileSync(`${ RUN }/vpn.conf`, vpnConfig(server, RUN), { mode: 0o600 });
    session = newSession({ username: body.username, password: body.password, otp: String(body.otp || '').trim() });
    setState({ phase: 'connecting', note: 'starting openvpn' });
    child = spawn(BIN, ['--config', `${ RUN }/vpn.conf`], { stdio: ['ignore', 'pipe', 'pipe'] });
    const mine = child;

    child.stdout.on('data', (d) => String(d).split('\n').filter(Boolean).forEach((l) => note(`openvpn: ${ l.slice(0, 300) }`)));
    child.stderr.on('data', (d) => String(d).split('\n').filter(Boolean).forEach((l) => note(`openvpn: ${ l.slice(0, 300) }`)));
    child.on('exit', (code) => {
      if (child !== mine) {
        return;
      }
      child = null;
      sock = null;
      if (!['need-login', 'failed'].includes(state.phase)) {
        setState({ phase: 'down', note: `openvpn stopped (exit ${ code })` });
      }
    });
    setTimeout(() => manage(), 300);
  }

  const send = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  http.createServer((req, res) => {
    if (req.url === '/healthz') {
      return send(res, 200, { ok: true });
    }
    if (!TOKEN || req.headers.authorization !== `Bearer ${ TOKEN }`) {
      return send(res, 401, { error: 'unauthorized' });
    }
    let raw = '';

    req.on('data', (d) => {
      raw += d;
    }).on('end', () => {
      const body = (() => {
        try {
          return JSON.parse(raw || '{}');
        } catch {
          return {};
        }
      })();

      if (req.method === 'GET' && req.url === '/status') {
        return send(res, 200, { ...state, log: log.slice(-30) });
      }
      if (req.method === 'POST' && req.url === '/logout') {
        stop('Logged out.');

        return send(res, 200, state);
      }
      if (req.method === 'POST' && req.url === '/login') {
        if (!body.username || !body.password || !body.otp || !body.ca || !body.ta) {
          return send(res, 400, { error: 'A login needs the username, password, code and the profile\'s CA and TLS key.' });
        }
        login(body);
        const wait = Math.min(Number(body.waitMs) || 45_000, 90_000);
        const done = () => send(res, 200, state);
        const timer = setTimeout(done, wait);
        const check = () => {
          if (settled()) {
            clearTimeout(timer);
            done();
          } else {
            waiters.push(check);
          }
        };

        return waiters.push(check);
      }

      return send(res, 404, { error: 'no such path' });
    });
  }).listen(Number(process.env.VPN_CONTROL_PORT || 18091), '0.0.0.0');
}

/** The controller's file, as the pod runs it: its imports, the pure parts, and the main. */
export function vpnControllerSource() {
  return [
    '// Generated by dev-api from vpn-pod.mjs and vpn-management.mjs. Do not edit here.',
    "import net from 'node:net';",
    "import http from 'node:http';",
    "import fs from 'node:fs';",
    "import { spawn } from 'node:child_process';",
    `const VPN_SERVER_DEFAULTS = ${ JSON.stringify(VPN_SERVER_DEFAULTS) };`,
    `const vpnB64 = ${ vpnB64.toString() };`,
    `const vpnUnb64 = ${ vpnUnb64.toString() };`,
    mgmtQuote.toString(),
    readCrv1.toString(),
    newSession.toString(),
    managementStep.toString(),
    vpnConfig.toString(),
    vpnControllerMain.toString(),
    'vpnControllerMain();',
    '',
  ].join('\n');
}

/** A short, stable fingerprint of a text (FNV-1a), so the pod rolls when its files change. */
export function vpnHash(text) {
  let h = 0x811c9dc5;

  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }

  return h.toString(16).padStart(8, '0');
}

/** What the pod runs first: openvpn, then the controller. */
export function vpnStartScript() {
  return [
    '#!/bin/sh',
    'set -eu',
    'apk add --no-cache openvpn >/dev/null 2>&1 || { echo "could not install openvpn"; exit 1; }',
    `export VPN_CONTROL_PORT=${ VPN_CONTROL_PORT }`,
    'exec node /app/controller.mjs',
    '',
  ].join('\n');
}

/** The objects, all in `namespace`: the token, the files, the pod and the Service in front of it. */
export function vpnObjects({ namespace, token }) {
  const labels = { 'app.kubernetes.io/name': VPN_NAME, 'dev.rancher.io/tool': 'vpn' };

  return [
    {
      apiVersion: 'v1',
      kind:       'Secret',
      metadata:   { name: `${ VPN_NAME }-token`, namespace, labels },
      type:       'Opaque',
      stringData: { token },
    },
    {
      apiVersion: 'v1',
      kind:       'ConfigMap',
      metadata:   { name: `${ VPN_NAME }-app`, namespace, labels },
      data:       { 'controller.mjs': vpnControllerSource(), 'start.sh': vpnStartScript() },
    },
    {
      apiVersion: 'apps/v1',
      kind:       'Deployment',
      metadata:   { name: VPN_NAME, namespace, labels },
      spec:       {
        replicas: 1,
        // One tunnel: a second pod during a rollout would be a second login.
        strategy: { type: 'Recreate' },
        selector: { matchLabels: { 'app.kubernetes.io/name': VPN_NAME } },
        template: {
          metadata: { labels, annotations: { 'dev.rancher.io/vpn-app': vpnHash(vpnControllerSource() + vpnStartScript()) } },
          spec:     {
            // The node's network: the tunnel and its one route are then every pod's.
            hostNetwork: true,
            dnsPolicy:   'ClusterFirstWithHostNet',
            containers:  [{
              name:            'vpn',
              image:           'node:24-alpine',
              command:         ['/bin/sh', '/app/start.sh'],
              env:             [{ name: 'VPN_TOKEN', valueFrom: { secretKeyRef: { name: `${ VPN_NAME }-token`, key: 'token' } } }],
              ports:           [{ name: 'control', containerPort: VPN_CONTROL_PORT }],
              securityContext: { capabilities: { add: ['NET_ADMIN'] } },
              readinessProbe:  { httpGet: { path: '/healthz', port: VPN_CONTROL_PORT }, periodSeconds: 5 },
              resources:       { requests: { cpu: '10m', memory: '48Mi' }, limits: { memory: '192Mi' } },
              volumeMounts:    [
                { name: 'app', mountPath: '/app' },
                { name: 'tun', mountPath: '/dev/net/tun' },
                { name: 'run', mountPath: '/run/vpn' },
              ],
            }],
            volumes: [
              { name: 'app', configMap: { name: `${ VPN_NAME }-app` } },
              { name: 'tun', hostPath: { path: '/dev/net/tun', type: 'CharDevice' } },
              { name: 'run', emptyDir: { medium: 'Memory', sizeLimit: '1Mi' } },
            ],
          },
        },
      },
    },
    {
      apiVersion: 'v1',
      kind:       'Service',
      metadata:   { name: VPN_NAME, namespace, labels },
      spec:       {
        selector: { 'app.kubernetes.io/name': VPN_NAME },
        ports:    [{ name: 'control', port: VPN_CONTROL_PORT, targetPort: VPN_CONTROL_PORT }],
      },
    },
  ];
}
