/**
 * The Dev product's half of the Claude Harness, expressed in Kubernetes.
 *
 * A workspace is a namespace `dev-<name>` holding a Deployment and a Service, all three
 * labelled with the workspace's name so the list can find them again. Starting and stopping is
 * scaling the Deployment between one replica and none, which is the Kubernetes shape of the
 * harness's `docker start` / `docker stop`; deleting is deleting the namespace, so nothing can
 * be left behind by a resource this file forgot it created.
 *
 * The harness calls this a project. It is a workspace here because Rancher already has
 * projects, and they are a different thing living one nav entry away (see config/constants).
 * The `dev-` namespace prefix is unaffected: that names the product, not the concept.
 *
 * Everything goes through the browser's own Rancher session: same-origin `fetch` against
 * Steve on `/k8s/clusters/<cluster>/v1`, with the CSRF header the API wants on writes. There
 * is no controller and no credential anywhere in here.
 */
import {
  templateById, TEMPLATES, DevTemplate, DevSidecar, GLOBAL_SECRETS, WORKSPACE_WORKDIR, WORKSPACE_HOME,
  WORKSPACE_QUEUE
} from './templates';
import { MANAGER_RULES } from './rancher-sidecar';
import {
  DevShare, shareName, nginxConf, htpasswd, sharePodSpec
} from './share';
import { WORKSPACE_VUE_CONFIG, WORKSPACE_CONFIG_MOUNT } from './workspace-config';
import { INSIGHTS_SERVER } from './insights-server';
import { WORKSPACE_API_SERVER } from './workspace-api';
import { DevPrompt, DEFAULT_PROMPTS } from './prompts';
import { BROWSER_EXTENSION_FILES } from './browser-extension';
// Which pod this dashboard is being served from. Worked out from the URL rather than written
// down, because barn runs one of these per named extension - see config/constants.
import { DEV_POD_NAMESPACE as POD_NAMESPACE, DEV_POD_SERVICE as POD_SERVICE } from './config/constants';

// The `local` cluster, like the pod this dev server runs in. The product shows no cluster
// switcher, so there is nothing that could make this a choice.
/**
 * The cluster every call below is about.
 *
 * A workspace can be hosted on any cluster this Rancher manages, not only the one Rancher runs
 * in, so this is a variable rather than a constant. It is read at call time by the eighty-odd
 * template strings that build a URL, which is why setting it is enough and none of them takes a
 * cluster of its own.
 *
 * One at a time, deliberately. A page is about one workspace, and a workspace is in one cluster,
 * so opening one sets this before it asks anything else and every request that follows agrees.
 * The one thing that is genuinely about several clusters is listing workspaces, and that takes
 * its cluster explicitly (see listWorkspaces) rather than moving this under its own feet.
 */
const DEFAULT_CLUSTER = 'local';

let currentCluster = DEFAULT_CLUSTER;
let BASE = clusterBase(DEFAULT_CLUSTER);

export function clusterBase(cluster: string): string {
  return `/k8s/clusters/${ cluster }`;
}

/** Point every call that follows at a cluster. Called when a workspace is opened. */
export function setCluster(cluster: string): void {
  currentCluster = cluster || DEFAULT_CLUSTER;
  BASE = clusterBase(currentCluster);
}

export function activeCluster(): string {
  return currentCluster;
}

/** The label a workspace's namespace carries, so its cluster survives a page reload. */
export const LABEL_CLUSTER = 'dev.rancher.io/cluster';

/** One cluster this Rancher manages, with enough of its capacity to choose between them. */
export interface DevCluster {
  id: string;
  name: string;
  state: string;
  /** Bytes not asked for by anything, or 0 where the cluster does not say. */
  memoryFree: number;
  diskFree: number;
}

/**
 * Kubernetes quantities as a number of bytes.
 *
 * They arrive as `65166836Ki`, `518Mi` or a bare `466047163641`, and the difference between the
 * three is a suffix rather than a scale anyone would guess. Binary units, which is what the
 * suffix means: Ki is 1024, not 1000.
 */
function bytes(quantity: string): number {
  const match = /^(\d+(?:\.\d+)?)([KMGTP]i?)?$/.exec(String(quantity || '').trim());

  if (!match) {
    return 0;
  }

  const scale: Record<string, number> = {
    Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3, Ti: 1024 ** 4, Pi: 1024 ** 5,
    K: 1e3, M: 1e6, G: 1e9, T: 1e12, P: 1e15,
  };

  return Number(match[1]) * (scale[match[2] || ''] || 1);
}

/**
 * The clusters a workspace could be hosted on, with what is left on each.
 *
 * Memory comes from Rancher's own view of a cluster, which knows both what its nodes can offer
 * and what the pods already on it have asked for. Disk does not: Rancher does not carry
 * ephemeral storage at the cluster level, so the nodes are asked, and what is reported is what
 * they can allocate rather than what is unclaimed - almost nothing requests ephemeral storage,
 * so the two are the same number in practice and the difference is worth knowing about.
 *
 * A cluster that cannot be reached is still offered, with no numbers beside it. It is a cluster
 * somebody may still want, and refusing to list it would be this page deciding that for them.
 */
export async function listClusters(): Promise<DevCluster[]> {
  const response = await devFetch('/v3/clusters').catch(() => null);
  const clusters = (response?.data || []).filter((cluster: Json) => cluster.state === 'active');

  return Promise.all(clusters.map(async(cluster: Json) => {
    const memoryFree = Math.max(0, bytes(cluster.allocatable?.memory) - bytes(cluster.requested?.memory));
    const [nodes, pods] = await Promise.all([
      devFetch(`${ clusterBase(cluster.id) }/v1/nodes`).catch(() => null),
      devFetch(`${ clusterBase(cluster.id) }/v1/pods`).catch(() => null),
    ]);

    const allocatable = (nodes?.data || [])
      .reduce((total: number, node: Json) => total + bytes(node.status?.allocatable?.['ephemeral-storage']), 0);

    // What the pods on it have asked for, summed here because Rancher's own `requested` carries
    // cpu, memory and pods and not this. Almost nothing requests ephemeral storage, so this is
    // usually nothing at all - but a cluster where something does would otherwise be offered as
    // having room it has already given away.
    const requested = (pods?.data || [])
      .flatMap((pod: Json) => pod.spec?.containers || [])
      .reduce((total: number, container: Json) => total + bytes(container.resources?.requests?.['ephemeral-storage']), 0);

    return {
      id:    cluster.id,
      name:  cluster.name || cluster.id,
      state: cluster.state,
      memoryFree,
      diskFree: Math.max(0, allocatable - requested),
    };
  }));
}

/** A byte count as a person reads it, which is one number and one unit. */
export function readableBytes(value: number): string {
  if (!value) {
    return 'unknown';
  }

  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let scaled = value;
  let unit = 0;

  while (scaled >= 1024 && unit < units.length - 1) {
    scaled /= 1024;
    unit += 1;
  }

  return `${ scaled >= 10 || unit === 0 ? Math.round(scaled) : scaled.toFixed(1) } ${ units[unit] }`;
}

/** Everything a workspace owns carries these, and the list is built by filtering on them. */
export const LABEL_WORKSPACE = 'dev.rancher.io/workspace';
export const LABEL_TEMPLATE = 'dev.rancher.io/template';
/**
 * Which sidecar a Deployment, Service or pod is, when it is one.
 *
 * Declared here with the other two rather than beside the sidecar code, because its absence is
 * what identifies the workspace's own objects. See ownedByWorkspace.
 */
export const LABEL_SIDECAR = 'dev.rancher.io/sidecar';

/**
 * Ask Steve for the labelled things only, rather than for everything.
 *
 * Two query parameters that look like the same feature, and only one of them is: Steve
 * ignores Kubernetes' `labelSelector` and answers with the whole collection anyway (asked for
 * this label, it hands back all two dozen namespaces of this cluster, workspace or not),
 * while its own `filter` does the work, and matches a value exactly rather than by substring.
 *
 * It is an optimisation and only that. Every caller of it filters what comes back as well,
 * because a Steve that ignored this parameter would answer with everything, and that
 * browser-side pass is what keeps such a Steve a slower list rather than a wrong one. Neither
 * half is redundant: this one is the saving, the one below it is the guarantee.
 */
const WORKSPACE_FILTER = `filter=metadata.labels[${ LABEL_WORKSPACE }]`;

/**
 * The one container in a workspace's pod. Named here rather than after the template because
 * the terminal has to address it, and a name that varies would make that a lookup.
 */
export const WORKSPACE_CONTAINER = 'workspace';

/** Kubernetes name rules, minus the parts a 63-character workspace name cannot reach. */
const NAME_PATTERN = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;
const MAX_NAME_LENGTH = 40;

export type WorkspaceState = 'running' | 'stopped' | 'starting' | 'creating' | 'removing' | 'error';

export interface DevWorkspace {
  /** The cluster it is hosted on, from its namespace's label. See LABEL_CLUSTER. */
  cluster: string;
  name: string;
  namespace: string;
  /** The template id. Kept even when it names a template that no longer exists. */
  template: string;
  templateLabel: string;
  state: WorkspaceState;
  createdAt: string;
  /**
   * The image the Deployment actually runs, which is not always the template's: anything can
   * edit a Deployment after this created it, and a page that reads the image back off the
   * template would go on describing a container that is no longer there.
   */
  image: string;
  /** What the Deployment is scaled to, and what it actually has. */
  replicas: number;
  ready: number;
  /**
   * Which minute of a long start this is in, in the pod's own words.
   *
   * A workspace that clones a repository, installs it and compiles it is Starting for several
   * minutes, and "Starting" for four minutes is indistinguishable from broken. The pod knows
   * the difference between pulling an image, waiting to be scheduled, crash-looping and simply
   * taking a while, so this carries whichever of those it is.
   */
  detail: string;
}

/** A workspace's Service, as it exists rather than as its template described it. */
export interface DevService {
  name: string;
  port: number;
  /** The port it is published on the node at, when the template asked for an origin of its own. */
  nodePort: number;
}

// Steve hands back plain JSON with no types worth importing, and narrowing it here would only
// be a second description of the same shapes. The accessors below are the narrowing.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

function csrfHeader(): Record<string, string> {
  const match = document.cookie.match(/(?:^|;\s*)CSRF=([^;]*)/);

  return { 'X-Api-Csrf': match ? decodeURIComponent(match[1]) : 'CSRF' };
}

/**
 * Same-origin request to Rancher, with the CSRF header on anything that writes.
 *
 * Rancher rejects a write without it, and the value is the CSRF cookie the session already
 * set, so this needs nothing the page does not have.
 */
export async function devFetch(path: string, init?: RequestInit): Promise<Json> {
  const write = !!init?.method && init.method !== 'GET';
  const resp = await fetch(path, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Accept:         'application/json',
      ...(write ? csrfHeader() : {}),
      ...(init?.headers || {}),
    },
  });
  const data = await resp.json().catch(() => ({}));

  if (!resp.ok) {
    throw new Error(data.message || data.error || `HTTP ${ resp.status }`);
  }

  return data;
}

/**
 * The namespace a workspace lives in.
 *
 * Still `dev-`, deliberately, through the rename from project to workspace: the prefix says
 * which product owns the namespace, and that product is still Dev.
 */
export function workspaceNamespace(name: string): string {
  return `dev-${ name }`;
}

/**
 * Why a name is not usable, or '' when it is.
 *
 * Checked before the create rather than left to the apiserver: its own message names the
 * generated namespace and quotes the RFC, which tells someone who typed a capital letter very
 * little about what to type instead.
 */
export function workspaceNameError(name: string): string {
  if (!name) {
    return 'A name is required';
  }

  if (name.length > MAX_NAME_LENGTH) {
    return `A name can be at most ${ MAX_NAME_LENGTH } characters`;
  }

  if (!NAME_PATTERN.test(name)) {
    return 'A name can contain only lowercase letters, numbers and dashes, and must start and end with a letter or number';
  }

  return '';
}

/**
 * What a pod is doing, from its own status, or '' when there is nothing worth saying.
 *
 * Only the container's own reasons, not a guess: `waiting.reason` is the apiserver's word for
 * it (ImagePullBackOff, CrashLoopBackOff, ContainerCreating), and a container that is running
 * but not ready is one whose startup probe has not passed yet, which for a workspace that
 * installs on boot is the ordinary case rather than a fault.
 */
function podDetail(pod: Json | undefined): string {
  if (!pod) {
    return '';
  }

  if (pod.metadata?.deletionTimestamp) {
    return 'Terminating';
  }

  const status = pod.status?.containerStatuses?.[0];
  const waiting = status?.state?.waiting;

  if (waiting?.reason) {
    const restarts = status.restartCount ? `, restarted ${ status.restartCount } times` : '';

    return `${ waiting.reason }${ restarts }`;
  }

  if (pod.status?.phase === 'Pending') {
    return 'Waiting to be scheduled';
  }

  if (status?.state?.running && !status.ready) {
    return status.restartCount ? `Starting up, restarted ${ status.restartCount } times` : 'Starting up';
  }

  return '';
}

/**
 * Why a Deployment has no pod at all, in the cluster's own words, or '' when it has one.
 *
 * A pod that never gets created leaves nothing for podDetail to read, so without this the page
 * has only "Starting" to show and shows it forever. The controller records the reason on the
 * Deployment as a ReplicaFailure condition, which is where a missing ServiceAccount, a quota and
 * a rejected pod spec all end up, and its message is the apiserver's own sentence.
 */
function replicaFailure(deployment: Json | undefined): string {
  const condition = (deployment?.status?.conditions || [])
    .find((entry: Json) => entry.type === 'ReplicaFailure' && entry.status === 'True');

  return condition?.message || '';
}

/**
 * Container reasons that are a failure rather than a stage of starting.
 *
 * `ImagePullBackOff` has to be named: an image that cannot be pulled alternates between
 * `ErrImagePull` and `ImagePullBackOff`, so a rule that catches only the first leaves the state
 * oscillating between Error and Starting rather than settling on the truth.
 */
const FAILED_REASONS = [
  'CrashLoopBackOff',
  'ImagePullBackOff',
  'ErrImagePull',
  'InvalidImageName',
  'CreateContainerConfigError',
  'CreateContainerError',
];

function isFailedReason(reason: string): boolean {
  return FAILED_REASONS.some((failed) => reason.includes(failed));
}

function stateOf(namespace: Json, deployment: Json | undefined, pod?: Json): WorkspaceState {
  // A namespace being collected still lists, and its Deployment may outlive it by a moment, so
  // deletion is asked about first or a workspace would read as Running while it goes away.
  if (namespace.metadata?.deletionTimestamp) {
    return 'removing';
  }

  if (!deployment) {
    return 'creating';
  }

  if ((deployment.spec?.replicas ?? 0) === 0) {
    return 'stopped';
  }

  if ((deployment.status?.readyReplicas ?? 0) > 0) {
    return 'running';
  }

  // A Deployment the controller cannot make a pod for is not starting either, and it is the
  // case with nothing to look at: no pod, no logs, no events under a name anyone knows.
  if (!pod && replicaFailure(deployment)) {
    return 'error';
  }

  // A pod that keeps dying is not starting, however long you wait, and a workspace that says
  // Starting through fifty restarts is a workspace nobody looks at the logs of.
  const reason = pod?.status?.containerStatuses?.[0]?.state?.waiting?.reason || '';

  return isFailedReason(reason) ? 'error' : 'starting';
}

/**
 * A workspace, out of the namespace that records it and the Deployment that runs it.
 *
 * One function for both readers, so the list and the detail page cannot come to describe the
 * same workspace differently while fetching it two different ways.
 */
function workspaceFrom(namespace: Json, deployment: Json | undefined, pod?: Json, cluster?: string): DevWorkspace {
  const name = namespace.metadata.labels[LABEL_WORKSPACE];
  const template = namespace.metadata.labels[LABEL_TEMPLATE] || '';

  return {
    name,
    namespace:     namespace.metadata.name,
    // The label where there is one, and the cluster it was read from otherwise: a workspace made
    // before this product could host them anywhere is in the cluster it is being listed from.
    cluster:       namespace.metadata.labels[LABEL_CLUSTER] || cluster || activeCluster(),
    template,
    templateLabel: templateById(template)?.label || template || 'Unknown',
    state:         stateOf(namespace, deployment, pod),
    createdAt:     namespace.metadata.creationTimestamp,
    image:         deployment?.spec?.template?.spec?.containers?.[0]?.image || '',
    replicas:      deployment?.spec?.replicas ?? 0,
    ready:         deployment?.status?.readyReplicas ?? 0,
    // The pod's own words where there is a pod, and the controller's where there is not.
    detail:        podDetail(pod) || (pod ? '' : replicaFailure(deployment)),
  };
}

/**
 * Whether a Deployment or a pod is the workspace itself rather than one of its sidecars.
 *
 * A sidecar carries the workspace's label too, deliberately, so that everything a workspace owns
 * can be found by one filter. That makes the label alone the wrong question here, and the two
 * readers of it answered differently: the list built a map with `set` in a loop, so the last
 * sidecar in the collection won, while the detail page used `find`, so the first did. A workspace
 * that had been stopped for an hour read Running in the list, with Stop offered, while its own
 * page offered Start.
 *
 * One predicate for both, and the absence of the sidecar label is what it asks, so a sidecar can
 * never be mistaken for the workspace whatever order the collection arrives in.
 */
function ownedByWorkspace(candidate: Json, name: string): boolean {
  const labels = candidate?.metadata?.labels || {};

  return labels[LABEL_WORKSPACE] === name && !labels[LABEL_SIDECAR];
}

/**
 * Every workspace in the cluster.
 *
 * The namespace is the record of a workspace and the Deployment is its state, so both are
 * fetched and joined here: a workspace that is being created has no Deployment yet, and one
 * being deleted has a namespace that outlives it. Both collections are asked for by label
 * (see WORKSPACE_FILTER) and filtered again below, which is a saving on a cluster of any size
 * and no change to what this returns.
 */
export async function listWorkspaces(cluster?: string): Promise<DevWorkspace[]> {
  // Explicit rather than through BASE, because this is the one thing in the product that asks
  // about a cluster other than the one being looked at: see listAllWorkspaces, which calls it
  // once per cluster and must not move BASE under whatever else is in flight.
  const from = clusterBase(cluster || activeCluster());
  const [namespaces, deployments, pods] = await Promise.all([
    devFetch(`${ from }/v1/namespaces?${ WORKSPACE_FILTER }`),
    devFetch(`${ from }/v1/apps.deployments?${ WORKSPACE_FILTER }`),
    // The third collection is what turns "Starting" into which part of starting. One request
    // for every workspace's pod, not one per workspace, so the list costs the same as it did.
    devFetch(`${ from }/v1/pods?${ WORKSPACE_FILTER }`).catch(() => null),
  ]);

  const byWorkspace = new Map<string, Json>();
  const podByWorkspace = new Map<string, Json>();

  for (const deployment of deployments.data || []) {
    const workspace = deployment.metadata?.labels?.[LABEL_WORKSPACE];

    if (workspace && ownedByWorkspace(deployment, workspace)) {
      byWorkspace.set(workspace, deployment);
    }
  }

  for (const pod of pods?.data || []) {
    const workspace = pod.metadata?.labels?.[LABEL_WORKSPACE];

    if (workspace && ownedByWorkspace(pod, workspace)) {
      podByWorkspace.set(workspace, pod);
    }
  }

  return (namespaces.data || [])
    .filter((namespace: Json) => !!namespace.metadata?.labels?.[LABEL_WORKSPACE])
    .map((namespace: Json) => {
      const name = namespace.metadata.labels[LABEL_WORKSPACE];

      return workspaceFrom(namespace, byWorkspace.get(name), podByWorkspace.get(name), cluster);
    })
    .sort((a: DevWorkspace, b: DevWorkspace) => a.name.localeCompare(b.name));
}

