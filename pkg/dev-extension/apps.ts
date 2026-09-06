// Apps Plus is where a workspace's template lives.
//
// This product used to carry its own list of templates - a container image, a port, a script -
// and its own code for turning one into a namespace, a Deployment and a Service. Apps Plus is
// already that: an App is a set of Kubernetes manifests with ${values} in them, and an
// Installation of it is Fleet applying those manifests to a cluster. So a template here IS an
// Apps Plus App, and a workspace IS an Installation of one, and the code that used to render a
// template into objects is gone in favour of the code that already does.
//
// Everything below goes through Apps Plus's own store models rather than raw HTTP, and that is
// load-bearing. Apps Plus has no controller in the cluster: an Installation is rendered into a
// Fleet Bundle by its model's `reconcile()`, in the browser, when the model is saved. An
// AppInstance object POSTed by hand is a record with nothing behind it until somebody opens
// Apps Plus. Going through `management/create` + `save()` gets that model, with its reconcile,
// and the Bundle appears the moment the workspace does.
//
// The models are there because Apps Plus is installed in the Rancher this product is served
// from. Where it is not, everything here fails with the one error that says so.

import {
  APP, APP_INSTANCE, LABEL_WORKSPACE, LABEL_APP, LABEL_CLUSTER, DEFAULT_APP, WORKSPACE_PORT_ANNOTATION,
  APP_KIND_LABEL, APP_KIND_WORKSPACE, LEGACY_WORKSPACE_APPS,
  WORKSPACE_SCHEME_ANNOTATION, WORKSPACE_WORKDIR, WORKSPACE_HOME,
  DEV_API_IN_CLUSTER,
} from './config/constants';
import { WORKSPACE_VUE_CONFIG } from './workspace-config';

/** The browser beside every workspace: the image the harness's browser sidecar and the dev-browser App use. */
const BROWSER_IMAGE = 'lscr.io/linuxserver/chromium:latest';

// The Vuex store the dashboard hands every component. Untyped for the same reason the
// dashboard's own extensions leave it untyped: the shell exports no type for it.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Store = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

/** What this product needs to know about an App to offer it as a template. */
export interface DevApp {
  id: string;
  label: string;
  description: string;
  /** The App's declared values, which a workspace can override. */
  values: Record<string, unknown>;
  /** The repository a workspace of this app works on, when the App declares one (a `repo` value). */
  repo: string;
  /** How many workspaces are installations of it. */
  installations: number;
  /** A workspace app: the dev tools pointed at a Rancher. See APP_KIND_LABEL. */
  workspace: boolean;
}

function missingAppsPlus(): Error {
  return new Error(
    'Apps Plus is not installed in this Rancher, and it is what holds workspace templates. Install the apps-plus extension and reload.',
  );
}

function hasSchema(store: Store, type: string): boolean {
  try {
    return !!store.getters['management/schemaFor'](type);
  } catch {
    return false;
  }
}

export function appsPlusAvailable(store: Store): boolean {
  return hasSchema(store, APP) && hasSchema(store, APP_INSTANCE);
}

function requireAppsPlus(store: Store): void {
  if (!appsPlusAvailable(store)) {
    throw missingAppsPlus();
  }
}

function appFrom(model: Json, installations: number): DevApp {
  const values = model.spec?.values || {};

  return {
    id:          model.metadata?.name || '',
    label:       model.metadata?.name || '',
    description: model.spec?.description || '',
    values,
    repo:        typeof values.repo === 'string' ? values.repo : '',
    installations,
    workspace:   model.metadata?.labels?.[APP_KIND_LABEL] === APP_KIND_WORKSPACE || LEGACY_WORKSPACE_APPS.includes(model.metadata?.name),
  };
}

/** Every App, as a template. Sorted so the list reads the same way twice. */
export async function listApps(store: Store): Promise<DevApp[]> {
  requireAppsPlus(store);

  const [apps, instances] = await Promise.all([
    store.dispatch('management/findAll', { type: APP }),
    store.dispatch('management/findAll', { type: APP_INSTANCE }).catch(() => []),
  ]);

  const counts = new Map<string, number>();

  for (const instance of instances || []) {
    if (instance.metadata?.labels?.[LABEL_WORKSPACE]) {
      const app = instance.spec?.app || '';

      counts.set(app, (counts.get(app) || 0) + 1);
    }
  }

  return (apps || [])
    .map((app: Json) => appFrom(app, counts.get(app.metadata?.name) || 0))
    .sort((a: DevApp, b: DevApp) => a.label.localeCompare(b.label));
}

export async function appById(store: Store, id: string): Promise<DevApp | null> {
  return (await listApps(store)).find((app) => app.id === id) || null;
}

/** The Installations that are workspaces: the ones carrying this product's label. */
export async function listWorkspaceInstances(store: Store): Promise<Json[]> {
  requireAppsPlus(store);

  const instances = await store.dispatch('management/findAll', { type: APP_INSTANCE, opt: { force: true } });

  return (instances || []).filter((instance: Json) => !!instance.metadata?.labels?.[LABEL_WORKSPACE]);
}

export async function workspaceInstance(store: Store, name: string): Promise<Json | null> {
  return (await listWorkspaceInstances(store)).find((instance: Json) => instance.metadata?.labels?.[LABEL_WORKSPACE] === name) || null;
}

