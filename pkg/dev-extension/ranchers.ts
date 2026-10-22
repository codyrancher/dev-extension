// The Ranchers a workspace can be pointed at, and which of them new ones point at by default.
//
// A workspace's dev server, and a build shared from it, talk to a Rancher: the one this
// dashboard is on, or one of the Rancher installs this cluster runs (the rancher-ha App, one
// per instance). The sidebar lists them the way it lists clusters, and the starred one is what
// a workspace made from My Work or the Create page is pointed at when nobody says otherwise.
// Kept per person, beside the other preferences (prefs.ts).

import { devFetch, clusterBase, cloudCredentialsManifest, secretValue, DEV_SYSTEM_NAMESPACE } from './api';
import { APP_INSTANCE } from './config/constants';
import { AGENT_NS, AGENT_BASE } from './pod';
import { readPrefs, savePrefs } from './prefs';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Store = any;

/** The App whose instances are Rancher servers. */
export const RANCHER_HA_APP = 'rancher-ha';

export type RancherPhase = 'host' | 'created' | 'provisioning' | 'installing' | 'ready' | 'error' | 'removing';

export interface RancherTarget {
  id: string;
  name: string;
  /** Where it is reached; '' until Rancher answers there. */
  url: string;
  kind: 'host' | 'instance';
  /** How far along a new one is; `host` for the Rancher this dashboard is on. */
  phase: RancherPhase;
  /** 0 cluster asked for, 1 node provisioning, 2 Rancher installing, 3 up. */
  step: number;
  /** What it is doing now, in a few words; '' once it is up. */
  detail: string;
  /** When the instance was made (ISO), for an elapsed time beside the progress; '' for the host. */
  since: string;
  /** The management id of its cluster, once there is one: what its API is read by. */
  clusterId?: string;
  /** Its node's public address, once it is up: what a preview's sslip name carries. */
  nodeIp?: string;
}

/** The four steps a new Rancher goes through, in order, for a tooltip. */
export const RANCHER_STEPS = ['cluster asked for', 'node provisioning', 'Rancher installing', 'up'];

/**
 * This Rancher first, then every instance with where it has got to: the cluster Apps Plus
 * provisions for it (its state and Rancher's own words about it, from /v3/clusters), then the
 * Rancher chart the bundle installs on that cluster, then the address once Rancher answers
 * there, `<name>.dev-extension.<node ip>.sslip.io`.
 */
/**
 * The Ranchers made directly on EC2, which is the other way of having one.
 *
 * `seed/agent/rancher-ec2.mjs` launches an instance whose user-data runs `rancher/rancher` in
 * docker - three moving parts instead of the seven an Apps Plus instance needs, and no cluster
 * registered with this Rancher, so none of the agent-tunnel failure that has dogged those.
 *
 * A browser cannot call EC2, so the tool keeps a record where the browser can read it: one
 * ConfigMap in dev-system, rewritten on every create, delete and sync. This reads it and
 * nothing else - if the record is stale the list is stale, which is why the tool rewrites it
 * rather than anything here polling AWS.
 *
 * `clusterId` is deliberately absent. These are not clusters of this Rancher's, so nothing
 * that needs to reach one through the parent's proxy - Fleet delivery, and therefore shares -
 * can use them yet, and `pickShareHost` requires a clusterId so it will not pick one by
 * accident. Listing them is what this does; making them share hosts is a separate piece of
 * work with its own delivery path.
 */
async function ec2Ranchers(): Promise<RancherTarget[]> {
  const cm = await devFetch(`${ clusterBase('local') }/v1/configmaps/${ DEV_SYSTEM_NAMESPACE }/dev-rancher-ec2`).catch(() => null);

  try {
    const doc = JSON.parse(cm?.data?.['instances.json'] || '{}');

    return (doc.instances || []).map((i: Json): RancherTarget => ({
      id:     `ec2:${ i.name }`,
      name:   i.name,
      url:    i.url || '',
      kind:   'instance',
      // `running` is the instance, not Rancher - the box can be up a few minutes before the
      // container answers - so it reads as installing until there is an address to go to.
      phase:  i.state === 'running' && i.url ? 'ready' : (i.state === 'running' ? 'installing' : 'created'),
      step:   i.state === 'running' && i.url ? 3 : 1,
      detail: i.state === 'running' ? '' : `EC2 instance ${ i.state }`,
      since:  doc.at || '',
      nodeIp: i.ip || '',
    }));
  } catch {
    return [];
  }
}