/**
 * Every workspace this person has, on every cluster.
 *
 * What the sidebar shows, because a workspace is a person's rather than a cluster's: somebody
 * with one on each of two clusters wants one list. A cluster that cannot be read contributes
 * nothing rather than taking the list down with it, which is the ordinary case for somebody with
 * access to one cluster out of several.
 */
export async function listAllWorkspaces(): Promise<DevWorkspace[]> {
  const clusters = await listClusters().catch(() => []);
  const lists = await Promise.all(
    (clusters.length ? clusters.map((cluster) => cluster.id) : [activeCluster()])
      .map((id) => listWorkspaces(id).catch(() => [] as DevWorkspace[])),
  );

  return lists.flat().sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * One workspace, or null if it is not there.
 *
 * Its own namespace and that namespace's Deployment, not listWorkspaces filtered down: a
 * workspace already knows where it lives, and the detail page asks this every five seconds.
 * Through the list it would be every workspace in the cluster, twice, to read one back.
 *
 * The Deployment comes from the namespace's collection rather than by name for the reason
 * workspaceService does the same: a workspace in the moment between its namespace and its
 * Deployment answers 200 with nothing in it instead of a 404 the console keeps. The namespace
 * itself is asked for by name, where a 404 is the honest answer to a workspace that has been
 * deleted, and is what puts the page's "there is no workspace called ..." banner up.
 */
export async function getWorkspace(name: string): Promise<DevWorkspace | null> {
  const namespace = workspaceNamespace(name);
  const [record, deployments, pods] = await Promise.all([
    devFetch(`${ BASE }/v1/namespaces/${ namespace }`).catch(() => null),
    devFetch(`${ BASE }/v1/apps.deployments/${ namespace }`).catch(() => null),
    devFetch(`${ BASE }/v1/pods/${ namespace }`).catch(() => null),
  ]);

  // A namespace without the label is not a workspace, whatever it is called.
  if (record?.metadata?.labels?.[LABEL_WORKSPACE] !== name) {
    return null;
  }

  const deployment = (deployments?.data || []).find((candidate: Json) => ownedByWorkspace(candidate, name));
  const pod = (pods?.data || []).find((candidate: Json) => ownedByWorkspace(candidate, name));

  return workspaceFrom(record, deployment, pod);
}

/**
 * The two things a template's environment cannot know until it is a workspace.
 *
 * `{{proxyPath}}` is where this dev server is reached, which is empty for a workspace served at
 * its own origin. `{{ownRancher}}` is the in-cluster address of the Rancher this workspace's own
 * sidecar serves, and it is written in from the moment the workspace is created rather than
 * swapped in when the sidecar starts.
 *
 * That ordering is the whole point. A workspace at its own origin publishes a node port, and the
 * dev server behind it proxies /v1 and /v3 to whatever API names. Pointed at the host by default,
 * that is an unauthenticated path from the node's address into the cluster this product runs in,
 * open for as long as nobody has started the workspace's own Rancher. Pointed at its own Rancher
 * from the start, the worst it can do before that Rancher exists is refuse the connection.
 */
function substituteTemplateEnv(value: string, name: string, template: DevTemplate): string {
  const owns = (template.sidecars || []).find((sidecar) => sidecar.providesApi);

  return value
    .replace('{{proxyPath}}', template.ownOrigin ? '' : workspaceProxyUrl(name, template.port, template.scheme))
    .replace('{{ownRancher}}', owns ? sidecarServiceUrl(name, owns) : '');
}

function deploymentBody(name: string, template: DevTemplate): Json {
  const namespace = workspaceNamespace(name);
  const labels = { app: namespace, [LABEL_WORKSPACE]: name, [LABEL_TEMPLATE]: template.id };

  return {
    apiVersion: 'apps/v1',
    kind:       'Deployment',
    metadata:   { namespace, name: namespace, labels },
    spec:       {
      replicas: 1,
      selector: { matchLabels: { app: namespace } },
      // Recreate rather than RollingUpdate: the checkout is a hostPath, so two pods would be
      // installing into the same directory at the same time.
      strategy: { type: 'Recreate' },
      template: {
        metadata: { labels },
        spec:     {
          // Not the namespace's default ServiceAccount: a workspace runs whatever a template
          // or a person put in it, and this is the identity that says what that is allowed to
          // reach (see ensureDevRbac).
          serviceAccountName: WORKSPACE_SERVICE_ACCOUNT,
          containers:         [{
            name:  WORKSPACE_CONTAINER,
            image: template.image,
            ...(template.command ? { command: template.command } : {}),
            ports: [{ name: 'http', containerPort: template.port }],
            // `{{proxyPath}}` is the one substitution a template gets: the path this workspace
            // is reached at, which contains its own name.
            env:   Object.entries(template.env || {}).map(([envName, value]) => ({
              name:  envName,
              value: substituteTemplateEnv(value, name, template),
            })),
            // The workspace's own secrets, by reference and as a whole Secret rather than key by
            // key. A named list would be fixed at create time, so a key added in Settings later
            // would need the Deployment rewritten; this way the mirror is the list, and it is
            // rewritten before every start. `optional` so a workspace with nothing set still runs.
            envFrom: [{ secretRef: { name: MIRROR_SECRET, optional: true } }],
            volumeMounts: [
              ...(template.hostPath ? [{ name: 'work', mountPath: '/workspace' }] : []),
              // Read-only, and copied rather than mounted over the checkout: a workspace is an
              // ordinary clone someone can edit, and a file mounted into it could not be.
              { name: 'dev-config', mountPath: WORKSPACE_CONFIG_MOUNT, readOnly: true },
              // What a terminal tab runs. Mounted rather than copied, and read straight out of
              // the mount, so a workspace always starts the scripts the extension last wrote
              // without needing a pod restart to pick them up.
              { name: 'terminal', mountPath: WORKSPACE_TERMINAL_MOUNT, readOnly: true },
            ],
            // A first boot is a clone, an install and a compile, which is minutes. A startup
            // probe with a long budget is what stops the kubelet killing a pod that is working,
            // and killing it is not harmless: it throws away a part-finished install.
            ...(template.hostPath ? {
              // A TCP probe rather than an HTTP one: what this is waiting for is the dev server
              // binding its port, and asking it for a page instead means knowing which paths it
              // serves and on which scheme, which is the template's business and not the
              // kubelet's.
              startupProbe: {
                tcpSocket:        { port: template.port },
                periodSeconds:    10,
                failureThreshold: 120,
              },
              readinessProbe: { tcpSocket: { port: template.port }, periodSeconds: 10 },
            } : {}),
          }],
          volumes: [
            ...(template.hostPath ? [{
              name:     'work',
              hostPath: { path: `${ template.hostPath }/${ name }`, type: 'DirectoryOrCreate' },
            }] : []),
            { name: 'dev-config', configMap: { name: WORKSPACE_CONFIG_MAP } },
            // Executable: these are scripts run out of the mount, and a ConfigMap's default
            // mode is 0644, which is a terminal that opens on "permission denied".
            {
              name: 'terminal', configMap: { name: WORKSPACE_TERMINAL_MAP, defaultMode: 0o555, optional: true }
            },
          ],
        },
      },
    },
  };
}

/**
 * Why this name cannot be used right now, or '' when it can.
 *
 * The companion to workspaceNameError, which answers the same question about the shape of a
 * name without asking the cluster. Left to the apiserver, all three cases below come back as
 * one sentence about namespaces, and the most confusing of them (a workspace still being
 * collected, which will free the name shortly) is the one it explains least.
 */
async function workspaceNameConflict(name: string): Promise<string> {
  const namespace = workspaceNamespace(name);

  // The collection rather than a GET of the one namespace, which would be the obvious way to
  // ask. A namespace that is not there answers 404, and the browser prints every 404 to the
  // console whether or not the caller expected it, so the obvious way leaves an error in the
  // log of every successful create. Filtered to the one name, so keeping that quiet costs a
  // request of a couple of hundred bytes rather than a list of every namespace in the
  // cluster. As above the filter is the saving and the `find` is what decides.
  const url = `${ BASE }/v1/namespaces?filter=metadata.name=${ namespace }`;
  const namespaces = await devFetch(url);
  const existing = (namespaces.data || []).find((ns: Json) => ns.metadata?.name === namespace);

  if (!existing) {
    return '';
  }

  if (existing.metadata?.labels?.[LABEL_WORKSPACE] !== name) {
    return `The namespace ${ namespace } already exists and is not a workspace. Pick another name.`;
  }

  if (existing.metadata?.deletionTimestamp) {
    return `A workspace called "${ name }" is still being deleted. Wait for it to finish, or pick another name.`;
  }

  return `A workspace called "${ name }" already exists.`;
}

/**
 * Create a workspace: the namespace, then the Deployment and the Service in it.
 *
 * In that order and awaited, because the other two cannot be created before the namespace
 * exists. Nothing is rolled back if a later step fails: the namespace is left, the list shows
 * the workspace as Creating, and deleting it is one click. Tearing down half a workspace on
 * the user's behalf would be a guess about which half they wanted.
 */
export async function createWorkspace(name: string, templateId: string, cluster?: string): Promise<void> {
  // Everything below builds a URL from BASE, so the cluster is chosen once here rather than
  // threaded through a dozen calls. It stays set afterwards, which is what the page wants: it
  // navigates to the workspace it just made.
  if (cluster) {
    setCluster(cluster);
  }

  const template = templateById(templateId);

  if (!template) {
    throw new Error(`Unknown template "${ templateId }"`);
  }

  // A check, not a guarantee: two people creating the same name at once still race, and the
  // loser gets the apiserver's 409. This is here so the ordinary case, one person picking a
  // name that is taken, reads as a sentence about workspaces rather than one about namespaces.
  const conflict = await workspaceNameConflict(name);

  if (conflict) {
    throw new Error(conflict);
  }

  const namespace = workspaceNamespace(name);
  const labels = {
    [LABEL_WORKSPACE]: name, [LABEL_TEMPLATE]: template.id, [LABEL_CLUSTER]: activeCluster(),
  };

  await devFetch(`${ BASE }/v1/namespaces`, {
    method: 'POST',
    body:   JSON.stringify({
      apiVersion: 'v1',
      kind:       'Namespace',
      metadata:   { name: namespace, labels },
    }),
  });

  // Before the Deployment, because a pod cannot start with a ServiceAccount that is not there
  // yet, and after the namespace, because that is where most of it lives.
  await ensureWorkspaceRbac(name);

  // The dev server's config, which is the one file a workspace does not get from git. See
  // workspace-config.ts for what is in it and why a clone's own config will not do.
  await devFetch(`${ BASE }/v1/configmaps`, {
    method: 'POST',
    body:   JSON.stringify({
      apiVersion: 'v1',
      kind:       'ConfigMap',
      metadata:   { namespace, name: WORKSPACE_CONFIG_MAP, labels },
      data:       { 'vue.config.js': WORKSPACE_VUE_CONFIG },
    }),
  });

  // What a terminal tab runs, before the pod that mounts it. See ensureWorkspaceTerminal.
  await ensureWorkspaceTerminal(name);

  // Before the Deployment, so the pod's first start already has whatever is in the store. It is
  // rewritten on every start as well, since the store can change after this.
  const store = await ensureGeneratedSecrets(template);

  await mirrorSecrets(name, template, store);

  await devFetch(`${ BASE }/v1/apps.deployments`, {
    method: 'POST',
    body:   JSON.stringify(deploymentBody(name, template)),
  });

  await devFetch(`${ BASE }/v1/services`, {
    method: 'POST',
    body:   JSON.stringify(workspaceServiceBody(name, template)),
  });
}

/**
 * The workspace's Service.
 *
 * NodePort rather than ClusterIP when the template needs an origin of its own, which is the whole
 * of what "its own origin" costs: the port is open on the node to anyone who can reach it, with no
 * Rancher session in front of it. The Browser tab says so where it offers the link, and the
 * workspace's API address is its own Rancher rather than this cluster's precisely because of it.
 */
function workspaceServiceBody(name: string, template: DevTemplate): Json {
  const namespace = workspaceNamespace(name);
  const labels = { [LABEL_WORKSPACE]: name, [LABEL_TEMPLATE]: template.id };

  return {
    apiVersion: 'v1',
    kind:       'Service',
    metadata:   { namespace, name: namespace, labels },
    spec:       {
      ...(template.ownOrigin ? { type: 'NodePort' } : {}),
      selector: { app: namespace },
      ports:    [{ name: 'http', port: template.port, targetPort: 'http' }],
    },
  };
}

/**
 * Start or stop a workspace by scaling its Deployment.
 *
 * Read-modify-write rather than a patch: Steve wants the whole object back on a PUT, and
 * sending the one it just handed out is what keeps the resourceVersion check meaningful, so a
 * second tab scaling the same workspace loses the race instead of silently winning it.
 */
export async function setWorkspaceRunning(name: string, running: boolean): Promise<void> {
  const namespace = workspaceNamespace(name);
  const url = `${ BASE }/v1/apps.deployments/${ namespace }/${ namespace }`;

  if (running) {
    // Every start, not only the first. The pod reads its environment once, when it starts, so
    // this is the only moment a key set since the last start can reach it.
    const template = templateById((await devFetch(url)).metadata?.labels?.[LABEL_TEMPLATE] || '');

    await mirrorSecrets(name, template);
    // And the same moment is when a workspace made before this version of the product can be
    // brought into line, since all of it is read when the pod starts and only then.
    await bringWorkspaceUpToDate(name, template);
  }

  // Read after all of that, never before it. bringWorkspaceUpToDate writes the same Deployment,
  // so a copy fetched at the top of this function is stale by the time it gets here, and Steve
  // answers a stale resourceVersion with a 409: the workspace is brought up to date and then
  // does not start, with nothing on the page to say why. It was invisible for as long as that
  // function usually found nothing to change.
  const deployment = await devFetch(url);

  deployment.spec.replicas = running ? 1 : 0;

  await devFetch(url, { method: 'PUT', body: JSON.stringify(deployment) });
}

/**
 * Bring a workspace's Service and dev server into line with the origin its template asks for.
 *
 * Both halves have to agree or neither works: a dev server built with a router base of the proxy
 * prefix hangs on its loading spinner when it is loaded at a node port (measured, and it makes no
 * API calls at all), and one built with no prefix has every in-app link pointing at the root of
 * Rancher's origin when it is loaded through the proxy.
 *
 * Done at start rather than continuously, because both are read when the pod starts, and only
 * when something actually differs, so starting a workspace that is already right does not restart
 * it for nothing.
 */
/**
 * The dev server config a workspace boots with, brought up to date.
 *
 * Written on every start rather than only at create, for the reason the sidecar scripts are: the
 * file is this repo's, the workspace copies it in on boot, and a workspace made a week ago would
 * otherwise go on booting last week's copy for ever. It is not academic. The version that only
 * wrote it at create left a workspace crash-looping on `DEV_PROXY_PATH must be set` after the
 * config learned to do without one, because the pod had the old file and the new environment.
 */
async function ensureWorkspaceConfig(name: string): Promise<void> {
  const namespace = workspaceNamespace(name);
  const url = `${ BASE }/v1/configmaps/${ namespace }/${ WORKSPACE_CONFIG_MAP }`;
  const existing = await devFetch(url).catch(() => null);
  const data = { 'vue.config.js': WORKSPACE_VUE_CONFIG };

  // Created when it is not there, not skipped. A workspace whose ConfigMap has gone - deleted by
  // hand, or lost with a create that got part way - crash-loops on `cp: cannot stat
  // /dev-config/vue.config.js`, and the one function whose job is bringing a workspace up to
  // date was walking past the reason.
  if (!existing) {
    await devFetch(`${ BASE }/v1/configmaps`, {
      method: 'POST',
      body:   JSON.stringify({
        apiVersion: 'v1',
        kind:       'ConfigMap',
        metadata:   { namespace, name: WORKSPACE_CONFIG_MAP },
        data,
      }),
    }).catch(() => null);

    return;
  }

  if (existing.data?.['vue.config.js'] === WORKSPACE_VUE_CONFIG) {
    return;
  }

  await devFetch(url, { method: 'PUT', body: JSON.stringify({ ...existing, data }) });
}

/**
 * The terminal scripts, in the workspace's namespace and up to date.
 *
 * Rewritten on every start rather than created once, for the reason the dev server config is:
 * the scripts are this repo's, and a workspace made a week ago would otherwise go on running
 * last week's copy of them for ever.
 *
 * It fails quietly. A person whose Rancher session cannot read the barn namespace can
 * still start a workspace; what they get is a pod without the scripts, which is a terminal that
 * says claude is not installed rather than a workspace that will not boot.
 */
async function ensureWorkspaceTerminal(name: string): Promise<void> {
  const namespace = workspaceNamespace(name);
  const seed = await devFetch(`${ BASE }/v1/configmaps/${ SEED_NAMESPACE }/${ SEED_CONFIG_MAP }`).catch(() => null);
  const data: Record<string, string> = {};

  for (const file of TERMINAL_FILES) {
    if (seed?.data?.[file]) {
      data[file] = seed.data[file];
    }
  }

  // Nothing to write is not the same as writing nothing: an empty ConfigMap here would replace a
  // good copy with one that cannot open a terminal.
  if (!Object.keys(data).length) {
    return;
  }

  const url = `${ BASE }/v1/configmaps/${ namespace }/${ WORKSPACE_TERMINAL_MAP }`;
  const existing = await devFetch(url).catch(() => null);

  if (!existing) {
    await devFetch(`${ BASE }/v1/configmaps`, {
      method: 'POST',
      body:   JSON.stringify({
        apiVersion: 'v1',
        kind:       'ConfigMap',
        metadata:   { namespace, name: WORKSPACE_TERMINAL_MAP },
        data,
      }),
    }).catch(() => null);

    return;
  }

  if (TERMINAL_FILES.every((file) => existing.data?.[file] === data[file])) {
    return;
  }

  await devFetch(url, { method: 'PUT', body: JSON.stringify({ ...existing, data }) }).catch(() => null);
}

/**
 * Everything about a workspace that this product has since changed its mind about, applied.
 *
 * Called from both places a workspace's pod is about to start or restart, which is the only
 * moment any of it can take effect: starting the workspace, and starting the Rancher sidecar that
 * restarts it. Having it on only one of those is how starting a sidecar came to give somebody a
 * restarted workspace that was still in proxy mode with its dashboard calling the host.
 *
 * It reads and writes the Deployment itself rather than taking one, because its two callers reach
 * it from different directions, and it only writes when something is actually different, so a
 * workspace that is already right is not restarted for nothing.
 */
async function bringWorkspaceUpToDate(name: string, template: DevTemplate | undefined): Promise<void> {
  const namespace = workspaceNamespace(name);

  await ensureWorkspaceConfig(name);
  await ensureWorkspaceTerminal(name);
  await ensureWorkspaceService(name, template);

  // The address a conversation in this workspace posts what it learns to. Written on every start
  // for the same reason the rest of this function exists: the database is per person and outlives
  // any one workspace, so a workspace made before it existed has to be told about it.
  const insights = await insightsServiceUrl().catch(() => '');

  const url = `${ BASE }/v1/apps.deployments/${ namespace }/${ namespace }`;
  const deployment = await devFetch(url).catch(() => null);
  const container = deployment?.spec?.template?.spec?.containers?.[0];

  if (!container) {
    return;
  }

  let changed = false;

  // A workspace created before the mirror existed has no reference to it, so nothing in it ever
  // sees a secret however many times the mirror is rewritten.
  if (!container.envFrom) {
    container.envFrom = [{ secretRef: { name: MIRROR_SECRET, optional: true } }];
    changed = true;
  }

  // Not from the template: which database this is depends on who is looking, which a template
  // cannot know. `INSIGHTS_URL` is the name the harness's own agents already use.
  if (insights) {
    const entry = (container.env || []).find((candidate: Json) => candidate.name === 'INSIGHTS_URL');

    if (!entry) {
      container.env = [...(container.env || []), { name: 'INSIGHTS_URL', value: insights }];
      changed = true;
    } else if (entry.value !== insights) {
      entry.value = insights;
      changed = true;
    }
  }

  // The environment its template describes today, which is where the API address lives.
  for (const [envName, value] of Object.entries(template?.env || {})) {
    const wanted = substituteTemplateEnv(value, name, template!);
    const entry = (container.env || []).find((candidate: Json) => candidate.name === envName);

    if (entry && entry.value !== wanted) {
      entry.value = wanted;
      changed = true;
    }
  }

  // The image and the command its template describes today, together and never one without the
  // other. What a workspace runs is the template's, and a workspace made before the template
  // learned to install claude would otherwise never learn it.
  //
  // Together is the part that is not a tidiness: they are one decision. The version that brought
  // the command up to date and left the image alone put node's setpriv arguments in front of a
  // busybox that has a different setpriv, and the workspace crash-looped printing that applet's
  // usage. A container's command only means anything in the image it was written for.
  if (template?.image && container.image !== template.image) {
    container.image = template.image;
    changed = true;
  }

  if (template?.command && JSON.stringify(container.command) !== JSON.stringify(template.command)) {
    container.command = template.command;
    changed = true;
  }

  // The terminal scripts, for a workspace whose Deployment predates them. Without the volume the
  // ConfigMap this just wrote is in the namespace and reaches nothing.
  const pod = deployment.spec.template.spec;

  if (!(pod.volumes || []).some((volume: Json) => volume.name === 'terminal')) {
    pod.volumes = [...(pod.volumes || []), {
      name: 'terminal', configMap: { name: WORKSPACE_TERMINAL_MAP, defaultMode: 0o555, optional: true }
    }];
    container.volumeMounts = [...(container.volumeMounts || []), {
      name: 'terminal', mountPath: WORKSPACE_TERMINAL_MOUNT, readOnly: true
    }];
    changed = true;
  }

  if (changed) {
    await devFetch(url, { method: 'PUT', body: JSON.stringify(deployment) });
  }
}

/**
 * The workspace's Service: present, and of the type its template needs.
 *
 * Created here as well as at create time, because a create that failed after the namespace left a
 * workspace permanently without one and nothing ever put it back.
 */
async function ensureWorkspaceService(name: string, template: DevTemplate | undefined): Promise<void> {
  if (!template) {
    return;
  }

  const namespace = workspaceNamespace(name);
  const url = `${ BASE }/v1/services/${ namespace }/${ namespace }`;
  const service = await devFetch(url).catch(() => null);

  if (!service) {
    await devFetch(`${ BASE }/v1/services`, {
      method: 'POST',
      body:   JSON.stringify(workspaceServiceBody(name, template)),
    }).catch(() => null);

    return;
  }

  if (template.ownOrigin && service.spec?.type !== 'NodePort') {
    service.spec.type = 'NodePort';
    await devFetch(url, { method: 'PUT', body: JSON.stringify(service) });
  }
}

/**
 * Where a workspace answers inside the cluster, which is an origin of its own without a node port.
 *
 * The node port exists so that a person's own browser can reach a workspace at an origin that is
 * not Rancher's. A browser that is itself in the cluster does not need one: the Service is already
 * an origin of its own from in there, and it is one nothing outside the cluster can reach. So this
 * is what the browser sidecar is pointed at, and it is why that sidecar makes a workspace usable
 * without publishing anything.
 */
export function workspaceServiceUrl(name: string, template: DevTemplate): string {
  const namespace = workspaceNamespace(name);

  return `${ workspaceScheme(template) }://${ namespace }.${ namespace }.svc:${ template.port }/`;
}

/**
 * What a workspace's own port actually speaks, which is not what the template's `scheme` says.
 *
 * `scheme` is the proxy's half of the arrangement and stays http on purpose: Rancher terminates
 * the TLS and will not talk to the shell's self-signed dev certificate on the way through. At its
 * own origin there is no proxy in the way and the same dev server serves https instead (see
 * workspace-config.ts, which explains why: on http the session cookie Rancher issues is dropped).
 *
 * One function because two callers got this wrong in the same direction. The Ports tab asked the
 * proxy over http whether an own-origin workspace was answering, got the proxy's own failure back,
 * and printed "Nothing yet" beside a workspace that was serving.
 */
export function workspaceScheme(template: DevTemplate | undefined): string {
  return template?.ownOrigin ? 'https' : (template?.scheme || 'http');
}

/**
 * The address a published port answers on, which is the node's own.
 *
 * This used to be `window.location.hostname`, on the argument that the browser had just reached
 * Rancher at it so it could reach a node port at it too. That argument is wrong the moment the
 * two are not the same machine, and here they never are: Rancher is reached at a name that
 * resolves on its own network and nowhere else, so every published port this product offered was
 * a link that only worked from inside. What a node port is *for* is being reachable from outside,
 * so the address has to be the node's.
 *
 * ExternalIP first and InternalIP after it, which is the order kubectl's own `-o wide` uses: a
 * cloud node has both and only the first is routable from off the cluster, and a bare-metal or
 * dev node has only the second, which is still the best address there is. Any node's will do,
 * because a NodePort is opened on every node, so this does not need to know which one the pod
 * landed on.
 *
 * Cached for the life of the page. Node addresses do not change, and this is asked once per row
 * of the Ports tab.
 */
let nodeAddressPromise: Promise<string> | null = null;

export function nodeAddress(): Promise<string> {
  nodeAddressPromise = nodeAddressPromise || (async() => {
    const nodes = await devFetch(`${ BASE }/v1/nodes`).catch(() => null);
    const addresses = (nodes?.data || []).flatMap((node: Json) => node.status?.addresses || []);
    const of = (type: string) => addresses.find((entry: Json) => entry.type === type)?.address;

    // The page's own host is the last resort rather than the first. It is wrong, but a row with
    // no address at all is worse, and this is the case where the person cannot read the nodes.
    return of('ExternalIP') || of('InternalIP') || window.location.hostname;
  })();

  return nodeAddressPromise;
}

/**
 * Where a workspace is reachable when its template asked for an origin of its own.
 *
 * The host is passed in rather than awaited here, because the two callers are tables and a table
 * cell cannot await: they resolve nodeAddress() once when they refresh and hand it to every row.
 *
 * https, on the dev server's own self-signed certificate. See workspace-config.ts: over http the
 * session cookie Rancher issues is dropped and the login silently fails.
 */
export function workspaceOriginUrl(service: DevService | null, host: string): string {
  if (!service?.nodePort || !host) {
    return '';
  }

  return `https://${ host }:${ service.nodePort }/`;
}

/**
 * Delete the namespace, which takes the Deployment, the Service and the pod with it.
 *
 * The one thing the namespace does not take is the RoleBinding that let this workspace read the
 * shared credentials, since that lives in the product's own namespace. It is deleted here so a
 * deleted workspace leaves nothing behind that names it.
 */
export async function deleteWorkspace(name: string): Promise<void> {
  const namespace = workspaceNamespace(name);
  const binding = `creds-${ WORKSPACE_SERVICE_ACCOUNT }-${ namespace }`;

  await devFetch(`${ BASE }/v1/namespaces/${ namespace }`, { method: 'DELETE' });
  await devFetch(`${ BASE }/v1/rbac.authorization.k8s.io.rolebindings/${ DEV_SYSTEM_NAMESPACE }/${ binding }`, { method: 'DELETE' }).catch(() => null);
}

/**
 * A running pod in a namespace carrying all of the given labels, or null while there isn't
 * one.
 *
 * A terminal needs a pod by name because exec is a subresource of the pod, not of the
 * Deployment or the Service. `Running` is the bar rather than `Ready`: a pod that is up but
 * failing its probes is exactly the one someone wants a shell in, and the pod this dashboard
 * is served from is not Ready until it has finished compiling, which is minutes.
 *
 * Steve ignores labelSelector (see WORKSPACE_FILTER), so the matching is done here.
 */
export async function findPod(namespace: string, labels: Record<string, string>, own?: string): Promise<string | null> {
  const pods = await devFetch(`${ BASE }/v1/pods/${ namespace }`).catch(() => null);

  const running = (pods?.data || []).find((pod: Json) => (
    Object.entries(labels).every(([key, value]) => pod.metadata?.labels?.[key] === value) &&
    // A workspace's sidecars are in its namespace and carry its label, so without this a terminal
    // could open in whichever of them the collection happened to list first.
    (!own || ownedByWorkspace(pod, own)) &&
    pod.status?.phase === 'Running' &&
    !pod.metadata?.deletionTimestamp
  ));

  return running?.metadata?.name || null;
}

/** The pod running a workspace itself, or null while there isn't one. */
export function workspacePod(name: string): Promise<string | null> {
  return findPod(workspaceNamespace(name), { [LABEL_WORKSPACE]: name }, name);
}

/**
 * How long each workspace took to become ready, and how often it has restarted.
 *
 * The Deployment records when it last became Available, and the namespace records when the
 * workspace was created, so the difference is the boot this cluster actually delivered. It is
 * the Deployment's own history rather than anything kept here, which is why it survives this
 * page never having been open before.
 */
export async function workspaceReadyTimes(names: string[]): Promise<Record<string, { seconds: number | null; restarts: number }>> {
  if (!names.length) {
    return {};
  }

  const [namespaces, deployments, pods] = await Promise.all([
    devFetch(`${ BASE }/v1/namespaces?${ WORKSPACE_FILTER }`).catch(() => null),
    devFetch(`${ BASE }/v1/apps.deployments?${ WORKSPACE_FILTER }`).catch(() => null),
    devFetch(`${ BASE }/v1/pods?${ WORKSPACE_FILTER }`).catch(() => null),
  ]);

  const createdAt: Record<string, number> = {};
  const out: Record<string, { seconds: number | null; restarts: number }> = {};

  for (const namespace of namespaces?.data || []) {
    const name = namespace.metadata?.labels?.[LABEL_WORKSPACE];

    if (name) {
      createdAt[name] = Date.parse(namespace.metadata.creationTimestamp);
    }
  }

  for (const name of names) {
    out[name] = { seconds: null, restarts: 0 };
  }

  for (const deployment of deployments?.data || []) {
    const name = deployment.metadata?.labels?.[LABEL_WORKSPACE];

    // The workspace's own Deployment, not a sidecar's. See ownedByWorkspace.
    if (!name || !ownedByWorkspace(deployment, name)) {
      continue;
    }

    const available = (deployment.status?.conditions || [])
      .find((condition: Json) => condition.type === 'Available' && condition.status === 'True');

    if (name && available && createdAt[name]) {
      const seconds = Math.round((Date.parse(available.lastTransitionTime) - createdAt[name]) / 1000);

      // A workspace that was stopped and started again transitions to Available a second time,
      // which is not a boot from nothing. Only a positive, plausible first interval is kept.
      out[name] = { ...out[name], seconds: seconds > 0 ? seconds : null };
    }
  }

  for (const pod of pods?.data || []) {
    const name = pod.metadata?.labels?.[LABEL_WORKSPACE];
    const restarts = pod.status?.containerStatuses?.[0]?.restartCount || 0;

    if (name && ownedByWorkspace(pod, name) && out[name]) {
      out[name] = { ...out[name], restarts };
    }
  }

  return out;
}

/** Warnings from the workspaces' namespaces, newest first. */
export async function workspaceEvents(names: string[]): Promise<Json[]> {
  const results = await Promise.all(names.map((name) => (
    devFetch(`${ BASE }/v1/events/${ workspaceNamespace(name) }`)
      .then((events: Json) => ({ name, events }))
      .catch(() => ({ name, events: { data: [] } }))
  )));

  const out: Json[] = [];

  for (const { name, events } of results) {
    for (const event of events.data || []) {
      // `_type`, not `type`. Steve puts its own schema id in `type` on everything it returns
      // (here, the string "event") and moves the Kubernetes value out to `_type`, so a filter
      // written against `type` matches nothing and the page reports that nothing has gone wrong.
      if (event._type !== 'Warning') {
        continue;
      }

      out.push({
        id:        event.id || `${ name }-${ event.metadata?.name }`,
        workspace: name,
        reason:    event.reason,
        message:   event.message,
        count:     event.count || 1,
        last:      event.lastTimestamp || event.metadata?.creationTimestamp,
      });
    }
  }

  return out.sort((a, b) => Date.parse(b.last) - Date.parse(a.last));
}

/**
 * The last line the workspace's container printed, or '' if there is nothing to read.
 *
 * Asked for only while a workspace is starting, and only by the page that is showing one, since
 * this is the pod's log rather than a summary and a list of them would be a request per row. It
 * is the difference between "Starting up" and knowing it is four minutes into a yarn install.
 */
export async function workspaceLogTail(name: string, pod: string): Promise<string> {
  return podLogTail(workspaceNamespace(name), pod, WORKSPACE_CONTAINER);
}

/**
 * The last line a container printed, or '' if there is nothing to read.
 *
 * Not through devFetch: this is the apiserver's log subresource, which answers text rather than
 * JSON, and a 404 from it (a pod that has just gone) is an ordinary answer rather than an error.
 */
export async function podLogTail(namespace: string, pod: string, container: string): Promise<string> {
  const url = `${ BASE }/api/v1/namespaces/${ namespace }/pods/${ pod }/log?container=${ container }&tailLines=1&timestamps=false`;

  try {
    const resp = await fetch(url, { cache: 'no-store' });

    if (!resp.ok) {
      return '';
    }

    return (await resp.text()).trim().split('\n').pop() || '';
  } catch {
    return '';
  }
}

/**
 * A workspace's Service, or null if it has none.
 *
 * Fetched on its own rather than folded into listWorkspaces, because the list has no column
 * for it and the detail page is already fetching the pod. The alternative, describing the
 * Service from the template, is how the detail page came to report a port nothing was
 * listening on.
 */
export async function workspaceService(name: string): Promise<DevService | null> {
  const namespace = workspaceNamespace(name);
  // The namespace's collection rather than the one Service by name, so a workspace that has
  // none (a create that failed after the namespace) answers 200 with nothing in it. Asked
  // for by name it would answer 404, and the detail page asks every five seconds.
  const services = await devFetch(`${ BASE }/v1/services/${ namespace }`).catch(() => null);
  const service = (services?.data || []).find((svc: Json) => svc.metadata?.name === namespace);

  if (!service) {
    return null;
  }

  return {
    name:     service.metadata?.name,
    port:     service.spec?.ports?.[0]?.port,
    nodePort: service.spec?.ports?.[0]?.nodePort || 0,
  };
}

/**
 * The identities the terminals run as, and the one thing they share.
 *
 * Two ServiceAccounts, deliberately, rather than one that can do everything:
 *
 *   - the global terminal is the product's own tooling. It genuinely needs to see the cluster:
 *     list workspaces, read their pods and logs, and get a shell inside one. It is bound to a
 *     ClusterRole scoped to exactly that and no further, so it is refused secrets, nodes and
 *     RBAC itself.
 *   - a workspace pod runs whatever a template or a person put in it, which is not the product's
 *     code and should not carry the product's rights. It gets its own namespace and nothing
 *     else.
 *
 * The temptation is one cluster-admin token mounted everywhere, because it is one object and it
 * always works. It is also the kind of thing that is only ever noticed later, from the outside.
 *
 * What both sides do share is the claude login, as one Secret in a namespace of this product's
 * own. Each side reaches it through a RoleBinding naming that one Secret by name, rather than by
 * the extension copying the Secret into every workspace: a copy goes stale the moment the token
 * refreshes, and a stale copy of a credential is worse than no copy, because nothing looks
 * wrong until it stops working.
 */
export const DEV_SYSTEM_NAMESPACE = 'dev-system';
export const CREDENTIALS_SECRET = 'claude-credentials';
export const CREDENTIALS_KEY = 'credentials.json';
/** The hand-made Secret the store replaced. Only the migration that folds it in still names it. */
export const GITHUB_SECRET = 'github-token';

/**
 * How a template's own secrets are namespaced inside the one store.
 *
 * The key carries its scope, so one flat Secret holds both kinds without a nested format that
 * has to be parsed: `GH_TOKEN` is global, `rancher.FIGMA_API_KEY` belongs to the rancher
 * template. The prefix is the template's own id rather than a constant, or a second template's
 * key of the same name would be the first one's.
 */
export function templateSecretKey(templateId: string, key: string): string {
  return `${ templateId }.${ key }`;
}

/**
 * Where a workspace and its sidecars read the keys they were given, in their own namespace.
 *
 * Named for the workspace rather than for sidecars because both use it now: a secretKeyRef can
 * only name a Secret in the pod's own namespace, so one mirror per workspace serves everything
 * running in it.
 */
const MIRROR_SECRET = 'dev-secrets';

/** The dev server config a workspace boots with, in the workspace's own namespace. */
const WORKSPACE_CONFIG_MAP = 'dev-workspace-config';

/**
 * The terminal scripts a workspace's pod runs, in the workspace's own namespace.
 *
 * They are not written here and they are not a second copy of anything. The dev server pod is
 * seeded with them by the barn extension (`dev-extension.ts`), into a ConfigMap in that
 * extension's namespace, and this copies the terminal half of that ConfigMap into each
 * workspace. A workspace cannot mount the original: a ConfigMap volume only reaches pods in its
 * own namespace, which is exactly the reason a workspace's Conversations tab was a bare shell
 * for as long as it was.
 *
 * Copying rather than re-deriving keeps one source of truth. Edit `dev-extension/pod/*`, run
 * `gen-dev-extension-seed.mjs` and `apply-dev-extension-seed.mjs`, and every workspace picks the
 * new version up on its next start, the same way the dev pod's own tabs do.
 */
const WORKSPACE_TERMINAL_MAP = 'dev-terminal';
const WORKSPACE_TERMINAL_MOUNT = '/seed';


/**
 * Where the originals live: this pod's own seed ConfigMap.
 *
 * Not a constant, because there is one of these per named extension and this dashboard has to
 * copy from the one it was itself seeded from. Both come from the URL it is served at - see
 * DEV_POD_SERVICE in config/constants.
 */
const SEED_NAMESPACE = POD_NAMESPACE;
const SEED_CONFIG_MAP = POD_SERVICE;

/**
 * The keys to copy, named rather than filtered.
 *
 * The seed also carries the whole dev-extension source tree (flattened, `pkg__dev-extension__…`),
 * which is hundreds of kilobytes and has nothing to do with running a terminal. A ConfigMap is
 * capped at a megabyte, so "copy everything" is not a smaller decision than this list.
 */
const TERMINAL_FILES = [
  'shell.sh', 'terminal-tools.sh', 'claude-session.sh', 'claude-credentials.mjs',
  'claude-defaults.mjs', 'tmux.conf', 'session-claude.md',
];

/** Where the dev server's pod lives, which is the pod the global terminals attach to. */
const DEV_POD_NAMESPACE = POD_NAMESPACE;
export const GLOBAL_SERVICE_ACCOUNT = 'dev-global-terminal';

/** The ServiceAccount every workspace pod runs as, one per workspace namespace. */
export const WORKSPACE_SERVICE_ACCOUNT = 'dev-workspace';

/** Create if it is not there; leave it alone if it is. */
async function ensure(type: string, namespace: string | null, name: string, body: Json): Promise<void> {
  const path = namespace ? `${ BASE }/v1/${ type }/${ namespace }/${ name }` : `${ BASE }/v1/${ type }/${ name }`;
  const existing = await devFetch(path).catch(() => null);

  if (existing) {
    return;
  }

  await devFetch(`${ BASE }/v1/${ type }`, { method: 'POST', body: JSON.stringify(body) }).catch(() => null);
}

/**
 * Let one ServiceAccount read and write the shared credentials Secret, and nothing else in that
 * namespace.
 *
 * `resourceNames` is what keeps this to the one Secret: without it this would be read access to
 * every Secret in the namespace, which today is the same thing and tomorrow is not.
 */
function credentialsRoleBinding(name: string, namespace: string): Json {
  return {
    apiVersion: 'rbac.authorization.k8s.io/v1',
    kind:       'RoleBinding',
    metadata:   { namespace: DEV_SYSTEM_NAMESPACE, name: `creds-${ name }-${ namespace }` },
    roleRef:    {
      apiGroup: 'rbac.authorization.k8s.io', kind: 'Role', name: CREDENTIALS_SECRET
    },
    subjects: [{ kind: 'ServiceAccount', name, namespace }],
  };
}

/**
 * The ServiceAccounts, roles and bindings the terminals need.
 *
 * Idempotent and create-if-missing, the way everything else this extension puts in the cluster
 * is, and it swallows its own failures: it runs for every user on every load, including ones
 * with no rights to create RBAC, and an extension that throws here would take the product down
 * for them.
 */
export async function ensureDevRbac(): Promise<void> {
  await ensure('namespaces', null, DEV_SYSTEM_NAMESPACE, {
    apiVersion: 'v1',
    kind:       'Namespace',
    metadata:   { name: DEV_SYSTEM_NAMESPACE },
  });

  // Created empty, and only ever written by a pod pushing a token it already had. It exists up
  // front so that the Role below can name it, which is what lets the Role be about one Secret
  // rather than about all of them.
  await ensure('secrets', DEV_SYSTEM_NAMESPACE, CREDENTIALS_SECRET, {
    apiVersion: 'v1',
    kind:       'Secret',
    metadata:   { namespace: DEV_SYSTEM_NAMESPACE, name: CREDENTIALS_SECRET },
    type:       'Opaque',
  });

  // Nothing ensures the old `github-token` Secret any more. It is what the store replaced, and
  // an extension that recreated it on load would put an empty one back the moment the migration
  // deleted it, leaving two places a GitHub token could live for ever.

  await ensure('rbac.authorization.k8s.io.roles', DEV_SYSTEM_NAMESPACE, CREDENTIALS_SECRET, {
    apiVersion: 'rbac.authorization.k8s.io/v1',
    kind:       'Role',
    metadata:   { namespace: DEV_SYSTEM_NAMESPACE, name: CREDENTIALS_SECRET },
    rules:      [{
      apiGroups:     [''],
      resources:     ['secrets'],
      resourceNames: [CREDENTIALS_SECRET],
      verbs:         ['get', 'update', 'patch'],
    }],
  });

  await ensure('serviceaccounts', DEV_POD_NAMESPACE, GLOBAL_SERVICE_ACCOUNT, {
    apiVersion: 'v1',
    kind:       'ServiceAccount',
    metadata:   { namespace: DEV_POD_NAMESPACE, name: GLOBAL_SERVICE_ACCOUNT },
  });

  await ensure('rbac.authorization.k8s.io.clusterroles', null, GLOBAL_SERVICE_ACCOUNT, {
    apiVersion: 'rbac.authorization.k8s.io/v1',
    kind:       'ClusterRole',
    metadata:   { name: GLOBAL_SERVICE_ACCOUNT },
    rules:      [
      // Workspaces are namespaces, so creating and deleting one is creating and deleting a
      // namespace. This is the widest rule here and it is the product's actual job.
      {
        apiGroups: [''], resources: ['namespaces'], verbs: ['get', 'list', 'watch', 'create', 'delete']
      },
      {
        apiGroups: ['apps'],
        resources: ['deployments', 'deployments/scale', 'replicasets'],
        verbs:     ['get', 'list', 'watch', 'create', 'update', 'patch', 'delete'],
      },
      {
        apiGroups: [''],
        resources: ['services', 'configmaps', 'serviceaccounts'],
        verbs:     ['get', 'list', 'watch', 'create', 'update', 'patch', 'delete'],
      },
      {
        apiGroups: [''], resources: ['pods', 'pods/log', 'events'], verbs: ['get', 'list', 'watch']
      },
      // A shell in a workspace, which is a create on the pod's exec subresource rather than
      // anything that reads like "exec".
      {
        apiGroups: [''], resources: ['pods/exec'], verbs: ['create', 'get']
      },
    ],
  });

  await ensure('rbac.authorization.k8s.io.clusterrolebindings', null, GLOBAL_SERVICE_ACCOUNT, {
    apiVersion: 'rbac.authorization.k8s.io/v1',
    kind:       'ClusterRoleBinding',
    metadata:   { name: GLOBAL_SERVICE_ACCOUNT },
    roleRef:    {
      apiGroup: 'rbac.authorization.k8s.io', kind: 'ClusterRole', name: GLOBAL_SERVICE_ACCOUNT
    },
    subjects: [{ kind: 'ServiceAccount', name: GLOBAL_SERVICE_ACCOUNT, namespace: DEV_POD_NAMESPACE }],
  });

  const binding = credentialsRoleBinding(GLOBAL_SERVICE_ACCOUNT, DEV_POD_NAMESPACE);

  await ensure('rbac.authorization.k8s.io.rolebindings', DEV_SYSTEM_NAMESPACE, binding.metadata.name, binding);
}

/**
 * The ServiceAccount a workspace's pod runs as: its own namespace, and the shared login.
 *
 * Created with the workspace rather than by ensureDevRbac, because it is per workspace and the
 * namespace it lives in does not exist until the workspace does.
 */
async function ensureWorkspaceRbac(name: string): Promise<void> {
  const namespace = workspaceNamespace(name);

  await ensure('serviceaccounts', namespace, WORKSPACE_SERVICE_ACCOUNT, {
    apiVersion: 'v1',
    kind:       'ServiceAccount',
    metadata:   { namespace, name: WORKSPACE_SERVICE_ACCOUNT },
  });

  // Whatever the workspace runs can manage the workspace's own namespace. It is a sandbox, and
  // this is the edge of it: `edit` is Kubernetes' own aggregated role for exactly this, so the
  // rules do not have to be maintained here as the API grows.
  await ensure('rbac.authorization.k8s.io.rolebindings', namespace, WORKSPACE_SERVICE_ACCOUNT, {
    apiVersion: 'rbac.authorization.k8s.io/v1',
    kind:       'RoleBinding',
    metadata:   { namespace, name: WORKSPACE_SERVICE_ACCOUNT },
    roleRef:    {
      apiGroup: 'rbac.authorization.k8s.io', kind: 'ClusterRole', name: 'edit'
    },
    subjects: [{ kind: 'ServiceAccount', name: WORKSPACE_SERVICE_ACCOUNT, namespace }],
  });

  const binding = credentialsRoleBinding(WORKSPACE_SERVICE_ACCOUNT, namespace);

  await ensure('rbac.authorization.k8s.io.rolebindings', DEV_SYSTEM_NAMESPACE, binding.metadata.name, binding);
}

/**
 * base64 of the UTF-8 bytes, which is what a Kubernetes Secret holds.
 *
 * `btoa` is defined over Latin-1 and throws a DOMException on anything outside it, so a pasted
 * token or a password with one non-Latin1 character in it would take the whole Save with it, and
 * the error it throws says nothing about which field caused it.
 */
function encodeSecret(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary);
}

