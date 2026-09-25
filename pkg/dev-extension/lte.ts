// Leased tooling: a workspace that holds the work, and tools that hold nothing.
//
// The workspace App this product started with puts everything in one pod - the checkout, the
// toolchain, a dev server that is always compiling, and a Chromium beside it - so a workspace
// costs what all of that costs for as long as it exists, whether or not anyone is using any of
// it. Most of a day, nobody is: a fix waiting on review, a review waiting on the author, a
// branch nobody has opened since Friday. That idle cost is what this is for.
//
// So it is split in two. `lte-workspace` is the *unit of work*: the checkout, the artifacts,
// the recordings, the notes, and the command-line tools an agent uses on them - git, gh, jq,
// ImageMagick, ffmpeg, kubectl. It runs nothing, so at rest it is a sleeping container and some
// disk. Everything that costs something while it is up is a tool with a pod of its own, started
// when it is wanted and released when it is not: the dev server, a storybook, a Rancher to test
// against. The one exception is the browser, which is shared (see ensureGithubBrowser in api.ts)
// and handed out as a CDP browser context rather than a pod.
//
// A tool is an Apps Plus App like everything else here, but its objects are rendered by dev-api
// rather than by Fleet. That is deliberate: agents start tools, agents work while nobody has a
// dashboard open, and an AppInstance with no browser to render it is a record with nothing
// behind it. dev-api can render (the templates are string substitution) and can also sweep, so
// starting, leasing and reaping all happen in the one place that is always running.

import {
  LABEL_WORKSPACE, LABEL_APP, LABEL_CLUSTER, LABEL_TOOL, LABEL_TOOL_OF,
  APP_KIND_LABEL, APP_KIND_WORKSPACE, LTE_APP, TOOL_APPS,
  WORKSPACE_PORT_ANNOTATION, WORKSPACE_SCHEME_ANNOTATION, DEV_API_IN_CLUSTER,
} from './config/constants';
import { WORKSPACE_VUE_CONFIG } from './workspace-config';
import { GITHUB_BROWSER_CDP } from './api';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

/** The labels every object of a workspace carries, for the sweeps that find them again. */
const WORKSPACE_LABELS = [
  `    ${ LABEL_WORKSPACE }: \${install}`,
  `    ${ LABEL_APP }: \${app}`,
  `    ${ LABEL_CLUSTER }: \${hostCluster}`,
].join('\n');

function yamlBlock(text: string, indent: number): string {
  const pad = ' '.repeat(indent);

  return text.split('\n').map((line) => (line ? pad + line : line)).join('\n');
}

// ── The workspace: a tree, a toolbelt, and nothing running ──────────────────────────────────

/**
 * What an agent reaches for that is not already in the image, and is not worth a pod.
 *
 * The rule for this list is the one the split is built on: a *command* belongs in the
 * workspace, because it runs for a second and then stops costing anything; a *server* does
 * not, because it runs until something stops it. ImageMagick to crop a screenshot before it
 * goes on a pull request, ffmpeg to cut a recording, gh to read and write GitHub, jq to read an
 * API, ripgrep to search the checkout. None of them are running when nobody is running them.
 */
const TOOLBELT = 'ffmpeg jq lsof iproute2 imagemagick ripgrep unzip zip less file';

/**
 * The workspace's boot, as root and then as node.
 *
 * The same shape as the original App's (apps.ts, WORKSPACE_SCRIPT) - the IPv4 pin for apt, the
 * shared yarn/Cypress/node_modules caches, the git init-and-fetch rather than a clone - and it
 * ends differently: there is no `exec serve.sh` at the bottom, because a dev server here is a
 * tool with a pod of its own. The container's process is a sleep, and everything that happens
 * in this pod happens because a conversation forwarded a command into it.
 */