/**
 * Make a workspace: one Installation of one App, on one cluster.
 *
 * The instance is named after the workspace, because that is what Apps Plus names the Bundle
 * after and what `${install}` resolves to inside the App's templates - so an App written for
 * this product can name its namespace `dev-${install}` and have it be the workspace's. The
 * namespace is also set explicitly, because Fleet's default namespace for a Bundle is what an
 * App's namespaced manifests land in when they name none.
 */
export async function createWorkspaceInstance(store: Store, name: string, appId: string, cluster: string, values: Record<string, unknown> = {}): Promise<void> {
  requireAppsPlus(store);

  const namespace = `dev-${ name }`;
  const instance = await store.dispatch('management/create', {
    type:     APP_INSTANCE,
    metadata: {
      name,
      labels: {
        [LABEL_WORKSPACE]: name, [LABEL_APP]: appId, [LABEL_CLUSTER]: cluster,
      },
    },
    spec: {
      app:              appId,
      namespace,
      targets:          [{ clusterName: cluster }],
      // Told to the App as a value, for the reason rancherWorkspaceApp gives beside hostCluster.
      values:           { ...values, hostCluster: cluster },
      provisionCluster: { enabled: false },
    },
  });

  await instance.save();
}

/**
 * Remove a workspace, and see its removal through.
 *
 * Apps Plus holds an Installation with a finalizer until its Bundle and everything the Bundle
 * made are gone, and the code that checks and then lets go is `releaseWhenEmpty()` - which
 * Apps Plus's own list page polls, and nothing else does. A delete asked for from here would
 * otherwise sit Terminating until somebody happened to open that page, so this polls it too,
 * for as long as a namespace full of pods reasonably takes to drain.
 */
export async function deleteWorkspaceInstance(store: Store, name: string): Promise<void> {
  const instance = await workspaceInstance(store, name);

  if (!instance) {
    return;
  }

  await instance.remove();

  for (let attempt = 0; attempt < 40; attempt++) {
    const current = await store.dispatch('management/find', { type: APP_INSTANCE, id: name, opt: { force: true } }).catch(() => null);

    if (!current) {
      return;
    }

    if (await current.releaseWhenEmpty().catch(() => false)) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
}

/**
 * Render any workspace whose Bundle is missing.
 *
 * The in-cluster workspace API can create an Installation but cannot run the model that renders
 * it, and neither can anything else that is not a browser with Apps Plus loaded. So this
 * browser does it on the workspace list's own poll: an Installation carrying this product's
 * label and no Bundle gets reconciled here. The same condition Apps Plus itself lives under -
 * somebody has the dashboard open - and nothing worse.
 */
export async function reconcileUnrendered(store: Store): Promise<void> {
  let instances: Json[] = [];

  try {
    instances = await listWorkspaceInstances(store);
    await store.dispatch('management/findAll', { type: 'fleet.cattle.io.bundle' });
  } catch {
    return;
  }

  for (const instance of instances) {
    if (!instance.bundle && !instance.metadata?.deletionTimestamp) {
      await instance.reconcile().catch(() => {});
    }
  }
}

// ── The App every Rancher gets ──────────────────────────────────────────────────────────────
//
// What the built-in `rancher` template used to make, as an App: a rancher/dashboard checkout
// with its dependencies installed and the dev server running, pointed at the Rancher this
// cluster belongs to. Created if missing, so a fresh cluster has a template on day one, and
// left alone afterwards, so somebody who edits it in Apps Plus keeps their edits. Everything
// in it is one YAML file with ${values} in it, which is the whole point: it is edited where
// every other App is.

const WORKSPACE_SCRIPT = [
  'set -e',
  `mkdir -p ${ WORKSPACE_HOME }`,
  `chown node:node /workspace ${ WORKSPACE_HOME } 2>/dev/null || true`,
  '[ -f /workspace/.owned ] || (chown -R node:node /workspace 2>/dev/null; touch /workspace/.owned)',
  `[ -f /seed/terminal-tools.sh ] && (HOME_DIR=${ WORKSPACE_HOME } /bin/sh /seed/terminal-tools.sh >/workspace/.terminal-tools.log 2>&1 &) || true`,
  // What a recording and a CI-style check need and the image lacks: ffmpeg (browser.mjs
  // record), jq, lsof and ss. Root's to install and the rootfs is the pod's, so on every boot,
  // in the background so the dev server is not a minute later for it.
  '(command -v ffmpeg >/dev/null 2>&1 && command -v lsof >/dev/null 2>&1) || (apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq ffmpeg jq lsof iproute2 >/workspace/.apt.log 2>&1 &) || true',
  `exec setpriv --reuid=1000 --regid=1000 --init-groups /bin/sh -c '${ [
    'set -e',
    `export HOME=${ WORKSPACE_HOME }`,
    'export YARN_CACHE_FOLDER=/workspace/.yarn-cache',
    // `\${repo}` and `\${port}` are Apps Plus's to substitute when the App is rendered, so
    // they are written as text here rather than interpolated.
    `[ -d ${ WORKSPACE_WORKDIR }/.git ] || git clone --depth 1 https://github.com/\${repo} ${ WORKSPACE_WORKDIR }`,
    `cd ${ WORKSPACE_WORKDIR }`,
    '[ -f .install-done ] || (yarn install --network-timeout 600000 && touch .install-done)',
    // An earlier App wrote its config over the checkout's vue.config.js; a checkout that boot
    // left behind gets the repository's file back. A clean tree is a no-op.
    'git update-index --no-skip-worktree vue.config.js 2>/dev/null || true',
    'git checkout -- vue.config.js 2>/dev/null || true',
    'exec /bin/bash /dev-config/serve.sh ${port}',
  ].join(' && ') }'`,
].join(' && ');