export async function listRanchers(store: Store): Promise<RancherTarget[]> {
  const out: RancherTarget[] = [{
    // Its own address, not the page's: read through a share, the origin is the share's name.
    id: 'host', name: 'This Rancher', url: await ownRancherUrl(store), kind: 'host', phase: 'host', step: 3, detail: 'the Rancher this dashboard is on', since: '',
  }];
  const instances: Json[] = await store.dispatch('management/findAll', { type: APP_INSTANCE }).catch(() => []);
  const ranchers = instances.filter((instance) => [RANCHER_HA_APP, RANCHER_SINGLE_APP].includes(instance.spec?.app));

  if (!ranchers.length) {
    return out;
  }

  const [clusters, bundles, machines] = await Promise.all([
    devFetch('/v3/clusters').then((r: Json) => r?.data || []).catch(() => []) as Promise<Json[]>,
    store.dispatch('management/findAll', { type: 'fleet.cattle.io.bundle' }).catch(() => []) as Promise<Json[]>,
    // The CAPI machines the parent owns for its provisioning-and-cleanup link. Read here rather
    // than from each instance's downstream, because the parent's view of an instance's cluster
    // cannot be relied on - so this is the one view of the node that is readable whatever the
    // cluster agent is doing.
    //
    // It used to say the agent disconnecting was "expected, not a fault". It is a fault, it was
    // always a fault, and saying otherwise here is most of why it went unfixed for weeks. See
    // the Service note in apps-rancher.ts 30-service.yaml: with no `cattle-system/rancher`
    // Service the parent's agent started a second Rancher inside itself and died doing it,
    // every five minutes, on every instance ever built.
    devFetch('/v1/cluster.x-k8s.io.machines').then((r: Json) => r?.data || []).catch(() => []) as Promise<Json[]>,
  ]);

  for (const instance of ranchers) {
    const name = instance.metadata?.name;
    const cluster = clusters.find((c) => c.name === name || c.id === name);
    const bundle = bundles.find((b) => b.metadata?.name === `apps-plus-${ name }`);
    const machine = machines.find((m) => m.metadata?.labels?.['cluster.x-k8s.io/cluster-name'] === name);

    if (instance.metadata?.deletionTimestamp) {
      out.push({
        id: `instance:${ name }`, name, url: '', kind: 'instance', phase: 'removing', step: 0, detail: 'Removing, with its cluster and node', since: instance.metadata.deletionTimestamp,
      });
      continue;
    }
    out.push(await instanceTarget(name, instance.metadata?.creationTimestamp || '', cluster, bundle, machine));
  }

  // And the ones made directly on EC2, which have no Installation to be found by the loop
  // above. A name already listed wins: an Apps Plus instance and an EC2 record of the same
  // name is somebody's migration in progress, and the richer entry is the one to show.
  const taken = new Set(out.map((r) => r.name));

  for (const extra of await ec2Ranchers()) {
    if (!taken.has(extra.name)) {
      out.push(extra);
    }
  }

  return out;
}