const LTE_SCRIPT = [
  'set -e',
  // The node has no working IPv6 route to the Debian mirror; without this an apt resolves an
  // IPv6 address and hangs on it for minutes while holding the lock. Same fix, same reason as
  // the original App - see apps.ts.
  "mkdir -p /etc/apt/apt.conf.d && printf 'Acquire::ForceIPv4 \"true\";\\nAcquire::Retries \"3\";\\n' > /etc/apt/apt.conf.d/99dev-ipv4",
  'WS=/workspaces/${install}',
  'mkdir -p $WS/.home $WS/artifacts',
  'chown node:node $WS $WS/.home $WS/artifacts 2>/dev/null || true',
  '[ -f $WS/.owned ] || (chown -R node:node $WS 2>/dev/null; touch $WS/.owned)',
  // tmux and kubectl, which is what a conversation's tunnel needs at the far end. No claude:
  // the conversations run in the agent pod and reach this one through dev-shell.
  '[ -f /seed/terminal-tools.sh ] && (TOOLS_NO_CLAUDE=1 HOME_DIR=$WS/.home /bin/sh /seed/terminal-tools.sh >$WS/.terminal-tools.log 2>&1 &) || true',
  // The toolbelt, in the background so the tree is usable while it installs, and with a marker
  // so `tools` can say whether it is there yet. gh comes from GitHub's own apt repository
  // because Debian's is years behind and the skills use subcommands it does not have.
  `[ -f $WS/.toolbelt-done ] || (( apt-get -o DPkg::Lock::Timeout=300 update -qq && DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=300 install -y -qq ${ TOOLBELT } && ( command -v gh >/dev/null 2>&1 || ( curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /usr/share/keyrings/githubcli-archive-keyring.gpg && chmod a+r /usr/share/keyrings/githubcli-archive-keyring.gpg && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list && apt-get -o DPkg::Lock::Timeout=300 update -qq && DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=300 install -y -qq gh ) ) && touch $WS/.toolbelt-done ) >$WS/.toolbelt.log 2>&1 &) || true`,
  `exec setpriv --reuid=1000 --regid=1000 --init-groups /bin/sh -c '${ [
    'set -e',
    'WS=/workspaces/${install}',
    'SHARED=/workspaces/.shared',
    'export HOME=$WS/.home',
    'mkdir -p $SHARED/yarn $SHARED/npm $SHARED/template 2>/dev/null || true',
    'export YARN_CACHE_FOLDER=$SHARED/yarn npm_config_cache=$SHARED/npm',
    // init + fetch rather than clone: the agent seed writes `.claude` into this tree and may
    // get there first, and clone refuses a directory that is not empty.
    '[ -d $WS/dashboard/.git ] || ( mkdir -p $WS/dashboard && cd $WS/dashboard && git init -q && { git remote add origin https://github.com/${repo} 2>/dev/null || true; } && D=$(git ls-remote --symref origin HEAD | sed -n "s@^ref: refs/heads/\\(.*\\)[[:space:]]HEAD@\\1@p") && git fetch --depth 1 origin "$D" && git checkout -f -B "$D" FETCH_HEAD )',
    'cd $WS/dashboard',
    // node_modules hard-linked out of a template of the same lockfile, which is what keeps a
    // second workspace's dependencies at the cost of its directory entries. Same as apps.ts.
    'H=$(sha1sum yarn.lock 2>/dev/null | cut -c1-12)',
    '[ -n "$H" ] && [ ! -d node_modules ] && [ -d $SHARED/template/$H/node_modules ] && cp -al $SHARED/template/$H/node_modules node_modules && touch .install-done || true',
    '[ -f .install-done ] || (yarn install --mutex file:$SHARED/yarn/.mutex --network-timeout 600000 && touch .install-done)',
    '[ -n "$H" ] && [ -d node_modules ] && [ ! -d $SHARED/template/$H ] && (mkdir -p $SHARED/template/$H && cp -al node_modules $SHARED/template/$H/node_modules || rm -rf $SHARED/template/$H) || true',
    // And then nothing. The pod is here to hold the tree and to be exec-ed into; a tool that
    // serves something is a tool, with a pod and a lease of its own.
    'echo "[workspace] ready: the tree is at $WS, tools are started with \\`tools start <kind>\\`"',
    'exec sleep infinity',
  ].join(' && ') }'`,
].join(' && ');