/**
 * The dev server, supervised: the container's process is this loop, not the server.
 *
 * The harness's project container ran nothing in particular; its agents started a dev server
 * when a skill wanted one, on 8005, and stopped it when they were done. Here the server is
 * already running for them, and the pod must survive whatever they do to it: a skill that
 * kills what is on 8005 to start its own, a branch switch that crashes the compiler, an OOM.
 * When the pod's main process was the server itself, each of those restarted the container
 * and took every conversation's tmux with it, mid-review.
 *
 * So the server is restarted when it exits, and left alone while something else holds the
 * port: an agent that started its own server gets the port until it is done, and this one
 * comes back afterwards. The config is passed by path rather than written over the checkout's
 * (see workspace-config.ts), so the tree is the repository's and stays that way.
 */
const WORKSPACE_SERVE = [
  '#!/bin/bash',
  'PORT=${1:-8005}',
  'held() { node -e "require(\'net\').connect(Number(process.argv[1]),\'127.0.0.1\').on(\'connect\',()=>process.exit(0)).on(\'error\',()=>process.exit(1))" "$PORT" 2>/dev/null; }',
  'while :; do',
  '  if held; then sleep 10; continue; fi',
  '  VUE_CLI_SERVICE_CONFIG_PATH=/dev-config/vue.config.js yarn dev --port "$PORT"',
  '  echo "[workspace] the dev server exited; starting it again in 5s"',
  '  sleep 5',
  'done',
  '',
].join('\n');

function yamlBlock(text: string, indent: number): string {
  const pad = ' '.repeat(indent);

  return text.split('\n').map((line) => (line ? pad + line : line)).join('\n');
}