async function instanceTarget(name: string, since: string, cluster: Json | undefined, bundle: Json | undefined, machine: Json | undefined): Promise<RancherTarget> {
  const base = {
    id: `instance:${ name }`, name, url: '', kind: 'instance' as const, since,
  };
  const bundleState: string = bundle?.status?.display?.state || '';
  const bundleMessage: string = bundle?.status?.display?.message || '';

  // The node, from the CAPI machine the parent owns, which is readable whatever the cluster
  // agent is doing - and that is the only reason this reads the machine rather than the cluster.
  //
  // What this comment used to claim - that an instance's own Rancher "takes over its cluster and
  // drops the parent's cluster agent", expected, not a fault - is false, and was the reason
  // nobody looked. The parent's agent keeps owning fleet-agent and keeps reporting; it was dying
  // because it could not find a `cattle-system/rancher` Service and started a second Rancher
  // inside its own process. A disconnected cluster agent on one of these instances is a fault
  // and is worth investigating.
  const machineAddrs: Json[] = machine?.status?.addresses || [];
  /*
   * The public address is the only one that makes a working address, and the fallback to the
   * private one is for progress reporting alone.
   *
   * `<name>.dev-extension.<ip>.sslip.io` resolves to whatever IP is in it, so an instance
   * reported ready on a 10.x address hands back a URL that resolves to a private range and
   * answers nowhere - up, green and unreachable, which is the worst of the three states to be
   * shown. A node that has registered but has no ExternalIP yet is still provisioning as far as
   * anything that wants to reach it is concerned, so that is what it says.
   */
  const machinePublic = machineAddrs.find((a) => a.type === 'ExternalIP')?.address || '';
  const machineIp = machinePublic || machineAddrs.find((a) => a.type === 'InternalIP')?.address || '';
  const nodeUp = machine?.status?.phase === 'Running' && !!machinePublic;

  if (!cluster && !machine) {
    // Apps Plus makes the cluster when a dashboard with it loaded reconciles the instance.
    return {
      ...base, phase: 'created', step: 0, detail: 'Creating the cluster',
    };
  }
  const message = shortenTransition(cluster?.transitioningMessage || '');

  // While the parent still sees the cluster as active its agent is connected, so the proxy is
  // authoritative for whether Rancher itself answers yet: the node can be up a minute or two
  // before the chart's pod is ready, and this is the one path that tells the difference.
  if (cluster?.state === 'active') {
    const [nodes, deployments] = await Promise.all([
      devFetch(`${ clusterBase(cluster.id) }/v1/nodes`).catch(() => null),
      devFetch(`${ clusterBase(cluster.id) }/v1/apps.deployments/cattle-system`).catch(() => null),
    ]);
    const addresses: Json[] = (nodes?.data || []).flatMap((node: Json) => node.status?.addresses || []);
    // Same rule as the machine's above: only a public address can carry the instance's URL, and
    // the private one is reported as progress rather than as a place to go.
    const publicAddress = addresses.find((a) => a.type === 'ExternalIP')?.address || machinePublic;
    const address = publicAddress || addresses.find((a) => a.type === 'InternalIP')?.address || machineIp;
    // The chart's release is named for the instance, so its Deployment is `<name>-rancher`
    // (`ha-rancher`); a Rancher installed by hand is plain `rancher`.
    const deployment: Json = (deployments?.data || []).find((d: Json) => [`${ name }-rancher`, 'rancher'].includes(d.metadata?.name)) || null;
    const ready = (deployment?.status?.readyReplicas || 0) > 0;

    if (ready && publicAddress) {
      return {
        ...base, phase: 'ready', step: 3, detail: '', url: rancherAddress(name, publicAddress), clusterId: cluster.id, nodeIp: publicAddress,
      };
    }
    if (/^Err/.test(bundleState)) {
      return {
        ...base, phase: 'error', step: 2, detail: shortenTransition(bundleMessage) || 'Installing Rancher failed',
      };
    }

    // The node's address is carried even while Rancher is still installing, because the host
    // it implies has to be written onto the instance before Rancher first starts rather than
    // after: the address is what server-url and the certificate are made from, and a Rancher
    // that came up without them has already told every agent it issues to call home to
    // nowhere. See ensureRancherHosts.
    return {
      ...base, phase: 'installing', step: 2, detail: deployment ? 'Rancher is starting' : 'Installing Rancher', clusterId: cluster.id, nodeIp: address,
    };
  }

  // The parent's link to the downstream is degraded or gone. A real failure to install Rancher
  // still surfaces; but a running node with the install applied is an instance that is up, and
  // the parent no longer being able to reach it is exactly what that looks like from here - so
  // the node, not the parent's view, decides.
  if (/^Err/.test(bundleState)) {
    return {
      ...base, phase: 'error', step: 2, detail: shortenTransition(bundleMessage) || 'Installing Rancher failed',
    };
  }
  if (nodeUp) {
    return {
      ...base, phase: 'ready', step: 3, detail: '', url: rancherAddress(name, machineIp), clusterId: cluster?.id || '', nodeIp: machineIp,
    };
  }
  // Provisioning, but the machine already has an address: worth reporting for the same reason
  // as above - the host can be written now, so the install that follows renders with it.
  if (machineIp) {
    return {
      ...base, phase: 'provisioning', step: 1, detail: message || `Provisioning (${ cluster?.state || 'pending' })`, clusterId: cluster?.id || '', nodeIp: machineIp,
    };
  }
  if (cluster && (cluster.state === 'error' || cluster.transitioning === 'error')) {
    return {
      ...base, phase: 'error', step: 1, detail: message || 'Provisioning failed',
    };
  }

  return {
    ...base, phase: 'provisioning', step: 1, detail: message || `Provisioning (${ cluster?.state || 'pending' })`,
  };
}

