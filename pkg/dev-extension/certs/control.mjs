// The certificate controller: every public share on this cluster gets a real certificate.
//
// It watches Ingresses rather than belonging to any one app, and that is the whole point. A
// share here is made by several different things - the Share tab, the agents' share skill, an
// agent with kubectl, a hand-written manifest - and while the certificate lived inside one
// app's template, the shares made by the other three had none. What every one of them does have
// is an Ingress with a public name on it, so that is what this acts on: have a name, get a
// certificate, whoever made you.
//
// How a challenge is answered, which is the only subtle part. Let's Encrypt fetches
// `http://<host>/.well-known/acme-challenge/<token>` from the name it is certifying, and that
// name is already routed to the share. So before asking, this puts up an Ingress of its own for
// that one path on that one host, pointing at this pod; the ingress controller prefers the
// longer path, so the challenge comes here while everything else still goes to the share. It is
// taken down as soon as the certificate is in hand.
//
// Issuance itself is the acme container next door (see RUNNER in certs.ts): this writes a file
// naming a host into the shared directory and waits for the certificate to appear beside it.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';

const SA = '/var/run/secrets/kubernetes.io/serviceaccount';
const API = 'https://kubernetes.default.svc';
const NAMESPACE = fs.readFileSync(`${ SA }/namespace`, 'utf8').trim();
const WORK = process.env.ACME_WORK || '/work';
const PORT = Number(process.env.PORT || 8080);
const EVERY_MS = Number(process.env.SWEEP_MS || 60000);

// A name is worth asking about when it is public and short enough to be certified. sslip.io
// resolves a name with an address in it, which is what every share here is served on; anything
// else on this cluster is somebody else's business. 64 is the Common Name field, which Let's
// Encrypt still fills in, so a longer name is refused minutes later rather than now.
const PUBLIC_HOST = /\.sslip\.io$/;
const MAX_HOST = 64;

/** Opt out, for an Ingress that should keep whatever certificate it has. */
const SKIP = 'dev.rancher.io/no-certificate';

/** A month: the usual renewal window for a 90-day certificate. */
const RENEW_BEFORE_MS = 30 * 24 * 3600 * 1000;

/** How long to wait for one certificate before giving up and trying again next sweep. */
const ISSUE_TIMEOUT_MS = 4 * 60 * 1000;

const token = () => fs.readFileSync(`${ SA }/token`, 'utf8').trim();