export function lteWorkspaceApp(): Json {
  return {
    apiVersion: 'appsplus.io/v1alpha1',
    kind:       'App',
    metadata:   { name: LTE_APP, labels: { [APP_KIND_LABEL]: APP_KIND_WORKSPACE } },
    spec:       {
      description: 'A unit of work and the commands that act on it: a rancher/dashboard checkout with its dependencies installed, its artifacts and recordings, and a toolbelt (git, gh, jq, ImageMagick, ffmpeg, kubectl). Nothing runs in it - a dev server, a storybook, a Rancher or a browser is started as a tool when it is needed and released when it is not.',
      values:      {
        repo:        'rancher/dashboard',
        image:       'node:24',
        hostCluster: 'local',
        rancherUrl:  'https://$(NODE_IP)',
      },
      valueLabels: {
        repo:        'GitHub repository to clone',
        image:       'Container image',
        hostCluster: 'Cluster the workspace runs on',
        rancherUrl:  'Rancher its tools point at by default',
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
            WORKSPACE_LABELS,
            '  annotations:',
            // No server here, so no port of its own. The annotations are still written, because
            // every list in this product reads them, and they name where a dev server *would*
            // be - which is the tool's Service, in the tool's namespace.
            `    ${ WORKSPACE_PORT_ANNOTATION }: "8005"`,
            `    ${ WORKSPACE_SCHEME_ANNOTATION }: https`,
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
          name:    'deployment.yaml',
          content: [
            'apiVersion: apps/v1',
            'kind: Deployment',
            'metadata:',
            '  namespace: ${namespace}',
            '  name: ${namespace}',
            '  labels:',
            '    app: ${namespace}',
            WORKSPACE_LABELS,
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
            yamlBlock(WORKSPACE_LABELS, 4),
            '      annotations:',
            `        dev.rancher.io/config: ${ fingerprint(LTE_SCRIPT) }`,
            '    spec:',
            '      serviceAccountName: dev-workspace',
            '      containers:',
            '        - name: workspace',
            '          image: ${image}',
            // Low request, high ceiling. Nothing runs here at rest, so the request is what an
            // idle container actually holds; the ceiling is for the two things that do get run
            // in it and are enormous - `yarn type-check`, which asks for 8 GB of heap in this
            // repository's own scripts, and a production build, which wants about as much.
            // That pair is what used to OOM-kill the old workspace, taking the dev server and
            // every agent command in the pod with it. Here there is no dev server to take.
            '          resources:',
            '            requests:',
            '              cpu: 100m',
            '              memory: 512Mi',
            '            limits:',
            '              cpu: "4"',
            '              memory: 12Gi',
            '          command:',
            '            - /bin/sh',
            '            - -c',
            `            - ${ JSON.stringify(LTE_SCRIPT) }`,
            '          env:',
            '            - name: NODE_OPTIONS',
            '              value: --max_old_space_size=4096',
            '            - name: NODE_IP',
            '              valueFrom:',
            '                fieldRef:',
            '                  fieldPath: status.hostIP',
            '            - name: API',
            '              value: "${rancherUrl}"',
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
            // The browser an agent here drives is the shared one, and the tool it starts is a
            // context on it rather than a Chromium of its own. See tools.ts.
            '            - name: GITHUB_BROWSER_CDP',
            `              value: ${ GITHUB_BROWSER_CDP }`,
            '            - name: CLAUDE_BROWSER_CDP',
            `              value: ${ GITHUB_BROWSER_CDP }`,
            '          envFrom:',
            '            - secretRef:',
            '                name: dev-secrets',
            '                optional: true',
            '          volumeMounts:',
            '            - name: work',
            '              mountPath: /workspaces',
            '            - name: terminal',
            '              mountPath: /seed',
            '              readOnly: true',
            // Ready when the dependencies are in, which is the first moment a command run in
            // here does what it says. Readiness only, never a startup probe: a startup probe
            // that fails takes the pod with it, and a pod that is merely not-ready-yet is still
            // one an agent can be given work in. That lesson cost a day.
            '          readinessProbe:',
            '            exec:',
            '              command:',
            '                - /bin/sh',
            '                - -c',
            '                - test -f /workspaces/${install}/dashboard/.install-done',
            '            initialDelaySeconds: 20',
            '            periodSeconds: 15',
            '            timeoutSeconds: 5',
            '            failureThreshold: 720',
            '      volumes:',
            '        - name: work',
            '          hostPath:',
            '            path: /var/lib/rancher/dev-workspaces',
            '            type: DirectoryOrCreate',
            '        - name: terminal',
            '          configMap:',
            '            name: dev-terminal',
            '            defaultMode: 365',
            '            optional: true',
            '',
          ].join('\n'),
        },
      ],
    },
  };
}