export function rancherWorkspaceApp(): Json {
  const labels = [
    `    ${ LABEL_WORKSPACE }: \${install}`,
    `    ${ LABEL_APP }: \${app}`,
    `    ${ LABEL_CLUSTER }: \${hostCluster}`,
  ].join('\n');

  return {
    apiVersion: 'appsplus.io/v1alpha1',
    kind:       'App',
    metadata:   { name: DEFAULT_APP, labels: { [APP_KIND_LABEL]: APP_KIND_WORKSPACE } },
    spec:       {
      description: 'The dev tools, pointed at a Rancher: a rancher/dashboard checkout with its dependencies installed and the dev server running against the Rancher it is told to. The first start is minutes: a clone, a yarn install and a first compile.',
      // `port` is a number on purpose: Apps Plus emits a declared number bare and a declared
      // string quoted, and a Service port that arrives as "8005" is one the apiserver refuses.
      // `hostCluster` is where the workspace runs; it is a value rather than the `${cluster}`
      // built-in because that built-in is the cluster an Installation *provisions*, which for
      // one that provisions nothing resolves to the Installation's own name.
      values:      {
        repo:        'rancher/dashboard',
        port:        8005,
        scheme:      'http',
        image:       'node:24',
        hostCluster: 'local',
        // The Rancher the checkout's dev server talks to. The default is the Rancher this
        // cluster belongs to - `$(NODE_IP)` is the node's address, expanded by Kubernetes in
        // the env, because this cluster is k3s inside the Rancher container. A team's shared
        // Rancher goes here instead when the infrastructure is kept apart from the tools. Not
        // an empty string: Apps Plus drops an empty default and its label with it.
        rancherUrl:  'https://$(NODE_IP)',
      },
      valueLabels: {
        repo:        'GitHub repository to clone',
        port:        'Port the dev server listens on',
        scheme:      'http or https',
        image:       'Container image',
        hostCluster: 'Cluster the workspace runs on',
        rancherUrl:  'Rancher the dev server points at',
      },
      templates: [
        {
          name:    'namespace.yaml',
          content: [
            'apiVersion: v1',
            'kind: Namespace',
            'metadata:',
            '  name: ${namespace}',
            '  labels:',
            labels,
            '  annotations:',
            `    ${ WORKSPACE_PORT_ANNOTATION }: "\${port}"`,
            `    ${ WORKSPACE_SCHEME_ANNOTATION }: \${scheme}`,
            '',
          ].join('\n'),
        },
        {
          name:    'rbac.yaml',
          content: [
            'apiVersion: v1',
            'kind: ServiceAccount',
            'metadata:',
            '  namespace: ${namespace}',
            '  name: dev-workspace',
            '---',
            'apiVersion: rbac.authorization.k8s.io/v1',
            'kind: RoleBinding',
            'metadata:',
            '  namespace: ${namespace}',
            '  name: dev-workspace',
            'roleRef:',
            '  apiGroup: rbac.authorization.k8s.io',
            '  kind: ClusterRole',
            '  name: edit',
            'subjects:',
            '  - kind: ServiceAccount',
            '    name: dev-workspace',
            '    namespace: ${namespace}',
            '',
          ].join('\n'),
        },
        {
          name:    'config.yaml',
          content: [
            'apiVersion: v1',
            'kind: ConfigMap',
            'metadata:',
            '  namespace: ${namespace}',
            '  name: dev-workspace-config',
            'data:',
            '  vue.config.js: |',
            yamlBlock(WORKSPACE_VUE_CONFIG, 4),
            '  serve.sh: |',
            yamlBlock(WORKSPACE_SERVE, 4),
            // vue-cli decides whether a config file is ESM from the nearest package.json above
            // it, and dies when there is none; this is that package.json.
            '  package.json: |',
            '    {"name": "dev-workspace-config", "private": true}',
            '',
          ].join('\n'),
        },
        {
          name:    'deployment.yaml',
          content: [
            'apiVersion: apps/v1',
            'kind: Deployment',
            'metadata:',
            '  namespace: ${namespace}',
            '  name: ${namespace}',
            '  labels:',
            '    app: ${namespace}',
            labels,
            'spec:',
            '  replicas: 1',
            '  selector:',
            '    matchLabels:',
            '      app: ${namespace}',
            '  strategy:',
            '    type: Recreate',
            '  template:',
            '    metadata:',
            '      labels:',
            '        app: ${namespace}',
            yamlBlock(labels, 4),
            '    spec:',
            '      serviceAccountName: dev-workspace',
            '      containers:',
            '        - name: workspace',
            '          image: ${image}',
            '          command:',
            '            - /bin/sh',
            '            - -c',
            `            - ${ JSON.stringify(WORKSPACE_SCRIPT) }`,
            '          ports:',
            '            - name: http',
            '              containerPort: ${port}',
            '          env:',
            '            - name: NODE_OPTIONS',
            '              value: --max_old_space_size=4096',
            '            - name: DEV_PROXY_PATH',
            '              value: ""',
            '            - name: NODE_IP',
            '              valueFrom:',
            '                fieldRef:',
            '                  fieldPath: status.hostIP',
            '            - name: API',
            '              value: "${rancherUrl}"',
            // The names the harness's skills read (see workspace-tools.ts): the Rancher, the
            // in-cluster API that answers the harness API's routes, the workspace's own name,
            // and the browser container's CDP, which shares this pod's network.
            '            - name: RANCHER_URL',
            '              value: "${rancherUrl}"',
            '            - name: PROJECT_NAME',
            '              value: ${install}',
            '            - name: HARNESS_PROJECT',
            '              value: ${install}',
            '            - name: HARNESS_API',
            `              value: ${ DEV_API_IN_CLUSTER }`,
            '            - name: CLAUDE_HARNESS_API',
            `              value: ${ DEV_API_IN_CLUSTER }`,
            '            - name: CLAUDE_BROWSER_CDP',
            '              value: http://localhost:9222',
            '          envFrom:',
            '            - secretRef:',
            '                name: dev-secrets',
            '                optional: true',
            '          volumeMounts:',
            '            - name: work',
            '              mountPath: /workspace',
            '            - name: dev-config',
            '              mountPath: /dev-config',
            '              readOnly: true',
            '            - name: terminal',
            '              mountPath: /seed',
            '              readOnly: true',
            '          startupProbe:',
            '            tcpSocket:',
            '              port: ${port}',
            '            periodSeconds: 10',
            '            failureThreshold: 120',
            '          readinessProbe:',
            '            tcpSocket:',
            '              port: ${port}',
            '            periodSeconds: 10',
            // The harness's browser sidecar, as a second container: Chromium with CDP open on
            // this pod's localhost, opened on the dev server, sharing /workspace/artifacts as
            // /artifacts. Its desktop is what the Browser tab frames.
            '        - name: browser',
            `          image: ${ BROWSER_IMAGE }`,
            '          ports:',
            '            - name: browser',
            '              containerPort: 3000',
            '            - name: cdp',
            '              containerPort: 9222',
            '          env:',
            '            - name: PUID',
            '              value: "1000"',
            '            - name: PGID',
            '              value: "1000"',
            '            - name: CUSTOM_PORT',
            '              value: "3000"',
            '            - name: TITLE',
            '              value: ${install}',
            '            - name: CHROME_CLI',
            '              value: "https://localhost:${port} --no-first-run --start-maximized --disable-infobars --allow-insecure-localhost --ignore-certificate-errors --force-dark-mode --remote-debugging-port=9222 --remote-allow-origins=*"',
            '          volumeMounts:',
            '            - name: dshm',
            '              mountPath: /dev/shm',
            '            - name: work',
            '              mountPath: /artifacts',
            '              subPath: artifacts',
            '      volumes:',
            '        - name: work',
            '          hostPath:',
            '            path: /var/lib/rancher/dev-workspaces/${install}',
            '            type: DirectoryOrCreate',
            '        - name: dshm',
            '          emptyDir:',
            '            medium: Memory',
            '            sizeLimit: 1Gi',
            '        - name: dev-config',
            '          configMap:',
            '            name: dev-workspace-config',
            '        - name: terminal',
            '          configMap:',
            '            name: dev-terminal',
            '            defaultMode: 365',
            '            optional: true',
            '',
          ].join('\n'),
        },
        {
          name:    'service.yaml',
          content: [
            'apiVersion: v1',
            'kind: Service',
            'metadata:',
            '  namespace: ${namespace}',
            '  name: ${namespace}',
            '  labels:',
            labels,
            'spec:',
            '  type: NodePort',
            '  selector:',
            '    app: ${namespace}',
            '  ports:',
            '    - name: http',
            '      port: ${port}',
            '      targetPort: http',
            '    - name: browser',
            '      port: 3000',
            '      targetPort: browser',
            '',
          ].join('\n'),
        },
      ],
    },
  };
}