async function k8s(url, options = {}) {
  const response = await fetch(`${ API }${ url }`, {
    ...options,
    headers: { authorization: `Bearer ${ token() }`, 'content-type': options.patchType || 'application/json' },
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    const error = new Error(`${ options.method || 'GET' } ${ url } -> ${ response.status } ${ body.slice(0, 300) }`);

    error.status = response.status;
    throw error;
  }

  return response.status === 204 ? null : response.json();
}

// ── What is on the cluster ──────────────────────────────────────────────────────────────────

async function ingresses() {
  const list = await k8s('/apis/networking.k8s.io/v1/ingresses');

  return (list.items || []).filter((ing) => !(ing.metadata?.annotations || {})[SKIP]);
}

/** The names one Ingress serves that are worth a certificate. */
function hostsOf(ing) {
  const found = new Set();

  for (const rule of ing.spec?.rules || []) {
    const host = String(rule.host || '');

    if (PUBLIC_HOST.test(host) && host.length <= MAX_HOST) {
      found.add(host);
    }
  }

  return [...found];
}

/** What a certificate covers and until when, or null for anything that is not one. */
function describe(pem) {
  try {
    const cert = new crypto.X509Certificate(pem);
    const names = String(cert.subjectAltName || '').split(',')
      .map((part) => part.trim())
      .filter((part) => part.startsWith('DNS:'))
      .map((part) => part.slice(4));

    return { names, until: Date.parse(cert.validTo) };
  } catch {
    return null;
  }
}

/** Whether a certificate covers these names and is not near expiry. */
function covers(pem, hosts) {
  const cert = describe(pem);

  return !!cert && hosts.every((host) => cert.names.includes(host)) && cert.until - Date.now() > RENEW_BEFORE_MS;
}

async function readSecret(namespace, name) {
  try {
    return await k8s(`/api/v1/namespaces/${ namespace }/secrets/${ name }`);
  } catch (e) {
    if (e.status === 404) {
      return null;
    }
    throw e;
  }
}

const decode = (value) => Buffer.from(value || '', 'base64').toString('utf8');
const encode = (value) => Buffer.from(value, 'utf8').toString('base64');

async function writeSecret(namespace, name, crt, key, hosts) {
  const body = {
    apiVersion: 'v1',
    kind:       'Secret',
    type:       'kubernetes.io/tls',
    metadata:   {
      name,
      namespace,
      labels:      { 'dev.rancher.io/certificate': 'true' },
      annotations: {
        'dev.rancher.io/acme-host':    hosts.join(','),
        'dev.rancher.io/acme-expires': new Date(describe(crt)?.until || Date.now()).toISOString(),
      },
    },
    data: { 'tls.crt': encode(crt), 'tls.key': encode(key) },
  };

  if (await readSecret(namespace, name)) {
    await k8s(`/api/v1/namespaces/${ namespace }/secrets/${ name }`, { method: 'PUT', body: JSON.stringify(body) });
  } else {
    await k8s(`/api/v1/namespaces/${ namespace }/secrets`, { method: 'POST', body: JSON.stringify(body) });
  }
}

/**
 * Point the Ingress at the Secret.
 *
 * A merge patch of `spec.tls` alone: everything else on that Ingress belongs to whoever made it,
 * and a share is re-rendered by Fleet or by a skill at any time. This is the one field this owns.
 */
async function attach(ing, secretName, hosts) {
  const tls = ing.spec?.tls || [];
  const already = tls.some((entry) => entry.secretName === secretName && hosts.every((host) => (entry.hosts || []).includes(host)));

  if (already) {
    return false;
  }
  const kept = tls.filter((entry) => entry.secretName !== secretName);

  await k8s(`/apis/networking.k8s.io/v1/namespaces/${ ing.metadata.namespace }/ingresses/${ ing.metadata.name }`, {
    method:    'PATCH',
    patchType: 'application/merge-patch+json',
    body:      JSON.stringify({ spec: { tls: [...kept, { hosts, secretName }] } }),
  });

  return true;
}

// ── Asking for one ──────────────────────────────────────────────────────────────────────────

const solverName = (host) => `acme-${ crypto.createHash('sha1').update(host).digest('hex').slice(0, 20) }`;

/**
 * The Ingress that answers the challenge, for as long as it takes.
 *
 * One path on one host, pointing here. The ingress controller prefers the longer path, so the
 * share underneath goes on serving everything else while this is up.
 */
async function solver(host, ingressClass, up) {
  const name = solverName(host);
  const url = `/apis/networking.k8s.io/v1/namespaces/${ NAMESPACE }/ingresses`;

  await k8s(`${ url }/${ name }`, { method: 'DELETE' }).catch(() => null);

  if (!up) {
    return;
  }
  const body = {
    apiVersion: 'networking.k8s.io/v1',
    kind:       'Ingress',
    metadata:   { name, namespace: NAMESPACE, labels: { 'dev.rancher.io/acme-solver': 'true' } },
    spec:       {
      ...(ingressClass ? { ingressClassName: ingressClass } : {}),
      rules: [{
        host,
        http: {
          paths: [{
            path: '/.well-known/acme-challenge/', pathType: 'Prefix', backend: { service: { name: 'dev-certs', port: { number: PORT } } },
          }],
        },
      }],
    },
  };

  await k8s(url, { method: 'POST', body: JSON.stringify(body) });
}

/** Ask the acme container for one, and wait for it. */
async function issue(host, ingressClass) {
  const crtFile = path.join(WORK, 'certs', `${ host }.crt`);
  const keyFile = path.join(WORK, 'certs', `${ host }.key`);

  fs.rmSync(crtFile, { force: true });
  fs.rmSync(path.join(WORK, 'failed', host), { force: true });
  await solver(host, ingressClass, true);

  try {
    // A moment for the ingress controller to notice the solver before the order is placed: a
    // challenge fetched before its route exists is a failed validation, and that is the rate
    // limit that bites hardest.
    await new Promise((resolve) => setTimeout(resolve, 5000));
    fs.writeFileSync(path.join(WORK, 'requests', host), '');

    const until = Date.now() + ISSUE_TIMEOUT_MS;

    while (Date.now() < until) {
      if (fs.existsSync(crtFile) && fs.existsSync(keyFile)) {
        return { crt: fs.readFileSync(crtFile, 'utf8'), key: fs.readFileSync(keyFile, 'utf8') };
      }
      if (fs.existsSync(path.join(WORK, 'failed', host))) {
        throw new Error('the acme client could not get a certificate; see the acme container\'s log');
      }
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
    throw new Error('timed out waiting for the certificate');
  } finally {
    await solver(host, ingressClass, false).catch(() => null);
  }
}

// ── The sweep ───────────────────────────────────────────────────────────────────────────────

/** Where a certificate is kept once it exists, so a share rebuilt under the same name reuses it. */
const cacheName = (host) => `cert-${ host.replace(/[^a-z0-9-]/g, '-') }`.slice(0, 253);

async function fromCache(host) {
  const secret = await readSecret(NAMESPACE, cacheName(host));
  const crt = decode(secret?.data?.['tls.crt']);

  return secret && covers(crt, [host]) ? { crt, key: decode(secret.data['tls.key']) } : null;
}

async function sweep() {
  for (const ing of await ingresses()) {
    const hosts = hostsOf(ing);

    if (!hosts.length) {
      continue;
    }
    const namespace = ing.metadata.namespace;
    const name = `${ ing.metadata.name }-tls`;
    // One name per certificate. A certificate naming several is re-issued whenever the set
    // changes, and a share's set changes every time one is added or removed.
    const host = hosts[0];

    try {
      const have = await readSecret(namespace, name);

      if (have && covers(decode(have.data?.['tls.crt']), [host])) {
        if (await attach(ing, name, [host])) {
          console.log(`[certs] ${ namespace }/${ ing.metadata.name }: serving ${ host }`);
        }
        continue;
      }

      const cached = await fromCache(host);
      const got = cached || await issue(host, ing.spec?.ingressClassName || '');

      await writeSecret(namespace, name, got.crt, got.key, [host]);
      if (!cached) {
        await writeSecret(NAMESPACE, cacheName(host), got.crt, got.key, [host]);
      }
      await attach(ing, name, [host]);
      console.log(`[certs] ${ namespace }/${ ing.metadata.name }: ${ cached ? 'reused' : 'issued' } a certificate for ${ host }`);
    } catch (e) {
      console.error(`[certs] ${ namespace }/${ ing.metadata.name }: ${ e.message || e }`);
    }
  }
}

// ── Answering the challenge ─────────────────────────────────────────────────────────────────

const root = path.join(WORK, 'acme');

http.createServer((req, res) => {
  const asked = path.normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname));
  const file = path.join(root, asked);

  if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not here\n');

    return;
  }
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end(fs.readFileSync(file));
}).listen(PORT, () => console.log(`[certs] serving challenges on :${ PORT }, sweeping every ${ EVERY_MS / 1000 }s`));

for (const dir of ['acme', 'certs', 'requests', 'failed']) {
  fs.mkdirSync(path.join(WORK, dir), { recursive: true });
}

const tick = async() => {
  try {
    await sweep();
  } catch (e) {
    console.error('[certs] sweep:', e.message || e);
  }
};

tick();
setInterval(tick, EVERY_MS);
