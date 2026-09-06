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
import { WORKSPACE_VUE_CONFIG, WORKSPACE_CONFIG_MOUNT } from './workspace-config';
import { INSIGHTS_SERVER } from './insights-server';
import { WORKSPACE_API_SERVER } from './workspace-api';
import { AGENT_SEED } from './agent-seed.generated';
import {
  createWorkspaceInstance, deleteWorkspaceInstance, appById
} from './apps';
import {
  DEV_POD_NAMESPACE as POD_NAMESPACE, DEV_POD_SERVICE as POD_SERVICE,
  LABEL_WORKSPACE, LABEL_APP, LABEL_CLUSTER, WORKSPACE_WORKDIR, WORKSPACE_HOME, WORKSPACE_QUEUE,
  WORKSPACE_PORT_ANNOTATION, WORKSPACE_SCHEME_ANNOTATION, DEFAULT_WORKSPACE_PORT, DEFAULT_WORKSPACE_SCHEME, PREVIEW_ANNOTATION,
} from './config/constants';

// The labels live in config/constants now, beside the Apps Plus names that use them; re-exported
// so the components that always imported them from here keep working.
export { LABEL_WORKSPACE, LABEL_APP, LABEL_CLUSTER };


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


/** One cluster this Rancher manages, with enough of its capacity to choose between them. */
export type ClusterHealth = 'ok' | 'warn' | 'error';

export interface DevCluster {
  id: string;
  name: string;
  state: string;
  /** The worst state of anything on it: Rancher's own per-resource state, over nodes and pods. */
  health: ClusterHealth;
  /** What is wrong, one line each, worst first; empty when healthy. */
  issues: string[];
  /** Bytes not asked for by anything, or 0 where the cluster does not say. */
  memoryFree: number;
  /** What the cluster has in all, so what is free can be drawn as a share of it. */
  memoryTotal: number;
  diskFree: number;
  diskTotal: number;
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
/**
 * What one node has free right now, from its kubelet.
 *
 * The stats summary is the one place both numbers are actually measured: memory available to new
 * work and the bytes left on the node's filesystem, sampled every ten seconds or so. Rancher's own
 * `allocatable - requested` is what pods have *asked* for, which changes when a pod is scheduled
 * and at no other time - a sidebar drawn from it sat still while a build filled the disk.
 */
async function nodeLive(cluster: string, node: string): Promise<{ memory: number; memoryTotal: number; disk: number; diskTotal: number } | null> {
  // Bounded: a kubelet the proxy cannot reach answers in minutes, and a sidebar that waits on
  // it would show nothing for that long. Past a few seconds the requests-based figures stand in.
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 5000);
  const summary = await devFetch(`${ clusterBase(cluster) }/api/v1/nodes/${ node }/proxy/stats/summary`, { signal: abort.signal }).catch(() => null).finally(() => clearTimeout(timer));
  const memory = Number(summary?.node?.memory?.availableBytes);
  const disk = Number(summary?.node?.fs?.availableBytes);
  // What the node has in all: the kubelet says so for the disk; for memory it is what is in use
  // plus what is available, which is the same number the node's capacity reports.
  const memoryTotal = Number(summary?.node?.memory?.workingSetBytes) + memory;
  const diskTotal = Number(summary?.node?.fs?.capacityBytes);

  return Number.isFinite(memory) && Number.isFinite(disk) ? {
    memory, disk, memoryTotal: Number.isFinite(memoryTotal) ? memoryTotal : 0, diskTotal: Number.isFinite(diskTotal) ? diskTotal : 0,
  } : null;
}

/** The active clusters, with nothing measured: what the workspace list needs, and no wait. */
export async function listClusterIds(): Promise<string[]> {
  const response = await devFetch('/v3/clusters').catch(() => null);

  return (response?.data || []).filter((cluster: Json) => cluster.state === 'active').map((cluster: Json) => cluster.id);
}