// ── A static build of the dashboard, pointed at a Rancher, on a link anyone can open ────────
//
// The other half of keeping infrastructure apart from tools: a preview is not a dev server
// with a checkout, it is the dashboard built once at a ref and served by nginx, with every API
// path proxied to the Rancher it was built for. The result has an address of its own on the
// node, so a reviewer opens a link and logs in to that Rancher; nothing about the build is
// theirs to set up. Rebuilding is restarting the pod: the init container clones and builds
// into a shared directory and nginx serves what it left there.

/**
 * What the build runs over its index.html, base64 so it travels inside one shell line.
 *
 * Rancher proxies a Service through the apiserver, and the apiserver rewrites every absolute URL
 * in an HTML response to sit under its own proxy path - `/api/v1/namespaces/.../proxy/...` -
 * which Rancher does not serve at that address. The dashboard's index names its scripts with
 * absolute URLs, so through the proxy it named files that could not be fetched. This takes the
 * script and link tags out of the markup and puts them back from a script, which the rewriter
 * never reads; what the app loads after that is its own doing, at the base it was built for.
 */
export const UNREWRITE_B64 = 'Ly8gUmFuY2hlciBwcm94aWVzIGEgU2VydmljZSB0aHJvdWdoIHRoZSBhcGlzZXJ2ZXIsIGFuZCB0aGUgYXBpc2VydmVyIHJld3JpdGVzIGV2ZXJ5IGFic29sdXRlCi8vIFVSTCBpbiBhbiBIVE1MIHJlc3BvbnNlIHRvIHNpdCB1bmRlciBpdHMgb3duIHByb3h5IHBhdGggLSBhIHBhdGggUmFuY2hlciB0aGVuIGRvZXMgbm90IHNlcnZlLgovLyBTbyB0aGUgYnVpbHQgaW5kZXgncyBzY3JpcHQgYW5kIGxpbmsgdGFncyBhcmUgdGFrZW4gb3V0IG9mIHRoZSBtYXJrdXAgYW5kIHB1dCBiYWNrIGJ5IGEKLy8gc2NyaXB0LCB3aGljaCB0aGUgcmV3cml0ZXIgZG9lcyBub3QgcmVhZC4gRXZlcnl0aGluZyB0aGUgYXBwIGxvYWRzIGFmdGVyIHRoYXQgaXMgSmF2YVNjcmlwdCdzCi8vIGRvaW5nLCBhdCB0aGUgYmFzZSBpdCB3YXMgYnVpbHQgZm9yLgpjb25zdCBmcyA9IHJlcXVpcmUoJ2ZzJyk7CmNvbnN0IGZpbGUgPSBwcm9jZXNzLmFyZ3ZbMl07CmxldCBodG1sID0gZnMucmVhZEZpbGVTeW5jKGZpbGUsICd1dGY4Jyk7CmNvbnN0IHRhZ3MgPSBbXTsKaHRtbCA9IGh0bWwucmVwbGFjZSgvPHNjcmlwdFxiW14+XSpcc3NyYz0iKFteIl0rKSJbXj5dKj48XC9zY3JpcHQ+L2csICh3aG9sZSwgc3JjKSA9PiB7IHRhZ3MucHVzaCh7IHQ6ICdzY3JpcHQnLCB1OiBzcmMgfSk7IHJldHVybiAnJzsgfSk7Cmh0bWwgPSBodG1sLnJlcGxhY2UoLzxsaW5rXGJbXj5dKlxzaHJlZj0iKFteIl0rKSJbXj5dKj4vZywgKHdob2xlLCBocmVmKSA9PiB7CiAgY29uc3QgcmVsID0gKC9cYnJlbD0iKFteIl0rKSIvLmV4ZWMod2hvbGUpIHx8IFtdKVsxXSB8fCAnc3R5bGVzaGVldCc7CiAgY29uc3QgYXMgPSAoL1xiYXM9IihbXiJdKykiLy5leGVjKHdob2xlKSB8fCBbXSlbMV0gfHwgJyc7CiAgdGFncy5wdXNoKHsgdDogJ2xpbmsnLCB1OiBocmVmLCByZWwsIGFzIH0pOwogIHJldHVybiAnJzsKfSk7CmNvbnN0IGJvb3QgPSAnPHNjcmlwdD4oZnVuY3Rpb24oKXt2YXIgdGFncz0nICsgSlNPTi5zdHJpbmdpZnkodGFncykgKyAnO3RhZ3MuZm9yRWFjaChmdW5jdGlvbih4KXt2YXIgZTtpZih4LnQ9PT0ic2NyaXB0Iil7ZT1kb2N1bWVudC5jcmVhdGVFbGVtZW50KCJzY3JpcHQiKTtlLnNyYz14LnU7ZS5kZWZlcj10cnVlO31lbHNle2U9ZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgibGluayIpO2UuaHJlZj14LnU7ZS5yZWw9eC5yZWw7aWYoeC5hcyl7ZS5hcz14LmFzO319ZG9jdW1lbnQuaGVhZC5hcHBlbmRDaGlsZChlKTt9KTt9KSgpOzwvc2NyaXB0Pic7Cmh0bWwgPSBodG1sLnJlcGxhY2UoJzwvaGVhZD4nLCBib290ICsgJzwvaGVhZD4nKTsKZnMud3JpdGVGaWxlU3luYyhmaWxlLCBodG1sKTsKY29uc29sZS5sb2coJ2luZGV4OiAnICsgdGFncy5sZW5ndGggKyAnIHRhZ3MgbW92ZWQgaW50byBhIHNjcmlwdCcpOwo=';