// ── The tools ───────────────────────────────────────────────────────────────────────────────
//
// Each one is an App whose templates dev-api renders into `dev-<workspace>-<kind>`, with the
// same substitutions Apps Plus makes - `${namespace}`, `${install}`, `${app}` and the App's own
// values - plus `${workspace}`, whose tree the tool works on.
//
// Their templates are written as JSON rather than YAML, and that is not a style choice. dev-api
// is the thing that renders a tool (an agent starts one while nobody has a dashboard open, so
// Fleet's renderer, which lives in a browser, cannot be what does it), and Node ships no YAML
// parser. JSON is valid YAML, so these templates still read correctly to Apps Plus itself;
// they simply also read correctly to `JSON.parse`.

/** The labels a tool's objects carry: which tool it is, and whose it is. */
function toolLabels(kind: string): Record<string, string> {
  return { [LABEL_TOOL]: kind, [LABEL_TOOL_OF]: '${workspace}' };
}

/** One template, named as Apps Plus names them and parseable where it has to be. */
function template(name: string, object: Json): Json {
  return { name, content: `${ JSON.stringify(object, null, 2) }\n` };
}

/** A tool's namespace: labelled for the sweep, annotated with where it is served. */
function toolNamespaceTemplate(kind: string, port: number, scheme: string): Json {
  return template('namespace.json', {
    apiVersion: 'v1',
    kind:       'Namespace',
    metadata:   {
      name:        '${namespace}',
      labels:      toolLabels(kind),
      annotations: { [WORKSPACE_PORT_ANNOTATION]: String(port), [WORKSPACE_SCHEME_ANNOTATION]: scheme },
    },
  });
}

/**
 * A tool's Service: NodePort.
 *
 * NodePort rather than ClusterIP because a tool is reached two ways - through this Rancher's
 * service proxy, which is what the dashboard and anyone signed in here uses, and from the node
 * itself, which is what the shared browser uses when an agent points it at a dev server.
 */
function toolService(kind: string, port: number): Json {
  return template('service.json', {
    apiVersion: 'v1',
    kind:       'Service',
    metadata:   { name: '${namespace}', namespace: '${namespace}', labels: toolLabels(kind) },
    spec:       {
      type: 'NodePort', selector: { app: '${namespace}' }, ports: [{ name: 'http', port, targetPort: 'http' }],
    },
  });
}

/** The pod template every tool's Deployment shares: one replica, replaced rather than rolled. */
function toolDeployment(kind: string, spec: Json): Json {
  return template('deployment.json', {
    apiVersion: 'apps/v1',
    kind:       'Deployment',
    metadata:   { name: '${namespace}', namespace: '${namespace}', labels: { app: '${namespace}', ...toolLabels(kind) } },
    spec:       {
      replicas: 1,
      selector: { matchLabels: { app: '${namespace}' } },
      strategy: { type: 'Recreate' },
      template: { metadata: { labels: { app: '${namespace}', ...toolLabels(kind) } }, spec },
    },
  });
}

/** The node's workspaces root, which is how a tool sees the tree the agent is editing. */
const WORK_VOLUME = { name: 'work', hostPath: { path: '/var/lib/rancher/dev-workspaces', type: 'DirectoryOrCreate' } };