function decodeSecret(value: string): string {
  const binary = atob(value);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));

  return new TextDecoder().decode(bytes);
}

/**
 * A Secret's data, decoded, or null when it is not there or cannot be read.
 *
 * Through Steve on the browser's own session, so what comes back is what this user is allowed
 * to see. Nothing here returns a token to anywhere it could be displayed: the callers take the
 * one field they need and the pages show identities rather than credentials.
 */
async function readSecret(name: string): Promise<Record<string, string> | null> {
  const secret = await devFetch(`${ BASE }/v1/secrets/${ DEV_SYSTEM_NAMESPACE }/${ name }`).catch(() => null);

  if (!secret) {
    return null;
  }

  const out: Record<string, string> = {};

  for (const [key, value] of Object.entries(secret.data || {})) {
    out[key] = value ? decodeSecret(value as string) : '';
  }

  return out;
}

/**
 * The GitHub token, for the caller to send. Never rendered and never logged.
 *
 * Out of the one store rather than the hand-made `github-token` Secret that used to hold it: the
 * migration folded that one in as `GH_TOKEN` and deleted it, so there is one place a secret
 * lives. See migrateGithubToken.
 */
export async function githubToken(): Promise<string> {
  return secretValue('GH_TOKEN');
}

/** What the shared claude login is, without the tokens: enough to say whose it is. */
export interface ClaudeIdentity {
  subscriptionType: string;
  expiresAt: number;
  scopes: string[];
}

