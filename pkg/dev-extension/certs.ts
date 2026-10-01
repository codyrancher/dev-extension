// Certificates for every public share, as a property of the cluster rather than of an app.
//
// The history is worth two sentences, because it is the reason this is shaped the way it is.
// The certificate started as a sidecar inside the Share tab's app, which worked - for shares
// made by the Share tab. Agents make shares too, through a skill with an app of its own, and so
// does anyone with kubectl; those had no certificate and nothing said so, because the thing that
// asked for one was a detail of a template nobody else used. What every share does have is an
// Ingress with a public name, so the asking moved there: one small controller per cluster that
// watches Ingresses and certifies any public name it finds. Whoever makes a share, however they
// make it, the certificate happens.
//
// What it is: a Deployment of two containers in `dev-certs` on the share's own cluster. The
// `control` container is a node script (certs/control.mjs) that does the watching, the
// Kubernetes work and the serving of the challenge; the `acme` container is acme.sh, which does
// the ACME protocol and nothing else. They pass work between them through one emptyDir, so
// neither needs to know how the other does its job.
//
// The one setting is the Let's Encrypt account email (Settings > Tokens). It is put into a
// Secret beside the controller when the controller is installed, so it reaches the cluster once
// rather than being handed in by whoever makes each share - which is exactly the thing that
// made the old arrangement silently do nothing.

import { clusterBase, devFetch, readSecretStore } from './api';
import { CERT_CONTROL } from './certs.generated';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

export const CERTS_NAMESPACE = 'dev-certs';
export const CERTS_NAME = 'dev-certs';
const CERTS_PORT = 8080;

/**
 * acme.sh, driven by the directory the control container writes into.
 *
 * Deliberately almost nothing: a file named after a host appears, this asks Let's Encrypt for a
 * certificate for that host over HTTP-01, and writes the result where the control container will
 * find it. `--webroot` only writes the challenge file; serving it is the other container's job,
 * which is why both mount the same directory.
 *
 * A failure leaves a marker rather than retrying in here. The control container decides when to
 * try again, because it is the one that knows whether the name still exists.
 */
const RUNNER = [
  'set -u',
  'mkdir -p /work/acme /work/certs /work/requests /work/failed',
  // Read from the mounted Secret every time rather than copied once at start: the Secret is
  // written by the browser and can arrive, or change, after this container is running.
  'email() { cat /secret/email 2>/dev/null; }',
  'if [ -z "$(email)" ]; then echo "[acme] no account email yet; waiting"; fi',
  // Registered once, explicitly, and said out loud. Left to happen inside the first issue it
  // failed silently with a message about an EAB key - the image ships an account.conf with
  // ZeroSSL credentials in it, and acme.sh reads that unless it is pointed somewhere else
  // (ACCOUNT_CONF_PATH, in the container's environment). An unregistered account then takes
  // every issue down with it, which is what it looked like from the outside.
  'registered=no',
  'register() {',
  '  [ "$registered" = yes ] && return 0',
  '  [ -n "$(email)" ] || return 1',
  '  if acme.sh --register-account -m "$(email)" --server letsencrypt; then',
  '    registered=yes',
  '    echo "[acme] account registered for $(email)"',
  '    return 0',
  '  fi',
  '  echo "[acme] the account could not be registered"',
  '  return 1',
  '}',
  'while :; do',
  '  for f in /work/requests/*; do',
  '    [ -f "$f" ] || continue',
  '    h=$(basename "$f")',
  '    rm -f "$f"',
  '    if ! register; then date +%s > "/work/failed/$h"; continue; fi',
  '    echo "[acme] asking for $h"',
  // No `--log /dev/stdout`, which is not the harmless thing it looks like: acme.sh builds the
  // CSR's subjectAltName through a command substitution, and with the log pointed at stdout its
  // own debug lines are captured into the value. The CSR config then has a log line where the
  // domain should be, and openssl refuses it - "missing close square bracket" - for every name,
  // every time. Its ordinary output already goes to the container log.
  '    if acme.sh --issue -d "$h" -w /work/acme --server letsencrypt --keylength ec-256; then',
  '      acme.sh --install-cert -d "$h" --ecc --fullchain-file "/work/certs/$h.crt" --key-file "/work/certs/$h.key"',
  '      echo "[acme] $h done"',
  '    else',
  // Clear what the failed attempt left. acme.sh appends to the CSR config it wrote last time
  // and the file it writes has no trailing newline, so a second attempt for the same name
  // produces a config openssl refuses to parse - "missing close square bracket" - and the name
  // can then never be issued again until the directory goes.
  '      rm -rf "/acme-state/${h}_ecc" "/acme-state/${h}"',
  '      date +%s > "/work/failed/$h"',
  '      echo "[acme] $h failed"',
  '    fi',
  '  done',
  '  sleep 5',
  'done',
].join('\n');