/**
 * Rancher's transitioning message, cut to the part a person wants: after the last "thing:"
 * prefix, the first clause. "configuring bootstrap node(s) otter-pool1-x: Waiting for Cluster
 * control plane to be initialized, waiting for …" becomes "Waiting for Cluster control plane
 * to be initialized".
 */
function shortenTransition(message: string): string {
  const tail = message.split(': ').pop() || message;
  const clause = tail.split(/[,;]/)[0].trim();

  return clause.length > 72 ? `${ clause.slice(0, 70) }…` : clause;
}

/** The App a new Rancher is made from: one EC2 node, GitHub login, an sslip address. */
export const RANCHER_SINGLE_APP = 'rancher-single';

/**
 * The node a new Rancher gets: 16 GB of memory and a 100 GB root, up from Apps Plus's default
 * of `c5d.xlarge` (8 GB) and 50 GB (see apps-plus cluster-template.ts). Rancher, a Kubernetes
 * node and a dashboard build sharing one machine want the headroom - a node that runs out of
 * memory or disk comes up wedged rather than merely slow, which is worse to diagnose than to
 * pay for. `c5d.2xlarge` keeps the same instance family as the default, so the AMI, the NVMe
 * root and the driver behaviour are unchanged; only the size grows.
 *
 * `kubernetesVersion` overrides the template's RKE2 default (v1.34.4+rke2r1) with K3s. Each
 * instance is its own standalone Rancher and never a manager of downstream clusters, so it does
 * not need RKE2's heavier control plane - K3s runs the apiserver, etcd, controller-manager,
 * scheduler and CNI as one bundled process instead of five static pods, which on this single
 * node reclaims the better part of a gigabyte of memory (and smaller images) for the same work.
 * v1.36.4+k3s1 is this Rancher's own default K3s release (the k3s-default-version setting).
 *
 * These are passed as the installation's values, which override the cluster template's defaults;
 * everything not named here (region, VPC, subnet, credential) keeps its default.
 */
export const RANCHER_INSTANCE_VALUES: Record<string, string> = {
  instanceType:      'c5d.2xlarge',
  rootSize:          '100',
  kubernetesVersion: 'v1.36.4+k3s1',
};

/**
 * Where an instance is reached: `<name>.dev-extension.<node ip>.sslip.io`. The shape is the
 * App's (its 60-github-auth.yaml): sslip.io resolves any name with an IP in it, the ingress
 * serves every host, and the GitHub app shared with this Rancher takes that exact URL's
 * /verify-auth as one of its ten callbacks - which is the one thing left to do by hand once
 * the node is up.
 */
export function rancherAddress(name: string, nodeIp: string): string {
  return `https://${ name }.dev-extension.${ nodeIp }.sslip.io`;
}

/**
 * Tell a Rancher what it is called, once there is an address to work it out from.
 *
 * Its Ingress carries no host - that is what makes the node's address a working address with no
 * DNS to arrange - and a rule with no host is a rule with nothing to put on a certificate. So a
 * second rule names it, and the name can only be filled in here: the node does not exist when
 * the instance is created, so nothing knew the address to make it from.
 *
 * Written once. Thereafter the value is there, the Ingress has the name, and the cluster's
 * certificate controller does the rest (see certs.ts).
 */