export async function claudeIdentity(): Promise<ClaudeIdentity | null> {
  const data = await readSecret(CREDENTIALS_SECRET);

  if (!data?.[CREDENTIALS_KEY]) {
    return null;
  }

  try {
    const oauth = JSON.parse(data[CREDENTIALS_KEY])?.claudeAiOauth;

    if (!oauth?.accessToken) {
      return null;
    }

    return {
      subscriptionType: oauth.subscriptionType || 'unknown',
      expiresAt:        Number(oauth.expiresAt) || 0,
      scopes:           oauth.scopes || [],
    };
  } catch {
    return null;
  }
}

/**
 * Whether the dev server's pod is running as the ServiceAccount the global terminals need.
 *
 * A pod takes its ServiceAccount at start, so setting one on the Deployment restarts the pod,
 * and that pod is the one someone has a terminal in. So the extension does not do it: this
 * reports the state and Settings offers it as something to do deliberately.
 */
export async function devPodServiceAccount(): Promise<{ current: string; wanted: string }> {
  const deployment = await devFetch(`${ BASE }/v1/apps.deployments/${ DEV_POD_NAMESPACE }/${ POD_SERVICE }`).catch(() => null);

  return {
    current: deployment?.spec?.template?.spec?.serviceAccountName || 'default',
    wanted:  GLOBAL_SERVICE_ACCOUNT,
  };
}

/**
 * Put the global terminal's ServiceAccount on the dev server's Deployment.
 *
 * This restarts the pod, which is why nothing calls it on its own. Everything in the pod's
 * `/app` survives (it is a volume), but a tmux session does not, and neither does an install
 * that is part way through.
 */
export async function setDevPodServiceAccount(): Promise<void> {
  const url = `${ BASE }/v1/apps.deployments/${ DEV_POD_NAMESPACE }/${ POD_SERVICE }`;
  const deployment = await devFetch(url);

  deployment.spec.template.spec.serviceAccountName = GLOBAL_SERVICE_ACCOUNT;

  await devFetch(url, { method: 'PUT', body: JSON.stringify(deployment) });
}

/**
 * The one Secret this extension keeps, per user.
 *
 * Named and labelled with the owning Rancher user, following the secret sets in the
 * barn extension (listSecretSets and friends), which already solved this: the principal
 * comes from /v3/users?me=true, is sanitised to something a Kubernetes name accepts, and goes in
 * the name and in a label. Per-user costs the same to write as shared and cannot be retrofitted
 * without migrating whatever a shared one has accumulated, so it is per-user from the start,
 * with one user in this cluster today.
 *
 * Keys are flat and carry their own scope: `GH_TOKEN` is global, `rancher.FIGMA_API_KEY`
 * belongs to the rancher template. One Secret holds both without a nested format to parse.
 */
const SECRET_KIND_LABEL = 'dev.rancher.io/kind';
const SECRET_OWNER_LABEL = 'dev.rancher.io/owner';

let secretOwner = '';

/**
 * A principal id, as something a Secret can actually be named after.
 *
 * A Secret name is an RFC 1123 subdomain: lowercase letters, digits, dashes and dots, starting
 * and ending on a letter or a digit. Underscore is not in that set, and it is not a theoretical
 * omission: every principal that is not a local user has one. `github_user://12345678` became
 * `dev-secrets-github_user---12345678`, which the apiserver rejects, so the save failed and every
 * key in Settings read "Not set" for anyone who had signed in through an auth provider. Which is
 * exactly the person the Keycloak and OpenLDAP sidecars exist for.
 *
 * The trim is after the truncation as well as before it, because a principal cut at forty
 * characters can land on a dash or a dot, and a name that ends in one is rejected too.
 */
function sanitiseOwner(value: string): string {
  const cleaned = (value || 'anonymous')
    .toLowerCase()
    .replace(/[^a-z0-9.-]/g, '-');
  const trim = (text: string) => text.replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '');

  if (cleaned.length <= MAX_OWNER_LENGTH) {
    return trim(cleaned) || 'anonymous';
  }

  // Long principals keep a fingerprint of the whole thing rather than only their first forty
  // characters. Active Directory principals are a distinguished name, so two people in the same
  // organisational unit agree for far longer than that: truncated, they become one Secret, and
  // the second person to save silently overwrites the first person's tokens and then reads them.
  // On exactly the providers the auth sidecars exist to make usable.
  const stem = cleaned.slice(0, MAX_OWNER_LENGTH - 9);

  return `${ trim(stem) }-${ fingerprint(value) }`;
}

/** Kubernetes' name limit is 63; this leaves room for the `dev-secrets-` the store prefixes. */
const MAX_OWNER_LENGTH = 40;

/**
 * A short, stable fingerprint of a string, as lowercase base 36.
 *
 * FNV-1a, because it needs to be synchronous (SubtleCrypto is not) and it is disambiguating
 * names rather than protecting anything. Eight characters of it is enough that two principals
 * sharing a forty character prefix do not also share this.
 */
function fingerprint(value: string): string {
  let hash = 0x811c9dc5;

  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }

  return hash.toString(36).padStart(7, '0').slice(0, 8);
}

/** Who is asking, from Rancher's own answer, cached for the life of the page. */
export async function currentOwner(): Promise<string> {
  if (secretOwner) {
    return secretOwner;
  }

  const me = await devFetch('/v3/users?me=true').catch(() => null);
  const principal = me?.data?.[0]?.principalIds?.[0] || me?.data?.[0]?.id || '';

  secretOwner = sanitiseOwner(principal);

  return secretOwner;
}

async function secretStoreName(): Promise<string> {
  return `dev-secrets-${ await currentOwner() }`;
}

/** The store as it is, or an empty one. Values included, since the caller is the browser. */
async function readSecretStore(): Promise<Record<string, string>> {
  const name = await secretStoreName();
  const secret = await devFetch(`${ BASE }/v1/secrets/${ DEV_SYSTEM_NAMESPACE }/${ name }`).catch(() => null);
  const out: Record<string, string> = {};

  for (const [key, value] of Object.entries(secret?.data || {})) {
    out[key] = value ? decodeSecret(value as string) : '';
  }

  return out;
}

/**
 * Which keys are set, and nothing else.
 *
 * This is what Settings and the sidecar cards ask, because neither of them has any business
 * with the value: a stored secret is never rendered back, only replaced or cleared.
 */
export async function setSecretKeys(): Promise<string[]> {
  const store = await readSecretStore();

  return Object.entries(store).filter(([, value]) => !!value).map(([key]) => key);
}

/** One value, for the browser to use at the point of use. Never rendered, never logged. */
export async function secretValue(key: string): Promise<string> {
  return (await readSecretStore())[key] || '';
}

/**
 * Write only the keys that changed.
 *
 * A key whose field was left alone is not in `changes` and is not touched, which is what stops
 * opening Settings and saving from blanking a value nobody could see. A key set to '' is a
 * deliberate clear.
 */
export async function saveSecrets(changes: Record<string, string>): Promise<void> {
  if (!Object.keys(changes).length) {
    return;
  }

  const name = await secretStoreName();
  const url = `${ BASE }/v1/secrets/${ DEV_SYSTEM_NAMESPACE }/${ name }`;
  const existing = await devFetch(url).catch(() => null);
  const data: Record<string, string> = { ...(existing?.data || {}) };

  for (const [key, value] of Object.entries(changes)) {
    if (value === '') {
      delete data[key];
    } else {
      data[key] = encodeSecret(value);
    }
  }

  const body = {
    apiVersion: 'v1',
    kind:       'Secret',
    type:       'Opaque',
    metadata:   {
      namespace: DEV_SYSTEM_NAMESPACE,
      name,
      labels:    { [SECRET_KIND_LABEL]: 'secrets', [SECRET_OWNER_LABEL]: await currentOwner() },
    },
    data,
  };

  if (existing) {
    await devFetch(url, { method: 'PUT', body: JSON.stringify({ ...existing, data: body.data, metadata: { ...existing.metadata, labels: body.metadata.labels } }) });
  } else {
    await devFetch(`${ BASE }/v1/secrets`, { method: 'POST', body: JSON.stringify(body) });
  }
}

/**
 * A password nobody has to think of, made once and then kept.
 *
 * The chart does this with `randAlphaNum 15` and a `lookup` that reuses whatever the last install
 * generated, and the reason is the same here: an admin password written into the code as
 * `admin`/`admin` is a literal credential in the repo, and one regenerated on every start is one
 * nobody can write down. Alphanumeric only, because these end up typed into a login form.
 */
const GENERATED_ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

function generatedValue(length = 15): string {
  const bytes = new Uint8Array(length);

  window.crypto.getRandomValues(bytes);

  return [...bytes].map((byte) => GENERATED_ALPHABET[byte % GENERATED_ALPHABET.length]).join('');
}

/**
 * Fill in any declared secret the product generates for itself, once.
 *
 * Only the ones that are missing, so a password that has already been generated is the password
 * it stays, which is the property `lookup` gives the chart: something that has been used to log
 * in once goes on working.
 */