/**
 * The dev server, as a pod of its own.
 *
 * It mounts the node's workspaces root and serves the workspace's checkout, so it is the same
 * tree the agent is editing and a save still reaches the browser. The only thing that changed
 * is which pod the compiler is in - and therefore what is still running at four in the morning.
 * The config is passed by path, exactly as before (workspace-config.ts), so the checkout stays
 * the repository's.
 *
 * There is no supervisor loop here, and there does not need to be one. The old server shared a
 * container with everything else, so it could not be allowed to take the container down with
 * it; this pod *is* the server, so a crash is a restart and the kubelet does it.
 */
function devServerToolApp(): Json {
  return {
    apiVersion: 'appsplus.io/v1alpha1',
    kind:       'App',
    metadata:   { name: TOOL_APPS['dev-server'] },
    spec:       {
      description: 'A rancher/dashboard dev server on a leased workspace\'s checkout, pointed at a Rancher. Its own pod, so it can be released the moment the work stops needing it.',
      values:      {
        workspace: '', image: 'node:24', port: 8005, rancherUrl: 'https://$(NODE_IP)',
      },
      valueLabels: {
        workspace: 'Workspace whose checkout it serves', image: 'Container image', port: 'Port it listens on', rancherUrl: 'Rancher it talks to',
      },
      templates: [
        toolNamespaceTemplate('dev-server', 8005, 'https'),
        template('config.json', {
          apiVersion: 'v1',
          kind:       'ConfigMap',
          metadata:   { name: 'dev-config', namespace: '${namespace}' },
          data:       { 'vue.config.js': WORKSPACE_VUE_CONFIG, 'package.json': '{"name": "dev-workspace-config", "private": true}' },
        }),
        toolDeployment('dev-server', {
          containers: [{
            name:       'dev-server',
            image:      '${image}',
            // One webpack: 4 GB of heap and the cores it can get. The ceiling is what a single
            // compile takes and no more, because there is nothing else in this pod - which is
            // the whole difference between this and the container it came out of, where a
            // type-check beside the server was what kept OOM-killing both.
            resources:  { requests: { cpu: '250m', memory: '1Gi' }, limits: { cpu: '2', memory: '6Gi' } },
            workingDir: '/workspaces/${workspace}/dashboard',
            command:    ['/bin/sh', '-c', [
              'set -e',
              'export HOME=/workspaces/${workspace}/.home',
              'export YARN_CACHE_FOLDER=/workspaces/.shared/yarn npm_config_cache=/workspaces/.shared/npm',
              // The workspace installs the dependencies; this waits rather than installing a
              // second copy. Exiting is the wait: the kubelet backs off and tries again, and
              // the tool comes up by itself once the tree is ready.
              '[ -x node_modules/.bin/vue-cli-service ] || { echo "[dev-server] waiting for the workspace to finish installing its dependencies"; sleep 20; exit 1; }',
              'exec setpriv --reuid=1000 --regid=1000 --init-groups nice -n 10 env VUE_CLI_SERVICE_CONFIG_PATH=/dev-config/vue.config.js yarn dev --port ${port}',
            ].join(' && ')],
            ports:      [{ name: 'http', containerPort: '${port}' }],
            env:        [
              { name: 'NODE_OPTIONS', value: '--max_old_space_size=4096' },
              { name: 'DEV_PROXY_PATH', value: '' },
              { name: 'NODE_IP', valueFrom: { fieldRef: { fieldPath: 'status.hostIP' } } },
              { name: 'API', value: '${rancherUrl}' },
              { name: 'RANCHER_URL', value: '${rancherUrl}' },
            ],
            volumeMounts:   [
              { name: 'work', mountPath: '/workspaces' },
              { name: 'dev-config', mountPath: '/dev-config', readOnly: true },
            ],
            readinessProbe: {
              tcpSocket: { port: '${port}' }, initialDelaySeconds: 15, periodSeconds: 10, failureThreshold: 180,
            },
          }],
          volumes: [WORK_VOLUME, { name: 'dev-config', configMap: { name: 'dev-config' } }],
        }),
        toolService('dev-server', 8005),
      ],
    },
  };
}