const PREVIEW_BUILD = [
  'set -e',
  'export HOME=/work/.home YARN_CACHE_FOLDER=/work/.yarn-cache NODE_OPTIONS=--max_old_space_size=4096',
  'mkdir -p /work /site/dist /site/nginx',
  // Two sources. A workspace's own build (the Share tab: workspace-tools.ts, buildShare) is a
  // directory on the node that nginx serves as it is, so a rebuild there shows up here with no
  // pod restart; anything else is cloned and built here, once, on the first start.
  'if [ "${sourceDir}" != none ]; then',
  '  SITE=/workspaces/${sourceDir}',
  '  until [ -f "$SITE/index.html" ]; do echo "waiting for the workspace to build into $SITE"; sleep 10; done',
  'else',
  '  SITE=/site/dist',
  '  [ -d /work/src/.git ] || git clone https://github.com/${repo} /work/src',
  '  cd /work/src',
  '  git fetch --depth 1 origin "${ref}" && git checkout -q FETCH_HEAD',
  '  yarn install --network-timeout 600000',
  // The dashboard is built under /dashboard/ - ROUTER_BASE is where it routes, RESOURCE_BASE
  // where it fetches its assets - with everything else proxied to the Rancher; Storybook is a
  // plain static site.
  '  if [ "${kind}" = storybook ]; then',
  '    yarn build-storybook && rm -rf /site/dist && cp -r storybook/storybook-static /site/dist',
  '  else',
  '    ROUTER_BASE=${base} RESOURCE_BASE=${base} OUTPUT_DIR=/site/dist yarn build',
  // The apiserver rewrites absolute URLs in proxied HTML onto a path Rancher does not serve,
  // so the index loads its scripts from a script instead. See UNREWRITE_B64.
  `    echo ${ UNREWRITE_B64 } | base64 -d > /tmp/unrewrite.js && node /tmp/unrewrite.js /site/dist/index.html`,
  '  fi',
  'fi',
  'if [ "${kind}" = storybook ]; then',
  '  printf "%s\\n" "server {" "  listen ${port};" "  root $SITE;" "  location / { try_files \\$uri \\$uri/ /index.html; }" "}" > /site/nginx/default.conf',
  'else',
  '  printf "%s\\n" "server {" "  listen ${port};" "  client_max_body_size 50m;" "  location = / { return 302 /dashboard/; }" \\',
  '    "  location /dashboard/ { alias $SITE/; try_files \\$uri \\$uri/ /dashboard/index.html; }" \\',
  '    "  location ~ ^/(js|css|img|fonts|favicon\\\\.png|manifest\\\\.json|robots\\\\.txt)(/|\\$) { root $SITE; }" \\',
  '    "  location / { proxy_pass ${rancherUrl}; proxy_ssl_verify off; proxy_ssl_server_name on; proxy_http_version 1.1;" \\',
  '    "    proxy_set_header Upgrade \\$http_upgrade; proxy_set_header Connection \\"upgrade\\"; proxy_set_header Host \\$proxy_host;" \\',
  '    "    proxy_set_header X-Forwarded-Proto https; proxy_read_timeout 3600s; proxy_cookie_domain ~.* \\$host; proxy_cookie_flags ~ nosecure; }" \\',
  '    "}" > /site/nginx/default.conf',
  'fi',
  'echo built',
].join('\n');

export const PREVIEW_APP = 'dashboard-preview';
export const BROWSER_APP = 'dev-browser';
/** The Apps every Rancher gets; see ensureDefaultApp. */
export const DEFAULT_APPS = [DEFAULT_APP, PREVIEW_APP, BROWSER_APP];