export async function listClusters(): Promise<DevCluster[]> {
  const response = await devFetch('/v3/clusters').catch(() => null);
  const clusters = (response?.data || []).filter((cluster: Json) => cluster.state === 'active');

  return Promise.all(clusters.map(async(cluster: Json) => {
    const [nodes, pods] = await Promise.all([
      devFetch(`${ clusterBase(cluster.id) }/v1/nodes`).catch(() => null),
      devFetch(`${ clusterBase(cluster.id) }/v1/pods`).catch(() => null),
    ]);

    const { health, issues } = clusterHealth(cluster, nodes?.data || [], pods?.data || []);

    // Measured first; the requests-based figures below are the fallback for a cluster whose
    // kubelets cannot be asked through the proxy.
    const live = await Promise.all((nodes?.data || []).map((node: Json) => nodeLive(cluster.id, node.metadata?.name)));

    if (live.length && live.every(Boolean)) {
      const sum = (key: 'memory' | 'memoryTotal' | 'disk' | 'diskTotal') => live.reduce((total, node) => total + (node as Record<string, number>)[key], 0);

      return {
        id:          cluster.id,
        name:        cluster.name || cluster.id,
        state:       cluster.state,
        health,
        issues,
        memoryFree:  sum('memory'),
        memoryTotal: sum('memoryTotal'),
        diskFree:    sum('disk'),
        diskTotal:   sum('diskTotal'),
      };
    }

    const memoryFree = Math.max(0, bytes(cluster.allocatable?.memory) - bytes(cluster.requested?.memory));

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
      id:          cluster.id,
      name:        cluster.name || cluster.id,
      state:       cluster.state,
      health,
      issues,
      memoryFree,
      memoryTotal: bytes(cluster.allocatable?.memory),
      diskFree:    Math.max(0, allocatable - requested),
      diskTotal:   allocatable,
    };
  }));
}

/**
 * The worst of everything on a cluster, in Rancher's own terms: steve puts a `metadata.state`
 * on every resource (error, transitioning, a name and a message), which is what the
 * dashboard's own lists colour rows by. Nodes and pods cover what a person means by "is the
 * cluster all right": a pod in CrashLoopBackOff or stuck initialising is red, one still
 * starting is yellow, a node with pressure is yellow and one that is not Ready is red; a
 * cluster Rancher itself calls transitioning is yellow. Finished pods are finished, not amber.
 */