export async function ensureGeneratedSecrets(template: DevTemplate | undefined): Promise<Record<string, string>> {
  const declared = [
    ...GLOBAL_SECRETS.map((secret) => ({ secret, key: secret.key })),
    ...(template?.secrets || []).map((secret) => ({ secret, key: templateSecretKey(template!.id, secret.key) })),
  ].filter(({ secret }) => secret.generated);

  const store = await readSecretStore();

  if (!declared.length) {
    return store;
  }

  const changes: Record<string, string> = {};

  for (const { key } of declared) {
    if (!store[key]) {
      changes[key] = generatedValue();
    }
  }

  await saveSecrets(changes);

  // The store as it now is, returned rather than left to be read back.
  //
  // Reading it again is a read of something written a moment ago, and the very first write is a
  // create: Steve can answer that read from before it and hand back a store without the key just
  // generated. What follows is a mirror written without it, a pod started without it, a Rancher
  // installed with an empty password that therefore invents one of its own, and a bootstrap that
  // cannot log in. That is a great deal of consequence for a cache, and none of it happens if the
  // value is carried forward instead of asked for again.
  return { ...store, ...changes };
}

/**
 * Copy the keys this workspace is entitled to into the workspace's own namespace.
 *
 * A secretKeyRef can only name a Secret in the pod's own namespace, and the store is one Secret
 * per user in this product's namespace, so the values have to be mirrored. What a pod spec
 * carries either way is the reference, which is the property that matters: `kubectl get deploy
 * -o yaml` shows a name and a key rather than a token.
 *
 * Rewritten every time anything here is started, not only when the workspace is created. A key
 * set in Settings after the workspace was made would otherwise never reach it, and because the
 * references are `optional` the pod would come up without it and say nothing.
 *
 * The mirror lands in a namespace where the workspace's own ServiceAccount holds `edit`, so
 * anyone with a shell in the workspace can read these values. That is deliberate rather than
 * overlooked: they are that workspace's credentials, and the code they are for is what runs
 * there. A secret that must not be readable by the workspace does not belong in its template.
 */
async function mirrorSecrets(workspace: string, template: DevTemplate | undefined, known?: Record<string, string>): Promise<void> {
  const namespace = workspaceNamespace(workspace);
  // `known` is the store as the caller has just seen it, which is what stops a value generated
  // moments ago from being lost to a stale read. See ensureGeneratedSecrets.
  const store = known || await readSecretStore();
  const mirrored: Record<string, string> = {};

  // Only the template's own keys, never the global ones. A global secret is the person's rather
  // than the workspace's: section 9 has the browser read those through Steve at the point of use,
  // and mirroring GH_TOKEN into every workspace namespace put a personal GitHub token inside every
  // pod a template happened to run, in a namespace where the workspace account holds `edit`.
  //
  // The template's keys lose the template prefix on the way in, since inside the workspace there
  // is only one template and `rancher.FIGMA_API_KEY` is not a name an environment variable can
  // have.
  for (const secret of template?.secrets || []) {
    const value = store[templateSecretKey(template!.id, secret.key)];

    if (value) {
      mirrored[secret.key] = encodeSecret(value);
    }
  }

  const url = `${ BASE }/v1/secrets/${ namespace }/${ MIRROR_SECRET }`;
  const existing = await devFetch(url).catch(() => null);

  if (existing) {
    await devFetch(url, { method: 'PUT', body: JSON.stringify({ ...existing, data: mirrored }) });

    return;
  }

  await devFetch(`${ BASE }/v1/secrets`, {
    method: 'POST',
    body:   JSON.stringify({
      apiVersion: 'v1',
      kind:       'Secret',
      type:       'Opaque',
      metadata:   { namespace, name: MIRROR_SECRET, labels: { [LABEL_WORKSPACE]: workspace } },
      data:       mirrored,
    }),
  });
}

/**
 * Fold the hand-made github-token Secret into the store, once.
 *
 * It was injected by hand before there was a store. Moving it means there is one place a secret
 * lives rather than two, and the one-off is deleted so nothing reads the stale copy later.
 */
export async function migrateGithubToken(): Promise<void> {
  const legacy = await devFetch(`${ BASE }/v1/secrets/${ DEV_SYSTEM_NAMESPACE }/${ GITHUB_SECRET }`).catch(() => null);
  const token = legacy?.data?.token ? decodeSecret(legacy.data.token) : '';

  if (!token) {
    return;
  }

  const already = await secretValue('GH_TOKEN');

  if (already && already !== token) {
    // Two different tokens, and nothing here knows which one is wanted. Both are left where they
    // are: deleting the legacy one would destroy the only copy of a credential this code did not
    // put anywhere, on the strength of a guess.
    return;
  }

  if (!already) {
    await saveSecrets({ GH_TOKEN: token });
  }

  // Only now, when the value is certainly in the store, so a failed save cannot take the original
  // with it.
  await devFetch(`${ BASE }/v1/secrets/${ DEV_SYSTEM_NAMESPACE }/${ GITHUB_SECRET }`, { method: 'DELETE' }).catch(() => null);
}

/** A sidecar as it exists in the cluster, joined to what the template declared. */
export interface DevSidecarState {
  id: string;
  state: WorkspaceState;
  /** Keys the sidecar declared that are not in the secret store. */
  missing: string[];
  /**
   * What the cluster says about it, when there is something to say.
   *
   * The card showed Starting for every kind of failure before this existed, including the ones
   * where no pod is ever created and so nothing has a log to read. This is the pod's own reason
   * or the controller's, whichever there is.
   */
  detail: string;
  /** The last line it printed, while it is still starting. See listSidecars. */
  log: string;
}

function sidecarName(workspace: string, id: string): string {
  return `${ workspaceNamespace(workspace) }-${ id }`;
}

/** Every declared sidecar's state in one workspace, whether or not it has ever been started. */
export async function listSidecars(workspace: string, sidecars: DevSidecar[], template?: DevTemplate): Promise<Record<string, DevSidecarState>> {
  const namespace = workspaceNamespace(workspace);
  const [deployments, pods, keys] = await Promise.all([
    devFetch(`${ BASE }/v1/apps.deployments/${ namespace }`).catch(() => null),
    devFetch(`${ BASE }/v1/pods/${ namespace }`).catch(() => null),
    setSecretKeys().catch(() => [] as string[]),
  ]);

  const out: Record<string, DevSidecarState> = {};

  for (const sidecar of sidecars) {
    const name = sidecarName(workspace, sidecar.id);
    const deployment = (deployments?.data || []).find((candidate: Json) => candidate.metadata?.name === name);
    const pod = (pods?.data || []).find((candidate: Json) => candidate.metadata?.labels?.[LABEL_SIDECAR] === sidecar.id);

    const state = deployment ? stateOf({ metadata: {} }, deployment, pod) : 'stopped';

    out[sidecar.id] = {
      id: sidecar.id,
      // A sidecar that has never been started has no Deployment, which is 'stopped' rather than
      // anything more dramatic: it is declared, and starting it is what creates it.
      state,
      missing: missingSecrets(sidecar, template, keys),
      detail:  podDetail(pod) || (pod ? '' : replicaFailure(deployment)),
      // Only while it is still coming up, and only for a sidecar that takes long enough for the
      // question to arise. Ten minutes of "Starting up" says nothing about which minute it is in,
      // and the manager's own log is a running account of it: which helm install, and how it went.
      log: state === 'starting' && pod && sidecar.readyPort
        ? await podLogTail(namespace, pod.metadata.name, 'sidecar')
        : '',
    };
  }

  return out;
}

/**
 * The keys this sidecar needs that the store does not have.
 *
 * The template is what says how a key is named in the store, so a sidecar declaring
 * `FIGMA_API_KEY` on the rancher template is asking about `rancher.FIGMA_API_KEY`. Without the
 * template there is no way to name the key, and answering "nothing is missing" would be a
 * guess, so the declaration is reported as missing instead.
 */
function missingSecrets(sidecar: DevSidecar, template: DevTemplate | undefined, keys: string[]): string[] {
  return (sidecar.secrets || []).filter((key) => {
    // A generated secret is never missing, whatever the store holds: starting the sidecar is what
    // creates it. Counting it as missing would disable the only control that could fill it in.
    if ((template?.secrets || []).find((secret) => secret.key === key)?.generated) {
      return false;
    }

    return !template || !keys.includes(templateSecretKey(template.id, key));
  });
}

/**
 * The Chromium extension the browser sidecar runs with, built for one workspace.
 *
 * Written on every start, like the terminal scripts and for the same reason: it carries this
 * workspace's own addresses and its own generated passwords, and both can change after the
 * sidecar was created. A Secret rather than a ConfigMap because of what is in it.
 */
const BROWSER_EXTENSION_SECRET = 'dev-browser-extension';
export const BROWSER_EXTENSION_MOUNT = '/extension';

async function ensureBrowserExtension(workspace: string, template: DevTemplate, store: Record<string, string>): Promise<void> {
  const namespace = workspaceNamespace(workspace);
  const rancher = (template.sidecars || []).find((sidecar) => sidecar.providesApi);

  // The pages the content scripts run on: this workspace's own Rancher, and the dashboard it
  // serves. Both are in-cluster addresses, so the extension is inert anywhere else, which is the
  // point - it carries passwords and it should not offer them to a page that merely looks like a
  // Rancher login.
  const matches = [
    rancher ? `${ sidecarServiceUrl(workspace, rancher) }/*` : '',
    `${ workspaceServiceUrl(workspace, template).replace(/\/$/, '') }/*`,
  ].filter(Boolean);

  // The accounts the workspace's own Rancher is bootstrapped with. admin is the generated
  // bootstrap password; user1 to user3 are the auth sidecars' shared one. See AUTH_SCRIPT.
  const admin = store[templateSecretKey(template.id, 'RANCHER_BOOTSTRAP_PASSWORD')] || '';
  const user = store[templateSecretKey(template.id, 'AUTH_USER_PASSWORD')] || '';
  const creds = [
    { label: 'Admin', username: 'admin', password: admin },
    ...[1, 2, 3].map((n) => ({ label: `User ${ n }`, username: `user${ n }`, password: user })),
  ].filter((entry) => !!entry.password);

  const data: Record<string, string> = {};

  for (const [file, body] of Object.entries(BROWSER_EXTENSION_FILES)) {
    data[file] = encodeSecret(body
      .replace('{{matches}}', matches.join('",\n        "'))
      .replace('{{creds}}', JSON.stringify(creds, null, 2)));
  }

  const url = `${ BASE }/v1/secrets/${ namespace }/${ BROWSER_EXTENSION_SECRET }`;
  const existing = await devFetch(url).catch(() => null);

  if (!existing) {
    await devFetch(`${ BASE }/v1/secrets`, {
      method: 'POST',
      body:   JSON.stringify({
        apiVersion: 'v1',
        kind:       'Secret',
        metadata:   { namespace, name: BROWSER_EXTENSION_SECRET },
        type:       'Opaque',
        data,
      }),
    }).catch(() => null);

    return;
  }

  await devFetch(url, { method: 'PUT', body: JSON.stringify({ ...existing, data }) }).catch(() => null);
}

/**
 * The values a workspace's sidecars have been configured with.
 *
 * One ConfigMap for all of them, keyed `<sidecar>.<param>`, because that is the shape the secret
 * store already uses for the same kind of question and because a ConfigMap per sidecar would be
 * five objects saying one thing each. Values only: what a parameter *is* lives in the template,
 * which is code, and a value with no declaration behind it is ignored.
 */
const SIDECAR_PARAMS_MAP = 'dev-sidecar-params';

export async function sidecarParams(workspace: string, sidecar: DevSidecar): Promise<Record<string, string>> {
  const namespace = workspaceNamespace(workspace);
  const config = await devFetch(`${ BASE }/v1/configmaps/${ namespace }/${ SIDECAR_PARAMS_MAP }`).catch(() => null);
  const out: Record<string, string> = {};

  for (const param of sidecar.params || []) {
    out[param.id] = config?.data?.[`${ sidecar.id }.${ param.id }`] ?? (param.default || '');
  }

  return out;
}

/**
 * Save what a sidecar is configured with.
 *
 * Applying it is the caller's next step, and that step is a restart: a container reads its
 * environment when it starts and at no other time.
 */
export async function setSidecarParams(workspace: string, sidecar: DevSidecar, values: Record<string, string>): Promise<void> {
  const namespace = workspaceNamespace(workspace);
  const url = `${ BASE }/v1/configmaps/${ namespace }/${ SIDECAR_PARAMS_MAP }`;
  const existing = await devFetch(url).catch(() => null);
  const data: Record<string, string> = { ...(existing?.data || {}) };

  for (const [id, value] of Object.entries(values)) {
    data[`${ sidecar.id }.${ id }`] = value;
  }

  if (!existing) {
    await devFetch(`${ BASE }/v1/configmaps`, {
      method: 'POST',
      body:   JSON.stringify({
        apiVersion: 'v1',
        kind:       'ConfigMap',
        metadata:   { namespace, name: SIDECAR_PARAMS_MAP },
        data,
      }),
    });

    return;
  }

  await devFetch(url, { method: 'PUT', body: JSON.stringify({ ...existing, data }) });
}

/**
 * The whole of a sidecar's log, for the card's log window.
 *
 * podLogTail next door answers a different question - what is it doing right now, in one line, on
 * a card - and takes the last line for it. This is what someone opens when that line was not
 * enough, so it is the last few hundred.
 */
export async function sidecarLog(workspace: string, sidecar: DevSidecar, lines = 500): Promise<string> {
  const namespace = workspaceNamespace(workspace);
  const pods = await devFetch(`${ BASE }/v1/pods/${ namespace }`).catch(() => null);
  const pod = (pods?.data || []).find((candidate: Json) => candidate.metadata?.labels?.[LABEL_SIDECAR] === sidecar.id);

  if (!pod) {
    return '';
  }

  // `timestamps` because a log line on its own says what happened and not when, and a sidecar
  // that takes ten minutes to install two helm charts is one where the gap between two lines is
  // the interesting part. The apiserver prefixes each line with an RFC3339 time; what to do with
  // that is the caller's.
  const url = `${ BASE }/api/v1/namespaces/${ namespace }/pods/${ pod.metadata.name }/log?container=sidecar&tailLines=${ lines }&timestamps=true`;

  // No Accept header, deliberately. The log subresource answers in plain text and negotiates
  // against a list that does not include it: asking for `text/plain` is a 406 saying "only the
  // following media types are accepted", and asking for JSON gets a log wrapped in nothing.
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`The log could not be read: ${ response.status }.`);
  }

  return response.text();
}

/**
 * The prompts this person's queued conversations open with.
 *
 * Per user and next to the secret store, for the same reason it is: two people using this
 * product have different ideas about what a review should say, and neither should be editing the
 * other's. Defaults are written in the first time they are asked for, so the page has something
 * to show and to edit rather than an empty box.
 */
async function promptsName(): Promise<string> {
  return `dev-prompts-${ await currentOwner() }`;
}

export async function listPrompts(): Promise<DevPrompt[]> {
  const name = await promptsName();
  const config = await devFetch(`${ BASE }/v1/configmaps/${ DEV_SYSTEM_NAMESPACE }/${ name }`).catch(() => null);

  // The declaration is what says which prompts exist and what they are for; the ConfigMap only
  // holds the text. So a prompt added to the code appears for everyone, with its default, and a
  // prompt removed from the code stops being offered even if someone's copy still has the text.
  return DEFAULT_PROMPTS.map((prompt) => ({
    ...prompt,
    text: config?.data?.[prompt.id] ?? prompt.text,
  }));
}

export async function savePrompts(texts: Record<string, string>): Promise<void> {
  const name = await promptsName();
  const url = `${ BASE }/v1/configmaps/${ DEV_SYSTEM_NAMESPACE }/${ name }`;
  const existing = await devFetch(url).catch(() => null);
  const data = { ...(existing?.data || {}), ...texts };

  if (!existing) {
    await devFetch(`${ BASE }/v1/configmaps`, {
      method: 'POST',
      body:   JSON.stringify({
        apiVersion: 'v1',
        kind:       'ConfigMap',
        metadata:   { namespace: DEV_SYSTEM_NAMESPACE, name },
        data,
      }),
    });

    return;
  }

  await devFetch(url, { method: 'PUT', body: JSON.stringify({ ...existing, data }) });
}

/**
 * Queue a conversation in a workspace: a prompt the next pane to open will start on.
 *
 * A file in the pod rather than a message to something, because there is nothing to send it to:
 * a conversation is a tmux session that may not exist yet, in a workspace that may still be
 * pulling. The file waits, and shell.sh hands it to claude when the pane starts, once. See
 * claude-session.sh.
 *
 * The text is base64 on the way in. It is somebody's prose, it will contain quotes and newlines,
 * and building a shell command out of it any other way is a quoting bug waiting for the first
 * apostrophe.
 */
export async function queueConversation(workspace: string, session: string | number, prompt: string): Promise<void> {
  const namespace = workspaceNamespace(workspace);
  const pod = await workspacePod(workspace);

  if (!pod) {
    throw new Error('This workspace has no pod yet, so there is nothing to queue a conversation in.');
  }

  const encoded = encodeSecret(prompt);
  const file = `${ WORKSPACE_QUEUE }/${ workspaceSession(session) }`;

  await podExecOnce(namespace, pod, WORKSPACE_CONTAINER, asWorkspaceUser(
    `mkdir -p ${ WORKSPACE_QUEUE } && echo ${ encoded } | base64 -d > ${ file }`,
  ));
}

/**
 * The workspace API: one service, for everything that is not a person.
 *
 * A page cannot be the only way to make a workspace. An action that has just been told to fix
 * something has no browser and no Rancher session, and it should not need either: see
 * WORKSPACE_API_SERVER, which is the service, and this, which puts it in the cluster.
 *
 * One for everybody rather than one each, because it is infrastructure rather than somebody's:
 * what it holds is the templates, and what it makes is a namespace. The rights that needs are
 * cluster-scoped, which is the reason it is a service at all and not something the page does.
 */
const API_NAME = 'dev-api';
const API_PORT = 8080;

/** Where the extension leaves the templates for it, so what a workspace runs is decided once. */
const API_TEMPLATES = 'dev-api-templates';

/** Where a pod reaches it, which is what an action inside a workspace is given. */
export function workspaceApiUrl(): string {
  return `http://${ API_NAME }.${ DEV_SYSTEM_NAMESPACE }.svc:${ API_PORT }`;
}

/**
 * The templates as data, which is what the service renders from.
 *
 * Published rather than reimplemented: the service makes the same Deployment the page does, from
 * the same declaration, so a template that changes here changes there. Only what it needs -
 * everything about a sidecar except its identity is the page's business.
 */
function publishedTemplates(): Record<string, Json> {
  const out: Record<string, Json> = {};

  for (const template of TEMPLATES) {
    out[template.id] = {
      label:      template.label,
      image:      template.image,
      command:    template.command,
      port:       template.port,
      scheme:     template.scheme,
      ownOrigin:  template.ownOrigin,
      hostPath:   template.hostPath,
      env:        template.env,
      sidecars:   (template.sidecars || []).map((sidecar) => ({
        id: sidecar.id, scheme: sidecar.scheme, providesApi: sidecar.providesApi,
      })),
      // The two ConfigMaps a workspace boots from, by name, so the service writes the same ones.
      configMaps: {
        [WORKSPACE_CONFIG_MAP]: { 'vue.config.js': WORKSPACE_VUE_CONFIG },
      },
    };
  }

  return out;
}

/**
 * Create the service if it is not there, and keep its script and its templates current.
 *
 * Quiet, like everything else this extension puts in the cluster: it runs on load for every user
 * including ones who cannot create any of it, and a page that threw here would be a page that
 * never rendered for them.
 */