export function dashboardPreviewApp(): Json {
  const labels = [
    `    ${ LABEL_WORKSPACE }: \${install}`,
    `    ${ LABEL_APP }: \${app}`,
    `    ${ LABEL_CLUSTER }: \${hostCluster}`,
  ].join('\n');

  return {
    apiVersion: 'appsplus.io/v1alpha1',
    kind:       'App',
    metadata:   { name: PREVIEW_APP },
    spec:       {
      description: 'A static build of the dashboard, or of its Storybook, at a branch, tag or pull request, served by nginx on a link anyone can open. A dashboard build has its API proxied to a Rancher of your choosing.',
      values:      {
        repo:        'rancher/dashboard',
        ref:         'master',
        kind:        'dashboard',
        base:        '/dashboard/',
        rancherUrl:  'https://rancher.ourhome.dev',
        port:        8080,
        hostCluster: 'local',
        // A build to serve instead of making one: a directory under the node's dev-workspaces
        // (`<workspace>/share/dashboard`, which the Share tab fills). `none` builds from `ref`.
        sourceDir:   'none',
      },
      valueLabels: {
        repo:        'GitHub repository',
        ref:         'Branch, tag, or pull/<n>/head',
        kind:        'dashboard or storybook',
        base:        'Where the dashboard build routes and fetches its assets: /dashboard/, or the path Rancher proxies it at',
        sourceDir:   'A workspace build to serve, as <workspace>/share/<kind> under the node\'s dev-workspaces; none means build from ref',
        rancherUrl:  'Rancher a dashboard build talks to',
        port:        'Port nginx listens on',
        hostCluster: 'Cluster the preview runs on',
      },
      templates: [
        {
          name:    'namespace.yaml',
          content: [
            'apiVersion: v1',
            'kind: Namespace',
            'metadata:',
            '  name: ${namespace}',
            '  labels:',
            labels,
            '  annotations:',
            `    ${ WORKSPACE_PORT_ANNOTATION }: "\${port}"`,
            `    ${ WORKSPACE_SCHEME_ANNOTATION }: http`,
            '    dev.rancher.io/preview: "true"',
            '',
          ].join('\n'),
        },
        {
          name:    'deployment.yaml',
          content: [
            'apiVersion: apps/v1',
            'kind: Deployment',
            'metadata:',
            '  namespace: ${namespace}',
            '  name: ${namespace}',
            '  labels:',
            '    app: ${namespace}',
            labels,
            'spec:',
            '  replicas: 1',
            '  selector:',
            '    matchLabels:',
            '      app: ${namespace}',
            '  strategy:',
            '    type: Recreate',
            '  template:',
            '    metadata:',
            '      labels:',
            '        app: ${namespace}',
            yamlBlock(labels, 4),
            '    spec:',
            '      initContainers:',
            '        - name: build',
            '          image: node:24',
            '          command:',
            '            - /bin/bash',
            '            - -c',
            `            - ${ JSON.stringify(PREVIEW_BUILD) }`,
            '          volumeMounts:',
            '            - name: work',
            '              mountPath: /work',
            '            - name: site',
            '              mountPath: /site',
            '            - name: workspaces',
            '              mountPath: /workspaces',
            '              readOnly: true',
            '      containers:',
            '        - name: workspace',
            '          image: nginx:1.27-alpine',
            '          ports:',
            '            - name: http',
            '              containerPort: ${port}',
            '          volumeMounts:',
            '            - name: site',
            '              mountPath: /site',
            '              readOnly: true',
            '            - name: site',
            '              subPath: nginx',
            '              mountPath: /etc/nginx/conf.d',
            '              readOnly: true',
            '            - name: workspaces',
            '              mountPath: /workspaces',
            '              readOnly: true',
            '          readinessProbe:',
            '            tcpSocket:',
            '              port: ${port}',
            '            periodSeconds: 10',
            '      volumes:',
            '        - name: work',
            '          hostPath:',
            '            path: /var/lib/rancher/dev-previews/${install}',
            '            type: DirectoryOrCreate',
            '        - name: site',
            '          emptyDir: {}',
            // Every workspace's /workspace, for the build one of them made (see sourceDir).
            '        - name: workspaces',
            '          hostPath:',
            '            path: /var/lib/rancher/dev-workspaces',
            '            type: DirectoryOrCreate',
            '',
          ].join('\n'),
        },
        {
          name:    'service.yaml',
          content: [
            'apiVersion: v1',
            'kind: Service',
            'metadata:',
            '  namespace: ${namespace}',
            '  name: ${namespace}',
            '  labels:',
            labels,
            'spec:',
            '  type: NodePort',
            '  selector:',
            '    app: ${namespace}',
            '  ports:',
            '    - name: http',
            '      port: ${port}',
            '      targetPort: http',
            '',
          ].join('\n'),
        },
      ],
    },
  };
}

// ── A browser to look at things in, separate from anything it looks at ──────────────────────
//
// The same Chromium Extension Studio keeps, as an App: its DevTools port for an agent or a
// test to drive, its web UI for a person to watch. One per cluster is the usual number, which
// is why it is an App rather than part of every workspace.