/** Storybook on the same checkout, on 6006. The same arrangement as the dev server. */
function storybookToolApp(): Json {
  return {
    apiVersion: 'appsplus.io/v1alpha1',
    kind:       'App',
    metadata:   { name: TOOL_APPS.storybook },
    spec:       {
      description: 'The dashboard\'s Storybook on a leased workspace\'s checkout. Its own pod, released when the work stops needing it.',
      values:      { workspace: '', image: 'node:24', port: 6006 },
      valueLabels: { workspace: 'Workspace whose checkout it serves', image: 'Container image', port: 'Port it listens on' },
      templates:   [
        toolNamespaceTemplate('storybook', 6006, 'http'),
        toolDeployment('storybook', {
          containers: [{
            name:       'storybook',
            image:      '${image}',
            resources:  { requests: { cpu: '250m', memory: '1Gi' }, limits: { cpu: '2', memory: '6Gi' } },
            // Storybook is a package of its own inside the checkout, with a lockfile of its own:
            // `yarn storybook` at the top only cds into it, and its binary is not there until
            // that package has been installed. So this installs it once - and unlike the dev
            // server, which only reads before it drops privileges, the whole command runs as the
            // tree's owner, because an install as root leaves root-owned node_modules in a
            // workspace the agent then cannot write to.
            command:    ['/bin/sh', '-c', `exec setpriv --reuid=1000 --regid=1000 --init-groups /bin/sh -c '${ [
              'set -e',
              'export HOME=/workspaces/${workspace}/.home',
              'export YARN_CACHE_FOLDER=/workspaces/.shared/yarn npm_config_cache=/workspaces/.shared/npm',
              'cd /workspaces/${workspace}/dashboard/storybook || { echo "[storybook] this checkout has no storybook directory"; sleep 30; exit 1; }',
              '[ -d ../node_modules ] || { echo "[storybook] waiting for the workspace to finish installing its dependencies"; sleep 20; exit 1; }',
              '[ -d node_modules ] || yarn install --frozen-lockfile --network-timeout 600000',
              'exec nice -n 10 yarn storybook --port ${port} --no-open --ci --host 0.0.0.0',
            ].join(' && ') }'`],
            ports:      [{ name: 'http', containerPort: '${port}' }],
            env:        [{ name: 'NODE_OPTIONS', value: '--max_old_space_size=4096' }],
            volumeMounts:   [{ name: 'work', mountPath: '/workspaces' }],
            readinessProbe: {
              tcpSocket: { port: '${port}' }, initialDelaySeconds: 15, periodSeconds: 10, failureThreshold: 180,
            },
          }],
          volumes: [WORK_VOLUME],
        }),
        toolService('storybook', 6006),
      ],
    },
  };
}

/**
 * A Rancher to test against, in a pod, with its own embedded k3s.
 *
 * Four things make this work at all, and each of them fails with an error about something else
 * (found the hard way in rancher-project-k8s; the reasons belong beside the manifest):
 *
 *   1. `automountServiceAccountToken: false`. With a token Rancher decides it is managing the
 *      *host* cluster and hangs at "Waiting for initial data to be populated"; without one it
 *      starts its own embedded k3s and needs no permissions here at all.
 *   2. An `/etc/nsswitch.conf`, which these images do not ship. Without it Rancher's per-cluster
 *      chroot jail fails with `error running the jail command: exit status 1`.
 *   3. `dnsPolicy: None` with public nameservers. The nested containerd cannot resolve through
 *      cluster DNS, so nested pods sit at Init:0/1 and Rancher dies saying the apiserver "did
 *      not contact the rancher imperative api in time" - a DNS problem wearing an API problem's
 *      error.
 *   4. Non-default CIDRs for the nested k3s. k3s and RKE2 both default to 10.42/10.43, so a
 *      nested cluster claims the outer pod network: Rancher answers /ping on localhost while
 *      every other pod times out, because the replies route into the nested cni0.
 */