function clusterHealth(cluster: Json, nodes: Json[], pods: Json[]): { health: ClusterHealth; issues: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const note = (state: Json) => (state?.message || state?.name || 'not ready').replace(/\s+/g, ' ').slice(0, 120);

  if (cluster.transitioning === 'yes' || (cluster.state && cluster.state !== 'active')) {
    warnings.push(`cluster ${ cluster.state }: ${ cluster.transitioningMessage || '' }`.replace(/: $/, ''));
  }
  for (const node of nodes) {
    const state = node.metadata?.state;

    if (state?.error) {
      errors.push(`node ${ node.metadata?.name }: ${ note(state) }`);
    } else if (state?.transitioning) {
      warnings.push(`node ${ node.metadata?.name }: ${ note(state) }`);
    }
  }
  for (const pod of pods) {
    // A Job's pods are the Job's business, and Rancher's helm-operation pods (made directly,
    // no Job) pile up by the hundred, finished or failed: a cluster is not amber for a chore
    // that ended.
    if ((pod.metadata?.ownerReferences || []).some((owner: Json) => owner.kind === 'Job') || /^helm-operation-/.test(pod.metadata?.name || '')) {
      continue;
    }
    const state = pod.metadata?.state;
    const where = `${ pod.metadata?.namespace }/${ pod.metadata?.name }`;

    if (state?.error) {
      errors.push(`${ where }: ${ note(state) }`);
    } else if (state?.transitioning && state.name !== 'completed') {
      warnings.push(`${ where }: ${ note(state) }`);
    }
  }

  return {
    health: errors.length ? 'error' : warnings.length ? 'warn' : 'ok',
    issues: [...errors, ...warnings],
  };
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
  /** The Apps Plus App it is an installation of. Kept even when that App no longer exists. */
  app: string;
  /** What it serves, and how to speak to it. From the namespace's annotations; see constants. */
  port: number;
  scheme: string;
  /** A static preview (see apps.ts): a build to look at, with no shell, ports or conversations of its own. */
  preview: boolean;
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
// The Vuex store, for the calls that go through Apps Plus's models. See apps.ts.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Store = any;

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
  const annotations = namespace.metadata.annotations || {};
  const port = Number(annotations[WORKSPACE_PORT_ANNOTATION]) || DEFAULT_WORKSPACE_PORT;

  return {
    name,
    namespace:     namespace.metadata.name,
    // The label where there is one, and the cluster it was read from otherwise: a workspace made
    // before this product could host them anywhere is in the cluster it is being listed from.
    cluster:       namespace.metadata.labels[LABEL_CLUSTER] || cluster || activeCluster(),
    app:           namespace.metadata.labels[LABEL_APP] || '',
    port,
    scheme:        annotations[WORKSPACE_SCHEME_ANNOTATION] === 'https' ? 'https' : DEFAULT_WORKSPACE_SCHEME,
    preview:       annotations[PREVIEW_ANNOTATION] === 'true',
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

  return labels[LABEL_WORKSPACE] === name;
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
  const clusters = await listClusterIds().catch(() => [] as string[]);
  const lists = await Promise.all(
    (clusters.length ? clusters : [activeCluster()])
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
export async function createWorkspace(store: Store, name: string, appId: string, cluster?: string, values: Record<string, unknown> = {}): Promise<void> {
  if (cluster) {
    setCluster(cluster);
  }

  const app = await appById(store, appId);

  if (!app) {
    throw new Error(`There is no Apps Plus app called "${ appId }". Templates are Apps Plus apps; make one there first.`);
  }

  const conflict = await workspaceNameConflict(name);

  if (conflict) {
    throw new Error(conflict);
  }

  // The Installation is the workspace. Apps Plus renders the App's templates into a Fleet
  // Bundle when it is saved, and Fleet makes the namespace, the Deployment and the Service on
  // the cluster - so from here on this file only reads them back.
  await createWorkspaceInstance(store, name, appId, activeCluster(), values);

  // What no App can render, because it is not the App's: the terminal scripts copied from this
  // pod's own seed, and the RoleBinding that lets the workspace read the shared claude
  // credentials. Both wait for Fleet to have made the namespace first.
  await afterWorkspaceCreated(name);
}

/**
 * The parts of a workspace that belong to this product rather than to its App.
 *
 * Retried for as long as Fleet reasonably takes to apply a Bundle: the namespace is the App's
 * to make, and until it exists there is nowhere to put these. A workspace whose namespace
 * never comes is a Bundle that failed, which the list says in its own words.
 */
async function afterWorkspaceCreated(name: string): Promise<void> {
  const namespace = workspaceNamespace(name);

  for (let attempt = 0; attempt < 30; attempt++) {
    const exists = await devFetch(`${ BASE }/v1/namespaces/${ namespace }`).catch(() => null);

    if (exists) {
      await ensureWorkspaceRbac(name);
      await ensureWorkspaceTerminal(name);

      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
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
    // Written on every start rather than only at create: a workspace made by the in-cluster API,
    // or by hand in Apps Plus, has an App's objects and none of this product's.
    await ensureWorkspaceRbac(name);
    await ensureWorkspaceTerminal(name);
  }

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
 * Delete the namespace, which takes the Deployment, the Service and the pod with it.
 *
 * The one thing the namespace does not take is the RoleBinding that let this workspace read the
 * shared credentials, since that lives in the product's own namespace. It is deleted here so a
 * deleted workspace leaves nothing behind that names it.
 */
export async function deleteWorkspace(store: Store, name: string): Promise<void> {
  const namespace = workspaceNamespace(name);
  const binding = `creds-${ WORKSPACE_SERVICE_ACCOUNT }-${ namespace }`;

  // The Installation takes its Bundle with it, and the Bundle takes the namespace and everything
  // in it. What is left is this product's own: the credentials binding, which lives in
  // dev-system rather than in the namespace, and the Installation record itself.
  await deleteWorkspaceInstance(store, name);
  await devFetch(`${ BASE }/v1/rbac.authorization.k8s.io.rolebindings/${ DEV_SYSTEM_NAMESPACE }/${ binding }`, { method: 'DELETE' }).catch(() => null);
}

/** How to speak to what a workspace serves. */
export function workspaceScheme(workspace: DevWorkspace | null | undefined): string {
  return workspace?.scheme === 'https' ? 'https' : DEFAULT_WORKSPACE_SCHEME;
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
export async function findPod(namespace: string, labels: Record<string, string>, own?: string, base = BASE): Promise<string | null> {
  const pods = await devFetch(`${ base }/v1/pods/${ namespace }`).catch(() => null);

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


/** Where a pod reaches it, which is what an action inside a workspace is given. */
export function workspaceApiUrl(): string {
  return `http://${ API_NAME }.${ DEV_SYSTEM_NAMESPACE }.svc:${ API_PORT }`;
}


/**
 * Create the service if it is not there, and keep its script and its templates current.
 *
 * Quiet, like everything else this extension puts in the cluster: it runs on load for every user
 * including ones who cannot create any of it, and a page that threw here would be a page that
 * never rendered for them.
 */
/**
 * Where Extension Studio's agent pod keeps its workspace on the node, and where this API mounts
 * it. The path is the Studio's (agent.ts, AGENT_HOST_PATH); the two have to agree, and the API
 * serves nothing from it but files a comment names.
 */
export const AGENT_WORKSPACE_HOST_PATH = '/var/lib/rancher/extension-studio/agent';
export const AGENT_WORKSPACE_MOUNT = '/agent-workspace';

/**
 * Where every workspace keeps its /workspace on the node (the rancher-dev App's hostPath, one
 * directory per workspace), and where the API mounts the lot. A review agent's evidence is
 * under `<workspace>/artifacts`, and the API serves a comment's attachment from there.
 */
export const WORKSPACES_HOST_PATH = '/var/lib/rancher/dev-workspaces';
export const WORKSPACES_MOUNT = '/dev-workspaces';

/** gzip, then base64, in the browser: what a ConfigMap can carry a megabyte of skills as. */
async function gzipBase64(text: string): Promise<string> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
  const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  let binary = '';

  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }

  return btoa(binary);
}

export async function ensureWorkspaceApi(): Promise<void> {
  const namespace = DEV_SYSTEM_NAMESPACE;
  const labels = { app: API_NAME };

  // The script, rewritten whenever it differs, so an edit in this repo reaches a service that
  // already exists. It carries no templates of its own any more: those are Apps Plus apps, which
  // it reads from the cluster when asked.
  for (const [name, data] of [
    // The agent seed rides along: the skills a review or fix agent needs, which the API serves
    // to the agent pod as one document (see workspace-tools.ts for why not exec).
    // Gzipped: the seed is the harness's whole skill set, which is close to a ConfigMap's
    // megabyte on its own, and the script rides in the same one.
    [API_NAME, { 'server.mjs': WORKSPACE_API_SERVER, 'seed.json.gz.b64': await gzipBase64(JSON.stringify(AGENT_SEED)) }],
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
      // node read the old script at start: the pod is replaced, and the new one mounts the
      // ConfigMap as it is now. Quiet like the rest; a user who may not do this changes nothing.
      const pods = await devFetch(`${ BASE }/v1/pods/${ namespace }?labelSelector=app%3D${ API_NAME }`).catch(() => null);

      for (const pod of pods?.data || []) {
        await devFetch(`${ BASE }/v1/pods/${ namespace }/${ pod.metadata.name }`, { method: 'DELETE' }).catch(() => null);
      }
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
      // Templates are Apps Plus apps and a workspace is an Installation of one, so this is what
      // the API reads and writes. The objects an App renders are Fleet's to make, not the API's.
      {
        apiGroups: ['appsplus.io'], resources: ['apps'], verbs: ['get', 'list']
      },
      {
        apiGroups: ['appsplus.io'], resources: ['appinstances'], verbs: ['get', 'list', 'create']
      },
      // The review store: a ConfigMap per pull request in dev-system, which the API reads and
      // writes for the agents and the browser both. And the GitHub token, which is in the
      // per-person secret store beside it: the API acts on GitHub as the one person this
      // Rancher's harness belongs to.
      {
        apiGroups: [''], resources: ['configmaps'], verbs: ['get', 'list', 'create', 'update', 'patch', 'delete']
      },
      { apiGroups: [''], resources: ['secrets'], verbs: ['get', 'list'] },
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
              // The Studio's agent pod keeps its workspace on this hostPath. Mounted here, read
              // only, so the evidence a review agent attaches to a comment - a recording, a
              // screenshot under /workspace/artifacts - can be served to the review panel.
              { name: 'agent-workspace', mountPath: AGENT_WORKSPACE_MOUNT, readOnly: true },
              { name: 'workspaces', mountPath: WORKSPACES_MOUNT, readOnly: true },
            ],
            readinessProbe: { httpGet: { path: '/', port: API_PORT }, periodSeconds: 10 },
          }],
          volumes: [
            { name: 'seed', configMap: { name: API_NAME } },
            { name: 'agent-workspace', hostPath: { path: AGENT_WORKSPACE_HOST_PATH, type: 'DirectoryOrCreate' } },
            { name: 'workspaces', hostPath: { path: WORKSPACES_HOST_PATH, type: 'DirectoryOrCreate' } },
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
export function podExecUrl(namespace: string, pod: string, container: string, command: string[], tty = true, base = BASE): string {
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

  return `${ origin }${ base }/api/v1/namespaces/${ namespace }/pods/${ pod }/exec?${ params }`;
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
export function podExecOnce(namespace: string, pod: string, container: string, command: string[], base = BASE): Promise<string> {
  return new Promise((resolve) => {
    let out = '';

    try {
      const socket = new WebSocket(podExecUrl(namespace, pod, container, command, false, base), 'base64.channel.k8s.io');

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