export async function ensureWorkspaceApi(): Promise<void> {
  const namespace = DEV_SYSTEM_NAMESPACE;
  const labels = { app: API_NAME };

  // The script, and the templates it renders from. Both rewritten whenever they differ, so an
  // edit in this repo reaches a service that already exists.
  for (const [name, data] of [
    [API_NAME, { 'server.mjs': WORKSPACE_API_SERVER }],
    [API_TEMPLATES, { 'templates.json': JSON.stringify(publishedTemplates(), null, 2) }],
  ] as [string, Record<string, string>][]) {
    const url = `${ BASE }/v1/configmaps/${ namespace }/${ name }`;
    const existing = await devFetch(url).catch(() => null);

    if (!existing) {
      await devFetch(`${ BASE }/v1/configmaps`, {
        method: 'POST',
        body:   JSON.stringify({
          apiVersion: 'v1', kind: 'ConfigMap', metadata: { namespace, name, labels }, data,
        }),
      }).catch(() => null);
    } else if (JSON.stringify(existing.data) !== JSON.stringify(data)) {
      await devFetch(url, { method: 'PUT', body: JSON.stringify({ ...existing, data }) }).catch(() => null);
    }
  }

  await ensure('serviceaccounts', namespace, API_NAME, {
    apiVersion: 'v1', kind: 'ServiceAccount', metadata: { namespace, name: API_NAME },
  });

  // Cluster-scoped, because a workspace is a namespace and nothing namespaced can make one. The
  // verbs are the ones it uses and no others: it never deletes anything, and deleting a
  // workspace stays a thing a person does from the page.
  await ensure('rbac.authorization.k8s.io.clusterroles', null, API_NAME, {
    apiVersion: 'rbac.authorization.k8s.io/v1',
    kind:       'ClusterRole',
    metadata:   { name: API_NAME },
    rules:      [
      { apiGroups: [''], resources: ['namespaces'], verbs: ['get', 'list', 'create'] },
      {
        apiGroups: [''], resources: ['serviceaccounts', 'configmaps', 'secrets', 'services'], verbs: ['get', 'create']
      },
      {
        apiGroups: ['apps'], resources: ['deployments'], verbs: ['get', 'create']
      },
      {
        apiGroups: ['rbac.authorization.k8s.io'], resources: ['rolebindings'], verbs: ['get', 'create']
      },
    ],
  });

  await ensure('rbac.authorization.k8s.io.clusterrolebindings', null, API_NAME, {
    apiVersion: 'rbac.authorization.k8s.io/v1',
    kind:       'ClusterRoleBinding',
    metadata:   { name: API_NAME },
    roleRef:    { apiGroup: 'rbac.authorization.k8s.io', kind: 'ClusterRole', name: API_NAME },
    subjects:   [{ kind: 'ServiceAccount', name: API_NAME, namespace }],
  });

  // It binds `edit` into each workspace it makes, and Kubernetes refuses to grant rights the
  // granter does not hold. So it holds them, which is the price of making a workspace whose
  // conversations can manage their own namespace.
  await ensure('rbac.authorization.k8s.io.clusterrolebindings', null, `${ API_NAME }-edit`, {
    apiVersion: 'rbac.authorization.k8s.io/v1',
    kind:       'ClusterRoleBinding',
    metadata:   { name: `${ API_NAME }-edit` },
    roleRef:    { apiGroup: 'rbac.authorization.k8s.io', kind: 'ClusterRole', name: 'edit' },
    subjects:   [{ kind: 'ServiceAccount', name: API_NAME, namespace }],
  });

  await ensure('apps.deployments', namespace, API_NAME, {
    apiVersion: 'apps/v1',
    kind:       'Deployment',
    metadata:   { namespace, name: API_NAME, labels },
    spec:       {
      replicas: 1,
      selector: { matchLabels: labels },
      template: {
        metadata: { labels },
        spec:     {
          serviceAccountName: API_NAME,
          containers:         [{
            name:    'api',
            image:   'node:24',
            command: ['node', '/seed/server.mjs'],
            ports:   [{ name: 'http', containerPort: API_PORT }],
            env:     [
              { name: 'PORT', value: String(API_PORT) },
              // The apiserver's own CA, so node verifies it rather than being told not to.
              { name: 'NODE_EXTRA_CA_CERTS', value: '/var/run/secrets/kubernetes.io/serviceaccount/ca.crt' },
            ],
            volumeMounts: [
              { name: 'seed', mountPath: '/seed', readOnly: true },
              { name: 'templates', mountPath: '/templates', readOnly: true },
            ],
            readinessProbe: { httpGet: { path: '/', port: API_PORT }, periodSeconds: 10 },
          }],
          volumes: [
            { name: 'seed', configMap: { name: API_NAME } },
            { name: 'templates', configMap: { name: API_TEMPLATES } },
          ],
        },
      },
    },
  });

  await ensure('services', namespace, API_NAME, {
    apiVersion: 'v1',
    kind:       'Service',
    metadata:   { namespace, name: API_NAME, labels },
    spec:       { selector: labels, ports: [{ name: 'http', port: API_PORT, targetPort: 'http' }] },
  });
}

/**
 * The Insights database, which is one per person rather than one per workspace.
 *
 * That is the whole shape of the feature: what someone wants to ask is "what have my agents been
 * doing", and the answer spans every workspace they have. So it lives in dev-system beside the
 * secret store, named after the same owner, and every workspace is told where it is.
 *
 * It is a plain node:24 with a script from a ConfigMap and a hostPath for the file. There is no
 * image to build and nothing to install: node has carried a SQLite driver in core since 22.5.
 * See INSIGHTS_SERVER.
 */
const INSIGHTS_PORT = 8080;
const INSIGHTS_HOST_PATH = '/var/lib/rancher/dev-insights';

/** The Deployment, Service and ConfigMap are all called this. */
export async function insightsName(): Promise<string> {
  return `dev-insights-${ await currentOwner() }`;
}

/**
 * Where a pod reaches it, which is what a workspace's agents are given.
 *
 * A cluster-internal address, so it is reachable from any namespace and from nowhere outside the
 * cluster. Nothing authenticates it beyond that: it holds what this person's own agents chose to
 * record, in a cluster they already have a workspace in.
 */
export async function insightsServiceUrl(): Promise<string> {
  return `http://${ await insightsName() }.${ DEV_SYSTEM_NAMESPACE }.svc:${ INSIGHTS_PORT }`;
}

/** Where the browser reaches it: the same door every other in-cluster address uses. */
export async function insightsProxyUrl(): Promise<string> {
  const name = await insightsName();

  return `${ BASE }/api/v1/namespaces/${ DEV_SYSTEM_NAMESPACE }/services/http:${ name }:${ INSIGHTS_PORT }/proxy`;
}

/**
 * Create it if it is not there, and bring its script up to date if it is.
 *
 * Idempotent and quiet, the way everything else this extension puts in the cluster is: it runs
 * when the Insights page loads, for every user, including ones who cannot create anything in
 * dev-system, and a page that threw here would be a page that never rendered.
 */
export async function ensureInsights(): Promise<void> {
  const name = await insightsName();
  const namespace = DEV_SYSTEM_NAMESPACE;
  const labels = { app: name };
  const url = `${ BASE }/v1/configmaps/${ namespace }/${ name }`;
  const existing = await devFetch(url).catch(() => null);
  const data = { 'server.mjs': INSIGHTS_SERVER };

  if (!existing) {
    await devFetch(`${ BASE }/v1/configmaps`, {
      method: 'POST',
      body:   JSON.stringify({
        apiVersion: 'v1', kind: 'ConfigMap', metadata: { namespace, name, labels }, data,
      }),
    }).catch(() => null);
  } else if (existing.data?.['server.mjs'] !== INSIGHTS_SERVER) {
    await devFetch(url, { method: 'PUT', body: JSON.stringify({ ...existing, data }) }).catch(() => null);
  }

  await ensure('apps.deployments', namespace, name, {
    apiVersion: 'apps/v1',
    kind:       'Deployment',
    metadata:   { namespace, name, labels },
    spec:       {
      replicas: 1,
      selector: { matchLabels: labels },
      // Recreate: the database is one file on a hostPath, and two writers of one SQLite file is
      // the one arrangement it is not built for.
      strategy: { type: 'Recreate' },
      template: {
        metadata: { labels },
        spec:     {
          containers: [{
            name:         'insights',
            image:        'node:24',
            command:      ['node', '/seed/server.mjs'],
            ports:        [{ name: 'http', containerPort: INSIGHTS_PORT }],
            env:          [{ name: 'PORT', value: String(INSIGHTS_PORT) }],
            volumeMounts: [
              { name: 'seed', mountPath: '/seed', readOnly: true },
              { name: 'data', mountPath: '/data' },
            ],
            readinessProbe: { tcpSocket: { port: INSIGHTS_PORT }, periodSeconds: 10 },
          }],
          volumes: [
            { name: 'seed', configMap: { name } },
            // Per owner, so two people's databases are two files, and on the node so a restart
            // is not the end of what was recorded.
            {
              name: 'data', hostPath: { path: `${ INSIGHTS_HOST_PATH }/${ name }`, type: 'DirectoryOrCreate' }
            },
          ],
        },
      },
    },
  });

  await ensure('services', namespace, name, {
    apiVersion: 'v1',
    kind:       'Service',
    metadata:   { namespace, name, labels },
    spec:       { selector: labels, ports: [{ name: 'http', port: INSIGHTS_PORT, targetPort: 'http' }] },
  });
}

export interface InsightsTable {
  name: string;
  columns: string[];
  rows: number;
}

/** The tables, with their row counts, which is what the page's tabs are. */
export async function insightsTables(): Promise<InsightsTable[]> {
  const response = await fetch(`${ await insightsProxyUrl() }/api/tables`, { cache: 'no-store' });

  if (!response.ok) {
    throw new Error('The insights database is not answering yet.');
  }

  return (await response.json()).tables || [];
}

/** One query, run in the pod. See the server: it refuses anything that is not a SELECT. */
export async function insightsQuery(sql: string): Promise<{ columns: string[]; rows: Json[] }> {
  const response = await fetch(`${ await insightsProxyUrl() }/api/query`, {
    method:  'POST',
    headers: { 'content-type': 'application/json' },
    body:    JSON.stringify({ sql }),
  });
  const body = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(body.error || `The query failed: ${ response.status }.`);
  }

  return body;
}

/**
 * The account a manager sidecar runs as, in the workspace's own namespace.
 *
 * Not the workspace's account, which is bound to Kubernetes' aggregated `edit`. `edit`
 * deliberately excludes RBAC, and a helm install of vcluster creates a ServiceAccount, a Role and
 * a RoleBinding of its own, so a manager running as the workspace account fails part-way through
 * with a message about roles and leaves half a control plane behind.
 */
export const MANAGER_SERVICE_ACCOUNT = 'dev-manager';

/**
 * The scripts a sidecar declared, as a ConfigMap beside it.
 *
 * Rewritten rather than created once, so editing a script in this repo reaches a sidecar that
 * already exists. The pod picks it up on its next start, which is what Restart is for.
 */
async function ensureSidecarScripts(workspace: string, sidecar: DevSidecar): Promise<void> {
  if (!sidecar.scripts) {
    return;
  }

  const namespace = workspaceNamespace(workspace);
  const name = `${ sidecarName(workspace, sidecar.id) }-scripts`;
  const data: Record<string, string> = {};

  for (const [file, body] of Object.entries(sidecar.scripts)) {
    data[file] = body
      .replace(/{{namespace}}/g, namespace)
      .replace(/{{workspace}}/g, workspace);
  }

  const url = `${ BASE }/v1/configmaps/${ namespace }/${ name }`;
  const existing = await devFetch(url).catch(() => null);

  if (existing) {
    await devFetch(url, { method: 'PUT', body: JSON.stringify({ ...existing, data }) });

    return;
  }

  await devFetch(`${ BASE }/v1/configmaps`, {
    method: 'POST',
    body:   JSON.stringify({
      apiVersion: 'v1',
      kind:       'ConfigMap',
      metadata:   { namespace, name, labels: { [LABEL_WORKSPACE]: workspace, [LABEL_SIDECAR]: sidecar.id } },
      data,
    }),
  });
}

/**
 * The rights a manager sidecar needs, which are the chart's `rancher-manager` Role verbatim.
 *
 * Namespaced, and wide within the namespace. That is the trade the chart makes and it is the
 * right one: what runs here installs a Kubernetes distribution into a namespace, so it needs
 * everything a helm install of one needs, and the boundary that matters is that it is one
 * workspace's namespace rather than the cluster.
 */
async function ensureManagerRbac(workspace: string, sidecar: DevSidecar): Promise<void> {
  if (!sidecar.manager) {
    return;
  }

  const namespace = workspaceNamespace(workspace);

  await ensure('serviceaccounts', namespace, MANAGER_SERVICE_ACCOUNT, {
    apiVersion: 'v1',
    kind:       'ServiceAccount',
    metadata:   { namespace, name: MANAGER_SERVICE_ACCOUNT },
  });

  await ensure('rbac.authorization.k8s.io.roles', namespace, MANAGER_SERVICE_ACCOUNT, {
    apiVersion: 'rbac.authorization.k8s.io/v1',
    kind:       'Role',
    metadata:   { namespace, name: MANAGER_SERVICE_ACCOUNT },
    rules:      MANAGER_RULES,
  });

  await ensure('rbac.authorization.k8s.io.rolebindings', namespace, MANAGER_SERVICE_ACCOUNT, {
    apiVersion: 'rbac.authorization.k8s.io/v1',
    kind:       'RoleBinding',
    metadata:   { namespace, name: MANAGER_SERVICE_ACCOUNT },
    roleRef:    {
      apiGroup: 'rbac.authorization.k8s.io', kind: 'Role', name: MANAGER_SERVICE_ACCOUNT
    },
    subjects: [{ kind: 'ServiceAccount', name: MANAGER_SERVICE_ACCOUNT, namespace }],
  });
}

/**
 * Where a sidecar answers inside the cluster, which is not the same as where a browser reaches it.
 *
 * The proxy URL is for a person with a Rancher session; this is for one pod talking to another,
 * and it is what the workspace's dev server is pointed at.
 */
export function sidecarServiceUrl(workspace: string, sidecar: DevSidecar): string {
  const namespace = workspaceNamespace(workspace);

  return `${ sidecar.scheme || 'http' }://${ sidecarName(workspace, sidecar.id) }.${ namespace }.svc`;
}

/**
 * Start a sidecar, creating it the first time.
 *
 * Three things happen before either path, and all three have to happen on both, which is what
 * the version that only did them on create got wrong:
 *
 *   - the ServiceAccount. A workspace created before this product had one has no `dev-workspace`
 *     in its namespace, and a Deployment naming one that does not exist never produces a pod at
 *     all: the ReplicaSet is refused, and the card reads Starting for ever with nothing to read.
 *   - the generated secrets, so an admin password exists before something asks for it.
 *   - the mirror, because the pod reads its environment when it starts, and a key set in Settings
 *     since the last start reaches it at this moment or not at all.
 *
 * The values arrive by reference either way, so `kubectl get deploy -o yaml` shows a Secret name
 * and a key rather than a token.
 */
export async function startSidecar(workspace: string, sidecar: DevSidecar, template: DevTemplate): Promise<void> {
  const namespace = workspaceNamespace(workspace);
  const name = sidecarName(workspace, sidecar.id);
  const url = `${ BASE }/v1/apps.deployments/${ namespace }/${ name }`;

  await ensureWorkspaceRbac(workspace);

  // The store as it stands once anything generated has been filled in, carried from here rather
  // than read again at each step. See ensureGeneratedSecrets.
  const store = await ensureGeneratedSecrets(template);

  // Refused rather than started without it. The reference is `optional`, so a sidecar started
  // without a key it declared comes up, answers nothing and looks healthy, which is the failure
  // this is here to make impossible. The card disables Start for the same reason; this is the
  // half that a second tab or a stale page cannot get around.
  const keys = Object.entries(store).filter(([, value]) => !!value).map(([key]) => key);
  const missing = missingSecrets(sidecar, template, keys)
    .filter((key) => (template.secrets || []).find((secret) => secret.key === key)?.required !== false);

  if (missing.length) {
    throw new Error(`${ sidecar.label } needs ${ missing.join(', ') }, which is not set. Set it in Settings first.`);
  }

  await mirrorSecrets(workspace, template, store);

  // Every key this sidecar declared, present in the store the mirror was just written from.
  //
  // The reference is optional, so a key that did not make it arrives as an empty variable and the
  // container carries on with it. For a generated password that means the thing it protects is
  // installed with no password at all, and the failure surfaces minutes later as a login that
  // cannot succeed and a reset that has nothing to reset to. Checked here, where it is still a
  // sentence rather than a mystery.
  const blank = (sidecar.secrets || []).filter((key) => !store[templateSecretKey(template.id, key)]);

  if (blank.length) {
    throw new Error(`${ sidecar.label } cannot be started: ${ blank.join(', ') } has no value in the secret store.`);
  }

  // Both of these are rewritten on every start, not created once. A script edited in this repo
  // has to reach a sidecar that already exists, and a manager's rights have to be there before
  // its ReplicaSet is admitted rather than after.
  await ensureSidecarScripts(workspace, sidecar);
  await ensureManagerRbac(workspace, sidecar);

  // What the gear was last saved with, read here rather than in the pod spec so both the create
  // and the update path get the same answer from one fetch.
  const params = await sidecarParams(workspace, sidecar);

  // The browser's own extension, built for this workspace. See ensureBrowserExtension.
  if (sidecar.extension) {
    await ensureBrowserExtension(workspace, template, store);
  }

  // The workspace itself, brought up to date. A workspace made before its template asked for an
  // origin of its own is still in proxy mode, and starting its Rancher is exactly the moment
  // somebody expects that to have been sorted out: without this they get a restart and a
  // workspace whose dashboard still calls the Rancher this page is served from.
  await bringWorkspaceUpToDate(workspace, template);

  const existing = await devFetch(url).catch(() => null);

  if (existing) {
    // The declaration as it stands today, not as it stood when this Deployment was made. A sidecar
    // created before its declaration asked for a variable never gains it otherwise, which is not
    // academic: the auth switch added five secrets and the node's address to a manager that already
    // existed, and a manager without them starts, says nothing, and cannot configure anything.
    existing.spec.replicas = 1;
    existing.spec.template.spec = sidecarPodSpec(workspace, sidecar, template, params);
    await devFetch(url, { method: 'PUT', body: JSON.stringify(existing) });

    return;
  }

  const labels = { app: name, [LABEL_WORKSPACE]: workspace, [LABEL_SIDECAR]: sidecar.id };

  await devFetch(`${ BASE }/v1/apps.deployments`, {
    method: 'POST',
    body:   JSON.stringify({
      apiVersion: 'apps/v1',
      kind:       'Deployment',
      metadata:   { namespace, name, labels },
      spec:       {
        replicas: 1,
        selector: { matchLabels: { app: name } },
        // Recreate rather than RollingUpdate, as the chart has it for the same containers. A
        // sidecar is one instance of one thing, often holding a port or a directory, and during a
        // rolling update there are two of them: the card would read the older pod's state and
        // report Running while the new one cannot start at all.
        strategy: { type: 'Recreate' },
        template: { metadata: { labels }, spec: sidecarPodSpec(workspace, sidecar, template, params) },
      },
    }),
  });

  await ensureSidecarService(workspace, sidecar);
}

