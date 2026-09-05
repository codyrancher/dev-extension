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
  WORKSPACE_SCHEME_ANNOTATION, WORKSPACE_WORKDIR, WORKSPACE_HOME,
} from './config/constants';
import { WORKSPACE_VUE_CONFIG } from './workspace-config';

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
export async function createWorkspaceInstance(store: Store, name: string, appId: string, cluster: string): Promise<void> {
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
      values:           { hostCluster: cluster },
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
  `exec setpriv --reuid=1000 --regid=1000 --init-groups /bin/sh -c '${ [
    'set -e',
    `export HOME=${ WORKSPACE_HOME }`,
    'export YARN_CACHE_FOLDER=/workspace/.yarn-cache',
    // `\${repo}` and `\${port}` are Apps Plus's to substitute when the App is rendered, so
    // they are written as text here rather than interpolated.
    `[ -d ${ WORKSPACE_WORKDIR }/.git ] || git clone --depth 1 https://github.com/\${repo} ${ WORKSPACE_WORKDIR }`,
    `cd ${ WORKSPACE_WORKDIR }`,
    '[ -f .install-done ] || (yarn install --network-timeout 600000 && touch .install-done)',
    'git checkout -- vue.config.js || true',
    'cp vue.config.js vue.config.orig.js',
    'cp /dev-config/vue.config.js vue.config.js',
    'exec yarn dev --port ${port}',
  ].join(' && ') }'`,
].join(' && ');

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
    metadata:   { name: DEFAULT_APP },
    spec:       {
      description: 'A rancher/dashboard checkout with its dependencies installed and the dev server running, pointed at the Rancher this cluster belongs to. The first start is minutes: a clone, a yarn install and a first compile.',
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
      },
      valueLabels: {
        repo:        'GitHub repository to clone',
        port:        'Port the dev server listens on',
        scheme:      'http or https',
        image:       'Container image',
        hostCluster: 'Cluster the workspace runs on',
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
            '              value: https://$(NODE_IP)',
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
            '      volumes:',
            '        - name: work',
            '          hostPath:',
            '            path: /var/lib/rancher/dev-workspaces/${install}',
            '            type: DirectoryOrCreate',
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
            '',
          ].join('\n'),
        },
      ],
    },
  };
}

/** Create the built-in App if it is missing. Quiet: this runs for everyone on every load. */
export async function ensureDefaultApp(store: Store): Promise<void> {
  if (!appsPlusAvailable(store)) {
    return;
  }

  const apps = await store.dispatch('management/findAll', { type: APP }).catch(() => null);

  if (!apps || apps.some((app: Json) => app.metadata?.name === DEFAULT_APP)) {
    return;
  }

  const app = await store.dispatch('management/create', { type: APP, ...rancherWorkspaceApp() });

  await app.save().catch(() => {});
}