export function devBrowserApp(): Json {
  return {
    apiVersion: 'appsplus.io/v1alpha1',
    kind:       'App',
    metadata:   { name: BROWSER_APP },
    spec:       {
      description: 'A Chromium with its DevTools protocol open, for agents and tests to drive and for people to watch. Shared by every workspace that points at it.',
      values:      {
        image:       'lscr.io/linuxserver/chromium:latest',
        startUrl:    'https://rancher.ourhome.dev',
        hostCluster: 'local',
      },
      valueLabels: {
        image:       'Chromium image',
        startUrl:    'Page it opens on',
        hostCluster: 'Cluster the browser runs on',
      },
      templates: [
        {
          name:    'namespace.yaml',
          content: [
            'apiVersion: v1',
            'kind: Namespace',
            'metadata:',
            '  name: ${namespace}',
            '  labels:',
            `    ${ LABEL_WORKSPACE }: \${install}`,
            `    ${ LABEL_APP }: \${app}`,
            `    ${ LABEL_CLUSTER }: \${hostCluster}`,
            '  annotations:',
            `    ${ WORKSPACE_PORT_ANNOTATION }: "3000"`,
            `    ${ WORKSPACE_SCHEME_ANNOTATION }: http`,
            '',
          ].join('\n'),
        },
        {
          name:    'deployment.yaml',
          content: [
            'apiVersion: apps/v1',
            'kind: Deployment',
            'metadata:',
            '  namespace: ${namespace}',
            '  name: ${namespace}',
            '  labels:',
            '    app: ${namespace}',
            `    ${ LABEL_WORKSPACE }: \${install}`,
            'spec:',
            '  replicas: 1',
            '  selector:',
            '    matchLabels:',
            '      app: ${namespace}',
            '  template:',
            '    metadata:',
            '      labels:',
            '        app: ${namespace}',
            `        ${ LABEL_WORKSPACE }: \${install}`,
            '    spec:',
            '      containers:',
            '        - name: workspace',
            '          image: ${image}',
            '          ports:',
            '            - name: http',
            '              containerPort: 3000',
            '            - name: cdp',
            '              containerPort: 9222',
            '          env:',
            '            - name: PUID',
            '              value: "1000"',
            '            - name: PGID',
            '              value: "1000"',
            '            - name: CUSTOM_PORT',
            '              value: "3000"',
            '            - name: TITLE',
            '              value: Dev browser',
            '            - name: CHROME_CLI',
            '              value: "${startUrl} --no-first-run --start-maximized --disable-infobars --ignore-certificate-errors --remote-debugging-port=9222 --remote-allow-origins=*"',
            '          volumeMounts:',
            '            - name: dshm',
            '              mountPath: /dev/shm',
            '      volumes:',
            '        - name: dshm',
            '          emptyDir:',
            '            medium: Memory',
            '            sizeLimit: 1Gi',
            '',
          ].join('\n'),
        },
        {
          name:    'service.yaml',
          content: [
            'apiVersion: v1',
            'kind: Service',
            'metadata:',
            '  namespace: ${namespace}',
            '  name: ${namespace}',
            'spec:',
            '  type: NodePort',
            '  selector:',
            '    app: ${namespace}',
            '  ports:',
            '    - name: http',
            '      port: 3000',
            '      targetPort: http',
            '    - name: cdp',
            '      port: 9222',
            '      targetPort: cdp',
            '',
          ].join('\n'),
        },
      ],
    },
  };
}

/** Create the built-in Apps that are missing. Quiet: this runs for everyone on every load. */
export async function ensureDefaultApp(store: Store): Promise<void> {
  if (!appsPlusAvailable(store)) {
    return;
  }

  const apps = await store.dispatch('management/findAll', { type: APP }).catch(() => null);

  if (!apps) {
    return;
  }

  const byName = new Map(apps.map((app: Json) => [app.metadata?.name, app]));

  for (const body of [rancherWorkspaceApp(), dashboardPreviewApp(), devBrowserApp()]) {
    // The definition's fingerprint rides on the App, so a definition that changed in this bundle
    // reaches a cluster that already has the App - the templates lesson: an App seeded once and
    // never touched again strands every workspace made after the definition moved on. Existing
    // Installations keep what they rendered; new ones get the new templates.
    const fingerprint = definitionVersion(body.spec);
    const existing: Json = byName.get(body.metadata.name);
    // Two dashboards on different versions of this extension must not take turns rewriting the
    // App - Apps Plus re-renders every Installation each time, replacing running workspace
    // pods mid-conversation. Versions up to 0.3.2 compare the older annotation with their own
    // fingerprint and rewrite on a mismatch, so it is left holding the value they expect
    // (LEGACY_FINGERPRINTS) and this version keeps its own in an annotation of its own.
    const annotations = {
      ...(body.metadata.annotations || {}),
      [DEFINITION_ANNOTATION]:    LEGACY_FINGERPRINTS[body.metadata.name] || fingerprint,
      [DEFINITION_ANNOTATION_V2]: fingerprint,
    };

    body.metadata.annotations = annotations;

    if (!existing) {
      const app = await store.dispatch('management/create', { type: APP, ...body });

      await app.save().catch(() => {});
    } else if (existing.metadata?.annotations?.[DEFINITION_ANNOTATION_V2] !== fingerprint) {
      existing.spec = body.spec;
      existing.metadata.annotations = { ...(existing.metadata.annotations || {}), ...annotations };
      await existing.save().catch(() => {});
    }
  }
}

/** Where an App carries the fingerprint of the definition that wrote it. */
export const DEFINITION_ANNOTATION_V2 = 'dev.rancher.io/definition-v2';
/** The annotation versions up to 0.3.2 read; see ensureDefaultApp for why it is kept. */
export const DEFINITION_ANNOTATION = 'dev.rancher.io/definition';
/** What a 0.3.2 dashboard computes for the Apps it knows, so it finds them as it left them. */
const LEGACY_FINGERPRINTS: Record<string, string> = { [DEFAULT_APP]: '50f2859d', [BROWSER_APP]: 'fff28dbc' };

function definitionVersion(spec: Json): string {
  const text = JSON.stringify(spec);
  let h = 2166136261;

  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }

  return (h >>> 0).toString(16);
}