/**
 * The pod a sidecar's declaration describes.
 *
 * One function rather than an object literal inside the create path, because the update path needs
 * the same answer: what a sidecar's pod should be is a property of the declaration, and a
 * Deployment that already exists is just as entitled to today's version of it as a new one.
 */
function sidecarPodSpec(workspace: string, sidecar: DevSidecar, template: DevTemplate, params: Record<string, string> = {}): Json {
  const namespace = workspaceNamespace(workspace);
  const name = sidecarName(workspace, sidecar.id);
  const owns = (template.sidecars || []).find((candidate) => candidate.providesApi);
  const substitute = (value: string) => value
    .replace(/{{namespace}}/g, namespace)
    .replace(/{{workspace}}/g, workspace)
    .replace(/{{workspaceUrl}}/g, workspaceServiceUrl(workspace, template))
    // The workspace's own Rancher, by the address it will answer on whether or not it is running
    // yet. Written in from the moment the sidecar that uses it is created, for the reason
    // substituteTemplateEnv gives: an address that appears only once something is up is an
    // address nothing can be pointed at in advance.
    .replace(/{{ownRancher}}/g, owns ? sidecarServiceUrl(workspace, owns) : '');

  return {
    // A manager runs as an account of its own. See ensureManagerRbac.
    serviceAccountName: sidecar.manager ? MANAGER_SERVICE_ACCOUNT : WORKSPACE_SERVICE_ACCOUNT,
    containers:         [{
      name:  'sidecar',
      image: sidecar.image,
      ...(sidecar.command ? { command: sidecar.command } : {}),
      ...(sidecar.args ? { args: sidecar.args } : {}),
      ...(sidecar.port ? { ports: [{ name: 'http', containerPort: sidecar.port }] } : {}),
      env: [
        ...Object.entries(sidecar.env || {}).map(([envName, value]) => ({
          name: envName, value: substitute(value)
        })),
        // What the card's gear was last saved with. Declared values only, so a key left in the
        // ConfigMap by a parameter that has since been removed reaches nothing. See sidecarParams.
        ...(sidecar.params || []).map((param) => ({
          name: param.env, value: params[param.id] ?? (param.default || ''),
        })),
        // By reference, never by value: the token is not in the pod spec, so it is not
        // in `kubectl get deploy -o yaml` either.
        ...(sidecar.secrets || []).map((key) => ({
          name:      key,
          valueFrom: { secretKeyRef: { name: MIRROR_SECRET, key, optional: true } },
        })),
        // The same values under whatever name the image actually reads. See secretEnv.
        ...Object.entries(sidecar.secretEnv || {}).map(([envName, key]) => ({
          name:      envName,
          valueFrom: { secretKeyRef: { name: MIRROR_SECRET, key, optional: true } },
        })),
        // Read off the pod rather than out of the declaration, because nothing on this
        // side of the API knows it. See fieldEnv.
        ...Object.entries(sidecar.fieldEnv || {}).map(([envName, fieldPath]) => ({
          name:      envName,
          valueFrom: { fieldRef: { fieldPath } },
        })),
      ],
      // The chart's own budget: half an hour of ten-second-apart attempts, starting a
      // minute in. What it is waiting for is two helm installs into a cluster this pod has
      // to create first, and a probe that gave up sooner would kill the thing it is
      // measuring part-way through.
      ...(sidecar.readyPort ? {
        readinessProbe: {
          tcpSocket:           { port: sidecar.readyPort },
          initialDelaySeconds: 60,
          periodSeconds:       20,
          failureThreshold:    90,
        },
      } : {}),
      ...(sidecar.preStop ? { lifecycle: { preStop: { exec: { command: sidecar.preStop } } } } : {}),
      volumeMounts: [
        ...(sidecar.scripts ? [{ name: 'scripts', mountPath: '/scripts', readOnly: true }] : []),
        ...(sidecar.shm ? [{ name: 'shm', mountPath: '/dev/shm' }] : []),
        // One mount per file, with subPath, rather than the whole Secret at one path.
        //
        // A Secret volume is a directory of symlinks into a hidden `..data` directory, and
        // Chromium will not load an unpacked extension whose manifest is one: it reports nothing
        // and runs without it, which is exactly what it did. A subPath mount is a real file. The
        // cost is that these no longer update in place, which does not matter here because the
        // Secret is rewritten and the pod rolled in the same breath. See ensureBrowserExtension.
        ...(sidecar.extension ? Object.keys(BROWSER_EXTENSION_FILES).map((file) => ({
          name: 'extension', mountPath: `${ BROWSER_EXTENSION_MOUNT }/${ file }`, subPath: file, readOnly: true,
        })) : []),
      ],
    }],
    volumes: [
      ...(sidecar.scripts ? [{ name: 'scripts', configMap: { name: `${ name }-scripts`, defaultMode: 0o555 } }] : []),
      // A container gets 64MB of shared memory by default, and Chromium's renderers pass their
      // surfaces through it: the documented symptom of leaving it at 64MB is tabs dying as "Aw,
      // Snap" on pages of any size. The closet's compose file says the same thing to the same
      // image as `shm_size: 1gb`. Memory-backed, so it is the pod's own memory rather than the
      // node's disk.
      ...(sidecar.shm ? [{ name: 'shm', emptyDir: { medium: 'Memory', sizeLimit: '1Gi' } }] : []),
      // The extension's files, as a directory Chromium can be pointed at. `optional`, so a
      // sidecar that starts before the Secret is written comes up without it rather than
      // staying in ContainerCreating for ever.
      ...(sidecar.extension ? [{
        name: 'extension', secret: { secretName: BROWSER_EXTENSION_SECRET, optional: true }
      }] : []),
    ],
  };
}

/**
 * A sidecar's Service, of the type its declaration asks for.
 *
 * Written on every start rather than only on the first, and upgraded in place, for the same reason
 * the workspace's own Service is: a sidecar started before its declaration wanted a node port
 * already has a ClusterIP Service, and nothing else would ever put that right.
 */
async function ensureSidecarService(workspace: string, sidecar: DevSidecar): Promise<void> {
  if (!sidecar.port) {
    return;
  }

  const namespace = workspaceNamespace(workspace);
  const name = sidecarName(workspace, sidecar.id);
  const labels = { app: name, [LABEL_WORKSPACE]: workspace, [LABEL_SIDECAR]: sidecar.id };
  const url = `${ BASE }/v1/services/${ namespace }/${ name }`;
  const service = await devFetch(url).catch(() => null);

  if (!service) {
    await devFetch(`${ BASE }/v1/services`, {
      method: 'POST',
      body:   JSON.stringify({
        apiVersion: 'v1',
        kind:       'Service',
        metadata:   { namespace, name, labels },
        spec:       {
          ...(sidecar.nodePort ? { type: 'NodePort' } : {}),
          selector: { app: name },
          ports:    [{ name: sidecar.scheme || 'http', port: sidecar.port, targetPort: 'http' }],
        },
      }),
    });

    return;
  }

  let changed = false;

  if (sidecar.nodePort && service.spec?.type !== 'NodePort') {
    service.spec.type = 'NodePort';
    changed = true;
  }

  // The port the declaration now names. Figma was declared on 3000 and listens on 8000, so its
  // Service pointed at a port nothing was bound to and every link to it was dead; correcting the
  // declaration has to correct the Service too, or the fix reaches only new workspaces. The
  // existing entry is edited rather than replaced, so an assigned nodePort is not given up.
  const entry = service.spec?.ports?.[0];

  if (entry && entry.port !== sidecar.port) {
    entry.port = sidecar.port;
    entry.name = sidecar.scheme || 'http';
    entry.targetPort = 'http';
    changed = true;
  }

  if (changed) {
    await devFetch(url, { method: 'PUT', body: JSON.stringify(service) });
  }
}

/** Where a sidecar with a node port answers, for the browser rather than for a pod. */
export async function sidecarNodePort(workspace: string, sidecar: DevSidecar): Promise<number> {
  const namespace = workspaceNamespace(workspace);
  const url = `${ BASE }/v1/services/${ namespace }/${ sidecarName(workspace, sidecar.id) }`;
  const service = await devFetch(url).catch(() => null);

  return service?.spec?.ports?.[0]?.nodePort || 0;
}

/**
 * The auth provider a workspace has asked its own Rancher to use, and what came of it.
 *
 * A ConfigMap rather than a call, because the thing that carries it out is the manager sidecar and
 * it is not always running: a choice made while it is down has to still be there when it comes
 * back, exactly as the closet keeps it in `.env` so its bootstraps re-apply it. See AUTH_SCRIPT.
 */
export const AUTH_CONFIG_MAP = 'dev-auth';

export interface DevAuthState {
  /** What was asked for. Empty means local users only. */
  wanted: string;
  /** What the manager last got this Rancher to accept, which is empty until it has. */
  applied: string;
  /** The manager's own sentence about the last attempt. */
  message: string;
  at: string;
}

export async function workspaceAuth(workspace: string): Promise<DevAuthState> {
  const namespace = workspaceNamespace(workspace);
  const config = await devFetch(`${ BASE }/v1/configmaps/${ namespace }/${ AUTH_CONFIG_MAP }`).catch(() => null);
  const data = config?.data || {};

  return {
    wanted:  data.provider || '',
    applied: data.applied || '',
    message: data.message || '',
    at:      data.at || '',
  };
}

/**
 * Ask for a provider. Only the request is written here.
 *
 * `applied` is deliberately left alone rather than cleared: it is the manager's, and blanking it
 * would make the card claim nothing is configured during the twenty seconds before the manager
 * notices, which is the opposite of what is true.
 */
export async function setWorkspaceAuth(workspace: string, provider: string): Promise<void> {
  const namespace = workspaceNamespace(workspace);
  const url = `${ BASE }/v1/configmaps/${ namespace }/${ AUTH_CONFIG_MAP }`;
  const existing = await devFetch(url).catch(() => null);

  if (existing) {
    await devFetch(url, {
      method: 'PUT',
      body:   JSON.stringify({ ...existing, data: { ...(existing.data || {}), provider } }),
    });

    return;
  }

  await devFetch(`${ BASE }/v1/configmaps`, {
    method: 'POST',
    body:   JSON.stringify({
      apiVersion: 'v1',
      kind:       'ConfigMap',
      metadata:   { namespace, name: AUTH_CONFIG_MAP, labels: { [LABEL_WORKSPACE]: workspace } },
      data:       { provider },
    }),
  });
}

/**
 * Restart a sidecar: roll its pod, without ever stopping it.
 *
 * Not stop-then-start, which is what this was. That is two writes with a gap between them, and
 * everything that can go wrong in the gap does: if the second half fails the sidecar is left
 * stopped with the reason showing only as a banner that the next poll replaces, and for a sidecar
 * that owns the workspace's API the two halves point the workspace at the host Rancher and back
 * again, restarting it twice for a change that ends where it began. Observed: a Restart that
 * reported Running and left the Deployment at zero replicas, because the badge was still reading
 * the terminating pod.
 *
 * An annotation on the pod template is how Kubernetes' own `rollout restart` does it: one write,
 * the Deployment's own strategy carries it out, and a sidecar that was running is running
 * throughout. It also picks up whatever the scripts ConfigMap now says, which is the usual reason
 * to press it.
 */
export async function restartSidecar(workspace: string, sidecar: DevSidecar, template: DevTemplate): Promise<void> {
  const namespace = workspaceNamespace(workspace);
  const url = `${ BASE }/v1/apps.deployments/${ namespace }/${ sidecarName(workspace, sidecar.id) }`;
  const deployment = await devFetch(url).catch(() => null);

  if (!deployment) {
    // Never started, so there is nothing to roll and starting it is what was meant.
    await startSidecar(workspace, sidecar, template);

    return;
  }

  // The scripts and the secrets are rewritten first, since picking up a change to them is what a
  // restart is usually for. Generated keys are filled in here as well as on the start path,
  // because a template that has since declared a new one (the auth switch added two) would
  // otherwise mirror nothing for it, and the sidecar would come back without a value it needs.
  await ensureSidecarScripts(workspace, sidecar);

  const store = await ensureGeneratedSecrets(template);

  await mirrorSecrets(workspace, template, store);
  await ensureSidecarService(workspace, sidecar);

  // The same rewrite the start path does. Restart is what someone presses when the product has
  // changed its mind about what this pod should be, and the extension is part of that: without
  // this, a browser that was already running when the extension was added comes back with the
  // volume declared and nothing in it.
  if (sidecar.extension) {
    await ensureBrowserExtension(workspace, template, store);
  }

  const meta = deployment.spec.template.metadata;

  meta.annotations = { ...(meta.annotations || {}), 'dev.rancher.io/restarted-at': new Date().toISOString() };
  deployment.spec.replicas = 1;
  // Today's declaration, for the reason the start path takes it: a restart is what someone presses
  // when the product has changed its mind about what this pod should be.
  deployment.spec.template.spec = sidecarPodSpec(workspace, sidecar, template, await sidecarParams(workspace, sidecar));

  await devFetch(url, { method: 'PUT', body: JSON.stringify(deployment) });
}

/**
 * Stop a sidecar by scaling it to nothing, leaving it declared and restartable.
 *
 * Its Service is left behind on purpose: a stopped sidecar keeps the address it will answer on
 * again, so a link to it is still the right link, and a Service with nothing behind it routes
 * nowhere rather than somewhere wrong. The mirrored Secret is left for a different reason, which
 * is that it is the workspace's rather than this sidecar's; both go when the namespace does.
 */
export async function stopSidecar(workspace: string, id: string, template?: DevTemplate): Promise<void> {
  const namespace = workspaceNamespace(workspace);
  const url = `${ BASE }/v1/apps.deployments/${ namespace }/${ sidecarName(workspace, id) }`;
  const deployment = await devFetch(url).catch(() => null);

  if (!deployment) {
    return;
  }

  deployment.spec.replicas = 0;
  await devFetch(url, { method: 'PUT', body: JSON.stringify(deployment) });

  // Nothing to put back. The workspace is pointed at this sidecar's address from the day it was
  // created, so stopping it leaves a dashboard whose API refuses the connection, which is the
  // truth. The version that swapped the address to the host on stop restarted the workspace twice
  // per Restart and, in between, pointed a published node port at the host cluster's API.
  void template;
}

/** Where a sidecar's own UI is served, on Rancher's origin, the same door a workspace uses. */
export function sidecarProxyUrl(workspace: string, sidecar: DevSidecar): string {
  const namespace = workspaceNamespace(workspace);
  const scheme = sidecar.scheme || 'http';

  return `${ BASE }/api/v1/namespaces/${ namespace }/services/${ scheme }:${ sidecarName(workspace, sidecar.id) }:${ sidecar.port }/proxy/`;
}

/** A socket the workspace's own process is listening on, as its pod reports it. */
export interface DevListening {
  port: number;
  /**
   * Bound to loopback, so publishing it would not help: a Service routes to the pod's address,
   * and a server listening only on 127.0.0.1 refuses that connection. Worth saying rather than
   * hiding, because the fix is one flag on whatever is being run.
   */
  loopback: boolean;
}

/** Whether an address in /proc/net/tcp is a loopback one, in either family. */
function isLoopback(address: string): boolean {
  // Little-endian hex, so 127.0.0.1 is 0100007F. The v6 form is ::1, which is fifteen zero bytes
  // and a one, written by the kernel in this order.
  return address === '0100007F' || address === '00000000000000000000000001000000';
}

/**
 * What the workspace is actually listening on, rather than what its Service says.
 *
 * From /proc/net/tcp in the pod, which is the one source that needs nothing installed: `ss` and
 * `netstat` are both absent from the image a workspace runs, and a detection that depends on a
 * package the person has to install first is not automatic.
 *
 * `0A` is TCP_LISTEN. Everything else in those files is a connection, including the ones this
 * page's own request makes, so a state filter is what separates a server from its traffic.
 */
export async function workspaceListening(name: string): Promise<DevListening[]> {
  const namespace = workspaceNamespace(name);
  const pod = await workspacePod(name);

  if (!pod) {
    return [];
  }

  const out = await podExecOnce(namespace, pod, WORKSPACE_CONTAINER, [
    '/bin/sh', '-c', 'cat /proc/net/tcp /proc/net/tcp6 2>/dev/null || true',
  ]);

  const found = new Map<number, boolean>();

  for (const line of out.split('\n')) {
    const fields = line.trim().split(/\s+/);

    if (fields[3] !== '0A' || !fields[1]) {
      continue;
    }

    const [address, hexPort] = fields[1].split(':');
    const port = parseInt(hexPort, 16);

    if (!port) {
      continue;
    }

    // A port bound on both a real address and loopback is reachable, so the reachable answer wins.
    found.set(port, (found.get(port) ?? true) && isLoopback(address));
  }

  return [...found.entries()]
    .map(([port, loopback]) => ({ port, loopback }))
    .sort((a, b) => a.port - b.port);
}

/**
 * The ports a workspace has shared, read back from the proxy's own config.
 *
 * Kept on the Deployment as an annotation rather than in a store of this product's own: the
 * shares are what the proxy is running, so the proxy is where they are recorded, and a share that
 * exists in a list but not in nginx would be a link that 502s.
 */
const SHARE_ANNOTATION = 'dev.rancher.io/shares';

export async function listWorkspaceShares(name: string): Promise<DevShare[]> {
  const namespace = workspaceNamespace(name);
  const url = `${ BASE }/v1/apps.deployments/${ namespace }/${ shareName(namespace) }`;
  const deployment = await devFetch(url).catch(() => null);

  try {
    return JSON.parse(deployment?.metadata?.annotations?.[SHARE_ANNOTATION] || '[]');
  } catch {
    return [];
  }
}

/**
 * Share a workspace port, or stop sharing it.
 *
 * One function for both because they are the same write: the list of shares is rendered into an
 * nginx config, a password file and a Service, and every one of those is replaced wholesale each
 * time. Sharing the third port and unsharing the second are the same operation on a different
 * list, which is what keeps the four things from drifting apart.
 */