export async function ensureRancherHosts(store: Store, ranchers: RancherTarget[]): Promise<void> {
  /*
   * Any instance whose node has an address, not only one that is up.
   *
   * The host is what the certificate is issued for and what server-url is set to, and both of
   * those want to be true before Rancher's first start rather than after it. Waiting for
   * `ready` meant the opposite: Rancher came up on a bundle rendered with `host: none`, so it
   * had no server-url, and every cluster provisioned from it handed its agents nowhere to call
   * home - which is what "cluster management does not work" turned out to be. It also put the
   * re-render after the instance had taken its cluster over from this Rancher, which is the
   * worst moment to need Fleet to deliver something.
   */
  const wanted = ranchers.filter((rancher) => rancher.kind === 'instance' && rancher.nodeIp);

  if (!wanted.length) {
    return;
  }
  const instances: Json[] = await store.dispatch('management/findAll', { type: APP_INSTANCE }).catch(() => []);

  for (const rancher of wanted) {
    const instance = instances.find((i) => i.metadata?.name === rancher.name && [RANCHER_HA_APP, RANCHER_SINGLE_APP].includes(i.spec?.app));
    const host = rancherAddress(rancher.name, rancher.nodeIp || '').replace(/^https?:\/\//, '');

    if (!instance || String(instance.spec?.values?.host || '') === host) {
      continue;
    }
    instance.spec.values = { ...(instance.spec.values || {}), host };
    await instance.save().catch(() => null);
  }
}

/**
 * Names for new Ranchers, handed out in order: short, pronounceable, DNS-safe, and easy to
 * tell apart in a callback list. Nobody types one; the next unused is taken.
 */
export const CODE_NAMES = [
  'otter', 'heron', 'lynx', 'falcon', 'marten', 'osprey', 'puffin', 'raven', 'sable', 'wren',
  'badger', 'condor', 'egret', 'gannet', 'ibis', 'jackal', 'kestrel', 'lark', 'merlin', 'newt',
];

/** The first code name no instance has yet. */
export async function nextRancherName(store: Store): Promise<string> {
  const instances: Json[] = await store.dispatch('management/findAll', { type: APP_INSTANCE }).catch(() => []);
  const taken = new Set(instances.map((i) => i.metadata?.name));
  const free = CODE_NAMES.find((n) => !taken.has(n));

  if (free) {
    return free;
  }
  let n = 2;

  while (taken.has(`${ CODE_NAMES[0] }-${ n }`)) {
    n++;
  }

  return `${ CODE_NAMES[0] }-${ n }`;
}

/**
 * A new Rancher of your own: an Installation of the single-node App, which provisions its EC2
 * node through this Rancher and installs Rancher on it. The values are the App's defaults; the
 * address is `<name>.<node ip>.sslip.io` once the node is up, and listRanchers shows it.
 */
/**
 * The two values a new instance has to take from the Rancher that is making it, rather than from
 * a literal in this file.
 *
 * `kubernetesVersion`: a pinned string goes stale the moment the managing Rancher updates its
 * own default, and then every instance this product makes is a version behind the clusters a
 * person makes by hand - which was already true here (pinned v1.36.4+k3s1, the parent's
 * `k3s-default-version` reads 1.36.5+k3s1). The setting carries no `v` and provisioning wants
 * one.
 *
 * `githubClientSecret`: the App's default used to BE the secret, written into this repository.
 * The managing Rancher has the same one in the Secret its own GitHub auth reads, and the
 * browser asking for it is the person's own session asking for something they can already see -
 * the same move `cloudCredentialsManifest` makes. Copying it at create time also means a
 * rotation reaches the next instance instead of only the ones made before it.
 *
 * Both fall back to the App's own defaults rather than failing: an instance with a slightly old
 * Kubernetes, or one whose GitHub login has to be filled in by hand, is worth more than no
 * instance at all.
 */
/**
 * The bearer an agent will use for this instance, decided here because here is the only place
 * that can tell the instance and the agent pod the same thing.
 *
 * Rancher's bearer is `<token name>:<secret>`, and the token's name is fixed by the App
 * (`dev-agent`), so choosing the secret is choosing the whole credential - which means the
 * browser does not have to read anything back out of an instance that may not be reachable yet.
 * 54 characters from the CSPRNG, the length Rancher's own tokens use.
 *
 * It goes into the instance through spec.values (admin-only, like adminPassword and the cloud
 * credentials) and into the agent pod's namespace as a Secret, and nowhere else.
 */
function agentBearer(): string {
  const bytes = new Uint8Array(27);

  (globalThis.crypto || window.crypto).getRandomValues(bytes);

  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Put an instance's agent credential where a conversation can find it.
 *
 * In the agent pod's own namespace, one Secret per instance, named for the instance - so a pane
 * reads it with no proxy, no Rancher API and no knowledge of how the instance was made, and an
 * instance that is deleted leaves one object to tidy rather than a credential inside something
 * that no longer exists.
 *
 * Best effort on purpose: an instance whose credential could not be stored is still an instance,
 * and the person who could not write a Secret into dev-agents is not the person this is for.
 */
async function storeAgentBearer(name: string, token: string): Promise<void> {
  const url = `${ AGENT_BASE }/v1/secrets`;
  const body = {
    apiVersion: 'v1',
    kind:       'Secret',
    type:       'Opaque',
    metadata:   {
      namespace: AGENT_NS,
      name:      `rancher-${ name }`,
      labels:    { 'dev.rancher.io/kind': 'rancher-agent-credential', 'dev.rancher.io/rancher': name },
    },
    stringData: { token: `dev-agent:${ token }` },
  };

  await devFetch(url, { method: 'POST', body: JSON.stringify(body) }).catch(() => null);
}

async function managedValues(): Promise<Record<string, string>> {
  const values: Record<string, string> = {};

  const version = await devFetch('/v3/settings/k3s-default-version').catch(() => null) as Json;
  const want = String(version?.value || version?.default || '').trim();

  if (/^v?\d+\.\d+\.\d+\+k3s\d+$/.test(want)) {
    values.kubernetesVersion = want.startsWith('v') ? want : `v${ want }`;
  }

  const secret = await devFetch('/v1/secrets/cattle-global-data/githubconfig-clientsecret').catch(() => null) as Json;
  const encoded = secret?.data?.clientsecret;

  if (encoded) {
    try {
      values.githubClientSecret = atob(String(encoded));
    } catch { /* a Secret shaped unexpectedly is one to leave alone */ }
  }

  return values;
}

/**
 * Which build of Rancher an instance runs: the community one, or Prime.
 *
 * Prime is the same server from a SUSE registry rather than Docker Hub - the hint remuda
 * carries (pkg/remuda/utils/constants.ts, BACKEND_IMAGE_SOURCES) and what a probe of the
 * registries confirms: the repository path is `rancher/rancher` in all three, so a version is
 * a version whichever is picked and only the host in front of it changes.
 *
 * Both SUSE registries answer 401 to an anonymous pull (`www-authenticate: Bearer
 * realm=.../api/registry/authorize`), so a Prime instance needs credentials - see
 * PRIME_REGISTRY_USER in secrets.ts. That is the whole of the difference, and it is why Prime
 * is a choice rather than a default.
 *
 * Staging first because it is where pre-GA Prime builds are, which is what a Rancher made here
 * is usually for; remuda picks the same one.
 */
export const RANCHER_REGISTRIES = [
  { id: 'community', label: 'Community (Docker Hub)', host: '', help: 'rancher/rancher, pulled anonymously. No credentials needed.' },
  { id: 'prime-staging', label: 'Prime (staging)', host: 'stgregistry.suse.com', help: 'Pre-GA Prime builds. Needs SUSE registry credentials in Settings.' },
  { id: 'prime', label: 'Prime (released)', host: 'registry.rancher.com', help: 'Released Prime builds. Needs SUSE registry credentials in Settings.' },
] as const;

export type RancherRegistryId = typeof RANCHER_REGISTRIES[number]['id'];

/** Whether a registry choice is a Prime one, and so needs credentials. */
export function isPrimeRegistry(id: string): boolean {
  return !!RANCHER_REGISTRIES.find((r) => r.id === id)?.host;
}

/**
 * The image an instance runs, from the version and where it comes from.
 *
 * The repository is `rancher/rancher` everywhere, so this is the registry host in front of a
 * tag and nothing more. An empty version falls back to the App's own default rather than
 * producing `rancher/rancher:` - a reference a kubelet reads as `:latest`, which for this
 * image is years old.
 */
export function rancherImage(version: string, registry: string = 'community'): string {
  const tag = String(version || '').trim().replace(/^:/, '');

  if (!tag) {
    return RANCHER_INSTANCE_VALUES.image;
  }
  const host = RANCHER_REGISTRIES.find((r) => r.id === registry)?.host || '';

  return `${ host ? `${ host }/` : '' }rancher/rancher:${ tag }`;
}

/**
 * The docker config a Prime instance pulls with, base64 as a `.dockerconfigjson` wants it.
 *
 * `{}` for a community instance, which is a valid and empty config: the Secret is in the bundle
 * either way because Apps Plus substitutes exact `${names}` and has no conditionals, so a
 * resource cannot be left out - see apps-rancher.ts 25-pull-secret.yaml. An empty one costs a
 * kubelet one lookup and changes nothing about an anonymous pull.
 */
export async function primeAuth(registry: string): Promise<string> {
  const host = RANCHER_REGISTRIES.find((r) => r.id === registry)?.host || '';

  if (!host) {
    return btoa('{}');
  }
  const user = (await secretValue('PRIME_REGISTRY_USER').catch(() => '')).trim();
  const password = (await secretValue('PRIME_REGISTRY_PASSWORD').catch(() => '')).trim();

  if (!user || !password) {
    throw new Error(`A Prime instance pulls from ${ host }, which refuses an anonymous pull. Put your SUSE registry username and password in Settings → Tokens first.`);
  }

  return btoa(JSON.stringify({ auths: { [host]: { auth: btoa(`${ user }:${ password }`) } } }));
}

export async function createRancherInstance(store: Store, name: string, app = RANCHER_SINGLE_APP, options: { version?: string; registry?: string } = {}): Promise<void> {
  const clean = name.trim().toLowerCase();

  if (!/^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$/.test(clean)) {
    throw new Error('A Rancher\'s name is lowercase letters, digits and dashes, up to 32 characters.');
  }
  // The cloud credentials chosen in Settings, copied into the instance so it can provision
  // clusters on the same clouds. Read live at provision time, so there is nothing to keep in
  // sync; an instance created with none chosen simply gets none.
  const agentToken = agentBearer();
  const registry = options.registry || 'community';
  const values: Record<string, string> = {
    ...RANCHER_INSTANCE_VALUES,
    ...(await managedValues()),
    agentToken,
    image:     rancherImage(options.version || '', registry),
    // Before the Installation is written, so a Prime instance with no credentials is refused
    // rather than created and then left pulling an image it cannot reach for ever.
    primeAuth: await primeAuth(registry),
  };
  const cloudCredentials = await cloudCredentialsManifest().catch(() => '');

  if (cloudCredentials) {
    values.cloudCredentials = cloudCredentials;
  }

  const instance = await store.dispatch('management/create', {
    type:     APP_INSTANCE,
    metadata: { name: clean, labels: { 'dev.rancher.io/kind': 'rancher' } },
    spec:     {
      app, provisionCluster: { enabled: true }, targets: [], values,
    },
  });

  await instance.save();

  // After the instance exists, so a failure here cannot stop one being made.
  await storeAgentBearer(clean, agentToken);
}

/**
 * Delete a Rancher made here. The Installation owns the cluster Apps Plus provisioned for it
 * (an owner reference with blockOwnerDeletion), so the cluster and its EC2 node go with it.
 */
export async function deleteRancherInstance(store: Store, name: string): Promise<void> {
  const instances: Json[] = await store.dispatch('management/findAll', { type: APP_INSTANCE, opt: { force: true } }).catch(() => []);
  const instance = instances.find((i) => i.metadata?.name === name && [RANCHER_HA_APP, RANCHER_SINGLE_APP].includes(i.spec?.app));

  if (!instance) {
    throw new Error(`There is no Rancher called ${ name } here.`);
  }
  await instance.remove();
}

/** The starred Rancher's URL, or '' for this one. */
export async function defaultRancher(): Promise<string> {
  return (await readPrefs()).defaultRancher || '';
}

export async function setDefaultRancher(url: string): Promise<void> {
  await savePrefs({ defaultRancher: url.replace(/\/$/, '') });
}

/**
 * The Rancher a build should talk to, when nobody has said which.
 *
 * Not `window.location.origin`, which is what this used to fall back to. A share is opened on
 * its own address, and the Dev pages can be opened there too - so on that page the origin is
 * the *preview's* hostname, and a build told to talk to it makes an nginx that proxies to
 * itself: every API call through the share answers 502, including the ones this dashboard
 * makes. The Rancher's own `server-url` is the address it says it is at, whoever is asking.
 */
/**
 * Which Rancher new work points at: the one somebody starred, if it still exists.
 *
 * The star is remembered as a URL, and an instance's URL carries its node's public IP - so an
 * instance rebuilt (which is routine: three in one day while this was written) leaves a
 * remembered address that resolves to a terminated machine. Nothing noticed, and every workspace
 * made afterwards was pointed at it.
 *
 * So the star is checked against the Ranchers that are actually there before it is used. A
 * remembered address nobody serves any more is dropped, and the fall-back is this Rancher, which
 * is the one address that cannot go stale. The list is already read on every sidebar poll, so
 * this is a cache hit in the common case.
 */
export async function talksToDefault(store: Store): Promise<string> {
  const starred = await defaultRancher().catch(() => '');

  if (!starred) {
    return ownRancherUrl(store);
  }
  const live = await listRanchers(store).catch(() => []);

  // An empty list means the read failed, not that nothing exists: in that case the star is
  // honoured, because refusing it would send work to the wrong Rancher on a network blip.
  if (live.length && !live.some((rancher) => rancher.url === starred)) {
    await setDefaultRancher('').catch(() => {});

    return ownRancherUrl(store);
  }

  return starred;
}

/**
 * Where *this* Rancher says it is, which is not always where the page is being read.
 *
 * `server-url` is the address Rancher hands out for itself; a page opened through a share, or
 * through the apiserver's service proxy, has an origin that is neither. Anything a pod will
 * fetch later, or anything written into a build, has to be this rather than the origin.
 */
export async function ownRancherUrl(store: Store): Promise<string> {
  const setting: Json = await store.dispatch('management/find', { type: 'management.cattle.io.setting', id: 'server-url' }).catch(() => null);
  const own = String(setting?.value || setting?.default || '').replace(/\/$/, '');

  return own || window.location.origin;
}

// ── Choosing where a workspace runs ───────────────────────────────────────────────────────────
//
// A workspace used to run on whichever Rancher was starred in the sidebar. Now the choice is asked
// for each time one is started - a modal, defaulting to the last choice - so there is no hidden
// setting that silently sends a fix to the wrong cluster. The modal is a component mounted once
// (RancherPicker, in the sidebar) that registers itself here; a start is a plain async call deep in
// reviews.ts, so it reaches the modal through this registration rather than through props.

/** Thrown when the person closes the picker without choosing: a quiet abort, not a failure. */
export class RancherPickCancelled extends Error {
  constructor() {
    super('');
    this.name = 'RancherPickCancelled';
  }

  // Empty, so a caller that shows `e.message || String(e)` shows nothing: cancelling is not an error.
  toString(): string {
    return '';
  }
}

type RancherPickFn = (opts: { store: Store; current: string }) => Promise<string | null>;
let rancherPicker: RancherPickFn | null = null;

/** The mounted picker registers itself here; `null` on unmount. See RancherPicker.vue. */
export function registerRancherPicker(fn: RancherPickFn | null): void {
  rancherPicker = fn;
}

/**
 * Ask which Rancher to run on, defaulting to `current`. Returns the chosen URL ('' for this
 * Rancher), or `null` if cancelled. With no picker mounted - a headless path, a page without the
 * sidebar - it falls back to `current` without a modal, so nothing blocks on a missing UI.
 */
export async function pickRancher(store: Store, current: string): Promise<string | null> {
  if (!rancherPicker) {
    return current;
  }

  return rancherPicker({ store, current });
}

/**
 * What a new workspace is made with: the Rancher the person picks as its `rancherUrl`, or nothing,
 * which leaves the App's own default - the Rancher this cluster belongs to, by node address. The
 * pick defaults to the last one and is remembered as the next default. Throws RancherPickCancelled
 * if the person closes the picker, so the start that called this aborts without creating anything.
 */
export async function defaultRancherValues(store: Store): Promise<Record<string, string>> {
  const previous = await defaultRancher().catch(() => '');
  const chosen = await pickRancher(store, previous);

  if (chosen === null) {
    throw new RancherPickCancelled();
  }
  await setDefaultRancher(chosen).catch(() => { /* remembering the choice is best-effort */ });

  return chosen ? { rancherUrl: chosen } : {};
}