function rancherToolApp(): Json {
  return {
    apiVersion: 'appsplus.io/v1alpha1',
    kind:       'App',
    metadata:   { name: TOOL_APPS.rancher },
    spec:       {
      description: 'A Rancher to test against: rancher/rancher with its own embedded k3s, in a pod, up in a couple of minutes. Its own lease, so a workspace is never holding a Rancher it has finished with.',
      values:      { workspace: '', image: 'rancher/rancher:v2.12.2', password: 'dj9971dj9971' },
      valueLabels: { workspace: 'Workspace it belongs to', image: 'Rancher image', password: 'Admin password it bootstraps with' },
      templates:   [
        toolNamespaceTemplate('rancher', 443, 'https'),
        template('config.json', {
          apiVersion: 'v1',
          kind:       'ConfigMap',
          metadata:   { name: 'rancher-config', namespace: '${namespace}' },
          // (2) and (4) above, as files.
          data:       { 'nsswitch.conf': 'hosts: files dns\n', 'config.yaml': 'cluster-cidr: 10.52.0.0/16\nservice-cidr: 10.53.0.0/16\n' },
        }),
        toolDeployment('rancher', {
          // (1): a token is what makes Rancher try to manage the cluster it is running in.
          automountServiceAccountToken: false,
          // (3): its own resolvers, because the nested containerd cannot use the cluster's.
          dnsPolicy:  'None',
          dnsConfig:  { nameservers: ['1.1.1.1', '8.8.8.8'] },
          containers: [{
            name:            'rancher',
            image:           '${image}',
            securityContext: { privileged: true },
            // A whole Kubernetes: etcd, an apiserver, a controller manager, a scheduler, a
            // containerd and Rancher itself, all starting at once. Two ceilings killed it at
            // 6Gi and at three cores - exit 137 fifty seconds in, five times over - and the
            // manifest this is taken from (rancher-project-k8s) sets neither, for that reason.
            // So: a request that reserves what it settles at, a memory ceiling with room for
            // the start, and no CPU limit at all, since throttling a starting control plane is
            // how its leases expire and the whole thing gives up.
            resources:       { requests: { cpu: '500m', memory: '2Gi' }, limits: { memory: '10Gi' } },
            env:             [
              { name: 'CATTLE_BOOTSTRAP_PASSWORD', value: '${password}' },
              { name: 'CATTLE_PASSWORD_MIN_LENGTH', value: '8' },
            ],
            ports:        [{ name: 'http', containerPort: 443 }],
            volumeMounts: [
              { name: 'config', mountPath: '/etc/nsswitch.conf', subPath: 'nsswitch.conf' },
              { name: 'config', mountPath: '/etc/rancher/k3s/config.yaml', subPath: 'config.yaml' },
              { name: 'data', mountPath: '/var/lib/rancher' },
              { name: 'shm', mountPath: '/dev/shm' },
            ],
            readinessProbe: {
              httpGet: { path: '/ping', port: 443, scheme: 'HTTPS' }, initialDelaySeconds: 30, periodSeconds: 10, failureThreshold: 90,
            },
          }],
          volumes: [
            // Its data is deliberately not on the node. A Rancher tool is a Rancher to try
            // something against; one that outlives its lease with state in it is exactly the
            // thing this whole arrangement exists not to keep.
            { name: 'data', emptyDir: {} },
            { name: 'shm', emptyDir: { medium: 'Memory', sizeLimit: '1Gi' } },
            { name: 'config', configMap: { name: 'rancher-config' } },
          ],
        }),
        toolService('rancher', 443),
      ],
    },
  };
}

/** Every App this arrangement adds: the workspace, and the tools it can attach. */
export function lteApps(): Json[] {
  return [lteWorkspaceApp(), devServerToolApp(), storybookToolApp(), rancherToolApp()];
}

/** The same FNV the rest of this product fingerprints definitions with (apps.ts). */
function fingerprint(text: string): string {
  let h = 2166136261;

  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }

  return (h >>> 0).toString(16);
}