/** One object, created if it is missing and rewritten when what we want differs from what is there. */
async function ensureOn(cluster: string, kind: string, namespace: string, name: string, body: Json, differs: (existing: Json) => boolean): Promise<void> {
  const base = clusterBase(cluster);
  const path = namespace ? `${ base }/v1/${ kind }/${ namespace }/${ name }` : `${ base }/v1/${ kind }/${ name }`;
  const existing = await devFetch(path).catch(() => null);

  if (!existing) {
    await devFetch(namespace ? `${ base }/v1/${ kind }` : `${ base }/v1/${ kind }`, { method: 'POST', body: JSON.stringify(body) });

    return;
  }
  if (differs(existing)) {
    await devFetch(path, { method: 'PUT', body: JSON.stringify({ ...existing, ...body, metadata: { ...existing.metadata, ...body.metadata } }) });
  }
}

/**
 * Put the controller on one cluster, and keep it current.
 *
 * Safe to call on every page load: each object is compared with what is wanted and only written
 * when it differs. The pod is replaced when the scripts change, because node read them at start.
 */
export async function ensureCertController(cluster: string): Promise<void> {
  const base = clusterBase(cluster);
  const labels = { app: CERTS_NAME };
  const email = String((await readSecretStore().catch(() => ({} as Record<string, string>))).LETSENCRYPT_EMAIL || '').trim();

  if (!email) {
    return;
  }

  await ensureOn(cluster, 'namespaces', '', CERTS_NAMESPACE, {
    apiVersion: 'v1', kind: 'Namespace', metadata: { name: CERTS_NAMESPACE, labels },
  }, () => false);

  await ensureOn(cluster, 'serviceaccounts', CERTS_NAMESPACE, CERTS_NAME, {
    apiVersion: 'v1', kind: 'ServiceAccount', metadata: { namespace: CERTS_NAMESPACE, name: CERTS_NAME, labels },
  }, () => false);

  // Ingresses everywhere, because a share can be in any namespace; Secrets, because that is
  // where a certificate goes. Nothing else: this does not need to see a workload or a config.
  await ensureOn(cluster, 'rbac.authorization.k8s.io.clusterroles', '', CERTS_NAME, {
    apiVersion: 'rbac.authorization.k8s.io/v1',
    kind:       'ClusterRole',
    metadata:   { name: CERTS_NAME, labels },
    rules:      [
      { apiGroups: ['networking.k8s.io'], resources: ['ingresses'], verbs: ['get', 'list', 'watch', 'create', 'update', 'patch', 'delete'] },
      { apiGroups: [''], resources: ['secrets'], verbs: ['get', 'list', 'create', 'update', 'patch'] },
    ],
  }, (existing: Json) => JSON.stringify(existing.rules) !== JSON.stringify([
    { apiGroups: ['networking.k8s.io'], resources: ['ingresses'], verbs: ['get', 'list', 'watch', 'create', 'update', 'patch', 'delete'] },
    { apiGroups: [''], resources: ['secrets'], verbs: ['get', 'list', 'create', 'update', 'patch'] },
  ]));

  await ensureOn(cluster, 'rbac.authorization.k8s.io.clusterrolebindings', '', CERTS_NAME, {
    apiVersion: 'rbac.authorization.k8s.io/v1',
    kind:       'ClusterRoleBinding',
    metadata:   { name: CERTS_NAME, labels },
    roleRef:    { apiGroup: 'rbac.authorization.k8s.io', kind: 'ClusterRole', name: CERTS_NAME },
    subjects:   [{ kind: 'ServiceAccount', name: CERTS_NAME, namespace: CERTS_NAMESPACE }],
  }, () => false);

  // The account email, beside the controller rather than in anybody's values: it reaches the
  // cluster once, here, and every share made afterwards is certified without being told about it.
  const secretUrl = `${ base }/v1/secrets/${ CERTS_NAMESPACE }/${ CERTS_NAME }`;
  const secretBody = {
    apiVersion: 'v1',
    kind:       'Secret',
    type:       'Opaque',
    metadata:   { namespace: CERTS_NAMESPACE, name: CERTS_NAME, labels },
    data:       { email: btoa(email) },
  };
  const secret = await devFetch(secretUrl).catch(() => null);

  if (!secret) {
    await devFetch(`${ base }/v1/secrets`, { method: 'POST', body: JSON.stringify(secretBody) }).catch(() => null);
  } else if (secret.data?.email !== secretBody.data.email) {
    await devFetch(secretUrl, { method: 'PUT', body: JSON.stringify({ ...secret, data: secretBody.data }) }).catch(() => null);
  }

  const data = { 'control.mjs': CERT_CONTROL, 'runner.sh': RUNNER };
  const mapUrl = `${ base }/v1/configmaps/${ CERTS_NAMESPACE }/${ CERTS_NAME }`;
  const map = await devFetch(mapUrl).catch(() => null);
  let rolled = false;

  if (!map) {
    await devFetch(`${ base }/v1/configmaps`, {
      method: 'POST',
      body:   JSON.stringify({
        apiVersion: 'v1', kind: 'ConfigMap', metadata: { namespace: CERTS_NAMESPACE, name: CERTS_NAME, labels }, data,
      }),
    });
  } else if (Object.keys(data).some((key) => (map.data || {})[key] !== (data as Record<string, string>)[key])) {
    await devFetch(mapUrl, { method: 'PUT', body: JSON.stringify({ ...map, data }) });
    rolled = true;
  }

  await ensureOn(cluster, 'services', CERTS_NAMESPACE, CERTS_NAME, {
    apiVersion: 'v1',
    kind:       'Service',
    metadata:   { namespace: CERTS_NAMESPACE, name: CERTS_NAME, labels },
    spec:       { selector: labels, ports: [{ name: 'http', port: CERTS_PORT, targetPort: 'http' }] },
  }, () => false);

  await ensureOn(cluster, 'apps.deployments', CERTS_NAMESPACE, CERTS_NAME, {
    apiVersion: 'apps/v1',
    kind:       'Deployment',
    metadata:   { namespace: CERTS_NAMESPACE, name: CERTS_NAME, labels },
    spec:       {
      replicas: 1,
      selector: { matchLabels: labels },
      strategy: { type: 'Recreate' },
      template: {
        metadata: { labels },
        spec:     {
          serviceAccountName: CERTS_NAME,
          containers:         [
            {
              name:         'control',
              image:        'node:24-alpine',
              command:      ['node', '/scripts/control.mjs'],
              ports:        [{ name: 'http', containerPort: CERTS_PORT }],
              env:          [
                { name: 'PORT', value: String(CERTS_PORT) },
                // Every call this makes is to the apiserver over TLS, and node's fetch trusts
                // the system store alone: without this each one fails as "fetch failed", with
                // nothing to say it was the certificate.
                { name: 'NODE_EXTRA_CA_CERTS', value: '/var/run/secrets/kubernetes.io/serviceaccount/ca.crt' },
              ],
              volumeMounts: [
                { name: 'scripts', mountPath: '/scripts' },
                { name: 'work', mountPath: '/work' },
              ],
              resources: { requests: { cpu: '10m', memory: '48Mi' }, limits: { memory: '192Mi' } },
            },
            {
              name:    'acme',
              image:   'neilpang/acme.sh:3.1.6',
              command: ['/bin/sh', '/scripts/runner.sh'],
              env:     [
                { name: 'LE_CONFIG_HOME', value: '/acme-state' },
                // Away from the image's own, which carries ZeroSSL EAB credentials that make
                // registering a Let's Encrypt account fail. See RUNNER.
                { name: 'ACCOUNT_CONF_PATH', value: '/acme-state/account.conf' },
              ],
              volumeMounts: [
                { name: 'scripts', mountPath: '/scripts' },
                { name: 'work', mountPath: '/work' },
                { name: 'state', mountPath: '/acme-state' },
                { name: 'email', mountPath: '/secret', readOnly: true },
              ],
              resources: { requests: { cpu: '10m', memory: '32Mi' }, limits: { memory: '128Mi' } },
            },
          ],
          volumes: [
            { name: 'scripts', configMap: { name: CERTS_NAME } },
            { name: 'work', emptyDir: {} },
            { name: 'state', emptyDir: {} },
            { name: 'email', secret: { secretName: CERTS_NAME } },
          ],
        },
      },
    },
  }, () => false);

  if (rolled) {
    // node read the script at start, so the pod is replaced rather than asked to notice.
    const pods = await devFetch(`${ base }/v1/pods/${ CERTS_NAMESPACE }?labelSelector=app%3D${ CERTS_NAME }`).catch(() => null);

    for (const pod of pods?.data || []) {
      await devFetch(`${ base }/v1/pods/${ CERTS_NAMESPACE }/${ pod.metadata.name }`, { method: 'DELETE' }).catch(() => null);
    }
  }
}

/** The clusters this page load has already put the controller on, so a poll does not re-check. */
const done = new Set<string>();

/**
 * Keep the controller on every cluster that serves a public share.
 *
 * Called from the sidebar's poll, which is where everything else that has to exist is kept
 * existing. Once per cluster per page load: the objects do not change under us, and a refresh
 * every few seconds asking six questions of four clusters is a poll nobody wanted.
 */
export async function ensureCertControllers(clusters: string[]): Promise<void> {
  for (const cluster of clusters) {
    if (cluster && !done.has(cluster)) {
      done.add(cluster);
      await ensureCertController(cluster).catch((e) => {
        done.delete(cluster);
        console.error(`[dev] the certificate controller could not be put on ${ cluster }:`, e?.message || e); // eslint-disable-line no-console
      });
    }
  }
}