export async function setWorkspaceShares(name: string, shares: DevShare[]): Promise<void> {
  const namespace = workspaceNamespace(name);
  const proxy = shareName(namespace);
  const labels = { app: proxy, [LABEL_WORKSPACE]: name };

  await ensureWorkspaceRbac(name);

  // Nothing shared: the proxy is scaled away rather than deleted, so unsharing and sharing again
  // does not have to wait for an image pull, and so its Service keeps the node ports it was given.
  if (!shares.length) {
    const url = `${ BASE }/v1/apps.deployments/${ namespace }/${ proxy }`;
    const existing = await devFetch(url).catch(() => null);

    if (existing) {
      existing.spec.replicas = 0;
      existing.metadata.annotations = { ...(existing.metadata.annotations || {}), [SHARE_ANNOTATION]: '[]' };
      await devFetch(url, { method: 'PUT', body: JSON.stringify(existing) });
    }

    return;
  }

  await upsert('configmaps', namespace, proxy, {
    apiVersion: 'v1',
    kind:       'ConfigMap',
    metadata:   { namespace, name: proxy, labels },
    data:       { 'nginx.conf': nginxConf(namespace, name, shares) },
  });

  await upsert('secrets', namespace, proxy, {
    apiVersion: 'v1',
    kind:       'Secret',
    metadata:   { namespace, name: proxy, labels },
    type:       'Opaque',
    data:       { htpasswd: encodeSecret(htpasswd(shares)) },
  }, (secret) => {
    secret.data = { htpasswd: encodeSecret(htpasswd(shares)) };
  });

  await upsert('services', namespace, proxy, {
    apiVersion: 'v1',
    kind:       'Service',
    metadata:   { namespace, name: proxy, labels },
    spec:       {
      type:     'NodePort',
      selector: { app: proxy },
      ports:    shares.map((share) => ({
        name: `p${ share.listen }`, port: share.listen, targetPort: share.listen,
      })),
    },
  }, (service) => {
    // The existing entries are kept rather than replaced, so a node port the cluster already
    // assigned to a share is not given up and every link already sent out keeps working.
    const before = service.spec?.ports || [];

    service.spec.type = 'NodePort';
    service.spec.ports = shares.map((share) => {
      const kept = before.find((entry: Json) => entry.port === share.listen);

      return kept || { name: `p${ share.listen }`, port: share.listen, targetPort: share.listen };
    });
  });

  await upsert('apps.deployments', namespace, proxy, {
    apiVersion: 'apps/v1',
    kind:       'Deployment',
    metadata:   {
      namespace, name: proxy, labels, annotations: { [SHARE_ANNOTATION]: JSON.stringify(shares) }
    },
    spec: {
      replicas: 1,
      selector: { matchLabels: { app: proxy } },
      strategy: { type: 'Recreate' },
      template: { metadata: { labels }, spec: sharePodSpec(namespace, WORKSPACE_SERVICE_ACCOUNT) },
    },
  }, (deployment) => {
    deployment.spec.replicas = 1;
    deployment.spec.template.spec = sharePodSpec(namespace, WORKSPACE_SERVICE_ACCOUNT);
    deployment.metadata.annotations = {
      ...(deployment.metadata.annotations || {}), [SHARE_ANNOTATION]: JSON.stringify(shares),
    };

    // nginx reads its config once, at start, so a config that changed under a running pod is a
    // proxy still serving the old set of ports. This is Kubernetes' own `rollout restart`.
    const meta = deployment.spec.template.metadata;

    meta.annotations = { ...(meta.annotations || {}), 'dev.rancher.io/restarted-at': new Date().toISOString() };
  });
}

/** Where a share answers, once the cluster has assigned its Service a node port. */
export async function shareNodePorts(name: string): Promise<Record<number, number>> {
  const namespace = workspaceNamespace(name);
  const service = await devFetch(`${ BASE }/v1/services/${ namespace }/${ shareName(namespace) }`).catch(() => null);
  const out: Record<number, number> = {};

  for (const entry of service?.spec?.ports || []) {
    if (entry.nodePort) {
      out[entry.port] = entry.nodePort;
    }
  }

  return out;
}

/**
 * Create it, or bring the one that is there up to date.
 *
 * `ensure` next door deliberately leaves an existing object alone, which is right for the things
 * it makes once and wrong for every object here: a share's config is rewritten every time the set
 * of shares changes. The mutate callback is how a caller keeps the parts of an existing object
 * that Kubernetes assigned rather than this code, which is what stops a node port moving under a
 * link somebody has already been given.
 */
async function upsert(type: string, namespace: string, name: string, body: Json, mutate?: (existing: Json) => void): Promise<void> {
  const url = `${ BASE }/v1/${ type }/${ namespace }/${ name }`;
  const existing = await devFetch(url).catch(() => null);

  if (!existing) {
    await devFetch(`${ BASE }/v1/${ type }`, { method: 'POST', body: JSON.stringify(body) });

    return;
  }

  if (mutate) {
    mutate(existing);
  } else {
    existing.data = body.data;
  }

  await devFetch(url, { method: 'PUT', body: JSON.stringify(existing) });
}

/**
 * The node ports the cluster has already given out.
 *
 * Asked so that a suggestion is a port that will actually be accepted rather than one the
 * apiserver rejects a moment later. It reads every Service the person can see, which for an
 * admin is all of them and for anyone else is a subset - a suggestion built from a subset is
 * still better than one built from nothing, and the cluster has the final say either way.
 */
export async function usedNodePorts(): Promise<number[]> {
  const services = await devFetch(`${ BASE }/v1/services`).catch(() => null);

  return (services?.data || [])
    .flatMap((service: Json) => service.spec?.ports || [])
    .map((port: Json) => port.nodePort)
    .filter((port: number) => !!port);
}

/** The range Kubernetes assigns node ports from, and refuses anything outside. */
export const NODE_PORT_RANGE = { first: 30000, last: 32767 };

/**
 * A published port for a local one: free, and the same answer every time it is asked.
 *
 * Derived from the local port rather than taken from the bottom of the range, so a workspace's
 * 8005 lands somewhere memorable and lands there again after it is unforwarded and forwarded.
 * Collisions walk forward from there.
 */
export function suggestNodePort(port: number, used: number[]): number {
  const span = NODE_PORT_RANGE.last - NODE_PORT_RANGE.first + 1;
  const taken = new Set(used);

  for (let i = 0; i < span; i++) {
    const candidate = NODE_PORT_RANGE.first + ((port + i) % span);

    if (!taken.has(candidate)) {
      return candidate;
    }
  }

  // Every port in the range is spoken for, which is not a thing that happens in a cluster with
  // room for another workspace. Nothing suggested is better than a number that cannot work.
  return 0;
}

/** One entry in a workspace's Service. */
export interface DevPort {
  name: string;
  port: number;
  /** The published port, or 0 where the Service does not publish this one. */
  nodePort?: number;
}

/** Kubernetes' own limit on a Service port name, which is a DNS label of at most 15 characters. */
const PORT_NAME_PATTERN = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;
const MAX_PORT_NAME_LENGTH = 15;

/**
 * Every port a workspace's Service carries.
 *
 * The template's port is the first of these rather than a special case, which is what makes
 * "the port a workspace serves on" a list rather than a fact: a workspace can be running a dev
 * server, an app and a debugger, and the harness's answer to that is a route per port.
 */
export async function listWorkspacePorts(name: string): Promise<DevPort[]> {
  const namespace = workspaceNamespace(name);
  const services = await devFetch(`${ BASE }/v1/services/${ namespace }`).catch(() => null);
  const service = (services?.data || []).find((svc: Json) => svc.metadata?.name === namespace);

  return (service?.spec?.ports || []).map((port: Json) => ({
    name:     port.name || '',
    port:     port.port,
    // What it is published on, when the Service is a NodePort. This is the public half of the
    // mapping the Ports tab draws.
    nodePort: port.nodePort || 0,
  }));
}

/** Why a port cannot be added, or '' when it can. */
export function portError(port: number, existing: DevPort[]): string {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return 'A port is a number between 1 and 65535';
  }

  if (existing.some((entry) => entry.port === port)) {
    return `This workspace already serves port ${ port }`;
  }

  return '';
}

/**
 * A name for a port that Kubernetes will accept.
 *
 * Every port in a Service with more than one has to be named, and the name is a DNS label, so
 * `8080` on its own is not one. `p8080` is, and it is derived rather than asked for: a name is
 * something Kubernetes needs and nobody using this has an opinion about.
 */
function portName(port: number): string {
  const name = `p${ port }`;

  return PORT_NAME_PATTERN.test(name) && name.length <= MAX_PORT_NAME_LENGTH ? name : `p${ port }`.slice(0, MAX_PORT_NAME_LENGTH);
}

/**
 * Add or remove a port on a workspace's Service.
 *
 * Read-modify-write through Steve, the same shape as scaling a Deployment, so a second tab
 * editing the same Service loses the resourceVersion check rather than silently winning it.
 *
 * This does not touch the pod. A Service is a set of routing rules in front of whatever the
 * pod already listens on, so adding a port here publishes something that is already there and
 * removing one takes the route away rather than the server. Whether anything answers on it is
 * a separate question, which is why the ports list asks it separately.
 */
async function editWorkspacePorts(name: string, edit: (ports: Json[]) => Json[]): Promise<void> {
  const namespace = workspaceNamespace(name);
  const url = `${ BASE }/v1/services/${ namespace }/${ namespace }`;
  const service = await devFetch(url);

  service.spec.ports = edit(service.spec.ports || []);

  await devFetch(url, { method: 'PUT', body: JSON.stringify(service) });
}

/**
 * Add a port, and optionally say which published one it should answer on.
 *
 * The harness maps a public port to a local one, and this is that mapping in Kubernetes: the
 * local port is the one the workspace is listening on, and the public one is the node port. A
 * node port left out is chosen by the cluster from its own range, which is the ordinary case; a
 * node port asked for is one somebody wants to keep stable across rebuilds, and the cluster
 * refuses it if it is outside the range or already taken.
 */
export function addWorkspacePort(name: string, port: number, nodePort?: number): Promise<void> {
  return editWorkspacePorts(name, (ports) => [
    ...ports,
    // targetPort is the number rather than a named port: a name only exists if the
    // Deployment's container declared it, and a port added after the fact has not been.
    {
      name: portName(port), port, targetPort: port, protocol: 'TCP', ...(nodePort ? { nodePort } : {}),
    },
  ]);
}

export function removeWorkspacePort(name: string, port: number): Promise<void> {
  return editWorkspacePorts(name, (ports) => ports.filter((entry) => entry.port !== port));
}

/**
 * Where a workspace's own server is served, on Rancher's origin.
 *
 * The Kubernetes apiserver's service proxy, which is the same door the dev server this
 * dashboard is served through comes out of. Root-relative on purpose: the browser resolves it
 * against whatever host Rancher is on, so nothing here ever learns or hardcodes a hostname,
 * and the URL works for anyone whose Rancher session can reach the namespace.
 *
 * `http:` is the scheme the proxy should speak to the Service in, not part of its name.
 */
export function workspaceProxyUrl(name: string, port: number, scheme = 'http'): string {
  const namespace = workspaceNamespace(name);

  return `${ BASE }/api/v1/namespaces/${ namespace }/services/${ scheme }:${ namespace }:${ port }/proxy/`;
}

/**
 * Whether anything is answering on that port yet.
 *
 * A workspace can be Running with nothing listening: the image is still starting, the server
 * inside it is still compiling, or the template's command is wrong. The proxy's own answer to
 * that is a 503 with a Kubernetes Status in it, and framing that is how a page ends up
 * showing someone an apiserver error page and calling it their app.
 *
 * Only the proxy's own failures count as not serving. A 404 or a 500 from the workspace is the
 * workspace answering, which is something to show rather than something to wait through.
 */
export function workspaceServing(name: string, port: number, scheme = 'http'): Promise<boolean> {
  return proxyServing(workspaceProxyUrl(name, port, scheme));
}

/**
 * The same question about a sidecar, which has the same two answers for the same reasons.
 *
 * A running pod is not a served page: the browser sidecar's Deployment is Available a second or
 * two before its UI answers, and framing it in that window shows an apiserver 503 that nothing
 * afterwards clears, because an iframe on another origin's path cannot be told to reload.
 */
export function sidecarServing(workspace: string, sidecar: DevSidecar): Promise<boolean> {
  return proxyServing(sidecarProxyUrl(workspace, sidecar));
}

/**
 * Whether a sidecar is up and answering: both halves, because neither alone is the answer.
 *
 * The Deployment is asked about first, and it is not redundant. A sidecar that has never been
 * started has no Service either, and the apiserver's proxy answers a missing Service with a 404,
 * which serving deliberately counts as "answering" — a 404 from a running app is the app talking.
 * So without this, a browser nobody has started would read as up.
 */
export async function sidecarReady(workspace: string, sidecar: DevSidecar): Promise<boolean> {
  const namespace = workspaceNamespace(workspace);
  const url = `${ BASE }/v1/apps.deployments/${ namespace }/${ sidecarName(workspace, sidecar.id) }`;
  const deployment = await devFetch(url).catch(() => null);

  if (!deployment?.status?.readyReplicas) {
    return false;
  }

  return sidecarServing(workspace, sidecar);
}

async function proxyServing(url: string): Promise<boolean> {
  try {
    const resp = await fetch(url, { cache: 'no-store' });

    return ![502, 503, 504].includes(resp.status);
  } catch {
    // A network-level failure, which here means the request never reached Rancher.
    return false;
  }
}

/**
 * WebSocket URL for running a command in a pod, on a TTY.
 *
 * This is the Kubernetes exec subresource, the same one the dashboard's own container shell
 * uses, so it carries the browser's Rancher session and needs nothing else to authenticate.
 * The protocol is `base64.channel.k8s.io`: every frame is a channel digit (0 stdin, 1 stdout,
 * 2 stderr, 3 error, 4 resize) followed by base64.
 */
export function podExecUrl(namespace: string, pod: string, container: string, command: string[], tty = true): string {
  const origin = window.location.origin.replace(/^http/, 'ws');
  const params = new URLSearchParams({
    container,
    stdin:  tty ? '1' : '0',
    stdout: '1',
    stderr: '1',
    tty:    tty ? '1' : '0',
  });

  // Repeated, not comma-joined: this is argv.
  for (const arg of command) {
    params.append('command', arg);
  }

  return `${ origin }${ BASE }/api/v1/namespaces/${ namespace }/pods/${ pod }/exec?${ params }`;
}

/**
 * Run one command in a pod and wait for it to finish, with nobody watching the output.
 *
 * The same exec subresource the terminals use, without the TTY and without a component around
 * it: what this is for is the housekeeping a terminal cannot do for itself, which today is
 * killing the tmux session behind a conversation that has been deleted.
 *
 * It resolves rather than rejects on failure. Every caller is tidying up after something the
 * person has already done, and there is nothing useful to say to them about a pod that has gone
 * away in the meantime — the session went with it.
 */
export function podExecOnce(namespace: string, pod: string, container: string, command: string[]): Promise<string> {
  return new Promise((resolve) => {
    let out = '';

    try {
      const socket = new WebSocket(podExecUrl(namespace, pod, container, command, false), 'base64.channel.k8s.io');

      // Every frame is a channel digit then base64. 1 is stdout, which is the only one a caller
      // has asked about so far; 2 is stderr and 3 is the apiserver's own status, and a command
      // that writes to either has nothing to say to a caller that only wanted its output.
      socket.onmessage = (event) => {
        const frame = String(event.data || '');

        if (frame.startsWith('1')) {
          try {
            out += atob(frame.slice(1));
          } catch { /* a frame that is not base64 is not output */ }
        }
      };

      socket.onclose = () => resolve(out);
      socket.onerror = () => resolve(out);
    } catch {
      resolve(out);
    }
  });
}

/**
 * What a workspace's conversation runs, which is the same thing the dev server pod's tabs run.
 *
 * It was a bare shell, and that was not a design: nothing installed claude into a workspace and
 * nothing shared a login with one, so the tab landed in `sh` and said so. Both halves are now
 * the workspace's own — the scripts are mounted at /seed (ensureWorkspaceTerminal) and the
 * template installs claude on boot — so this is `shell.sh`, exactly as the dev pod calls it:
 * tmux, so a conversation outlives the browser tab, then claude in a loop.
 *
 * The three arguments are the session, the directory, and the home:
 *
 *   - the session names the tmux session, so conversation 2 is a different pane from
 *     conversation 1 and both survive a page reload.
 *   - the directory is the checkout, because that is the thing a workspace exists to work on.
 *     The dev pod gives each of its global terminals a directory of its own instead, since
 *     claude keys its history by working directory and those sessions have nothing in common;
 *     here they do, and a second conversation continuing the first one's history in the same
 *     repository is the behaviour to want rather than one to design around.
 *   - the home is on the workspace's own hostPath, so a login survives a restart.
 */
export function workspaceTerminalCommand(session: string | number): string[] {
  return ['/bin/sh', `${ WORKSPACE_TERMINAL_MOUNT }/shell.sh`, workspaceSession(session), WORKSPACE_WORKDIR, WORKSPACE_HOME];
}

/**
 * A command, run as the user the workspace's conversations belong to.
 *
 * The exec subresource runs as the container's user, which is root, and tmux is not a service:
 * its server is a socket under /tmp owned by whoever started it, and the panes were started as
 * the node user (see shell.sh). So `tmux ls` as root finds no server and answers that a workspace
 * with two conversations in it has none. The same drop shell.sh does, for the same reason.
 */
function asWorkspaceUser(command: string): string[] {
  return ['/bin/sh', '-c', `if [ "$(id -u)" = 0 ]; then setpriv --reuid=1000 --regid=1000 --init-groups /bin/sh -c '${ command }'; else /bin/sh -c '${ command }'; fi`];
}

/** The tmux session one conversation is, named the same way in both places that need it. */
function workspaceSession(session: string | number): string {
  return `ws-${ session }`;
}

/**
 * The conversations a workspace actually has, which is what its pod says rather than what this
 * page last remembered.
 *
 * A conversation is a tmux session, so it outlives the browser tab that made it. The list used to
 * be component state that started at one row on every load, which meant a reload lost every
 * conversation but the first: they carried on in the pod with claude in them, invisible, and the
 * delete on a row had nothing to act on. So the pod is asked.
 *
 * Nothing yet, a pod with no tmux, and a pod that has gone away all answer the same way here, and
 * the caller shows one conversation, which is what a workspace nobody has opened has.
 */
export async function listWorkspaceConversations(name: string): Promise<number[]> {
  const namespace = workspaceNamespace(name);
  const pod = await workspacePod(name);

  if (!pod) {
    return [];
  }

  const out = await podExecOnce(namespace, pod, WORKSPACE_CONTAINER, asWorkspaceUser(
    'tmux ls -F "#{session_name}" 2>/dev/null || true',
  ));

  // `mc-ws-2` is conversation 2. The prefix is shell.sh's (`mc-$SESSION`) and the `ws-` is
  // workspaceSession's, so a global terminal's session in some other pod could never be read as
  // one of these even if it were listed here.
  const numbers = out.split('\n')
    .map((line) => /^mc-ws-(\d+)$/.exec(line.trim())?.[1])
    .filter((found): found is string => !!found)
    .map(Number);

  return [...new Set(numbers)].sort((a, b) => a - b);
}

/**
 * End a conversation in the pod, not only in the browser.
 *
 * Closing the pane closes a socket, and tmux is the whole reason that is not enough: the session
 * carries on in the pod with claude in it, and creating a conversation with the same number
 * later would reattach to it. So a deleted conversation is one whose session is killed, which is
 * what makes the delete on its row mean what the delete on a workspace's row means.
 */
export async function deleteWorkspaceConversation(name: string, session: string | number): Promise<void> {
  const namespace = workspaceNamespace(name);
  // The workspace's own pod, not one of its sidecars: they are in the same namespace and carry
  // the same label, and none of them has the session to kill. See findPod.
  const pod = await workspacePod(name);

  if (!pod) {
    return;
  }

  // `|| true` so a session that was never started, or a pod with no tmux in it yet, is a command
  // that succeeds at doing nothing rather than an error nobody is listening for.
  await podExecOnce(namespace, pod, WORKSPACE_CONTAINER, asWorkspaceUser(
    `tmux kill-session -t mc-${ workspaceSession(session) } 2>/dev/null || true`,
  ));
}

/** WebSocket URL for a conversation in a workspace's pod. */
export function workspaceShellUrl(name: string, pod: string): string {
  return podExecUrl(workspaceNamespace(name), pod, WORKSPACE_CONTAINER, workspaceTerminalCommand(1));
}
