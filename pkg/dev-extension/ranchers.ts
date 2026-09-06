// The Ranchers a workspace can be pointed at, and which of them new ones point at by default.
//
// A workspace's dev server, and a build shared from it, talk to a Rancher: the one this
// dashboard is on, or one of the Rancher installs this cluster runs (the rancher-ha App, one
// per instance). The sidebar lists them the way it lists clusters, and the starred one is what
// a workspace made from My Work or the Create page is pointed at when nobody says otherwise.
// Kept per person, beside the other preferences (prefs.ts).

import { devFetch, clusterBase } from './api';
import { APP_INSTANCE } from './config/constants';
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
}

/** The four steps a new Rancher goes through, in order, for a tooltip. */
export const RANCHER_STEPS = ['cluster asked for', 'node provisioning', 'Rancher installing', 'up'];

/**
 * This Rancher first, then every instance with where it has got to: the cluster Apps Plus
 * provisions for it (its state and Rancher's own words about it, from /v3/clusters), then the
 * Rancher chart the bundle installs on that cluster, then the address once Rancher answers
 * there, `<name>.dev-extension.<node ip>.sslip.io`.
 */
export async function listRanchers(store: Store): Promise<RancherTarget[]> {
  const out: RancherTarget[] = [{
    id: 'host', name: 'This Rancher', url: window.location.origin, kind: 'host', phase: 'host', step: 3, detail: 'the Rancher this dashboard is on', since: '',
  }];
  const instances: Json[] = await store.dispatch('management/findAll', { type: APP_INSTANCE }).catch(() => []);
  const ranchers = instances.filter((instance) => [RANCHER_HA_APP, RANCHER_SINGLE_APP].includes(instance.spec?.app));

  if (!ranchers.length) {
    return out;
  }

  const [clusters, bundles] = await Promise.all([
    devFetch('/v3/clusters').then((r: Json) => r?.data || []).catch(() => []) as Promise<Json[]>,
    store.dispatch('management/findAll', { type: 'fleet.cattle.io.bundle' }).catch(() => []) as Promise<Json[]>,
  ]);

  for (const instance of ranchers) {
    const name = instance.metadata?.name;
    const cluster = clusters.find((c) => c.name === name || c.id === name);
    const bundle = bundles.find((b) => b.metadata?.name === `apps-plus-${ name }`);

    if (instance.metadata?.deletionTimestamp) {
      out.push({
        id: `instance:${ name }`, name, url: '', kind: 'instance', phase: 'removing', step: 0, detail: 'Removing, with its cluster and node', since: instance.metadata.deletionTimestamp,
      });
      continue;
    }
    out.push(await instanceTarget(name, instance.metadata?.creationTimestamp || '', cluster, bundle));
  }

  return out;
}

async function instanceTarget(name: string, since: string, cluster: Json | undefined, bundle: Json | undefined): Promise<RancherTarget> {
  const base = {
    id: `instance:${ name }`, name, url: '', kind: 'instance' as const, since,
  };
  const bundleState: string = bundle?.status?.display?.state || '';
  const bundleMessage: string = bundle?.status?.display?.message || '';

  if (!cluster) {
    // Apps Plus makes the cluster when a dashboard with it loaded reconciles the instance.
    return {
      ...base, phase: 'created', step: 0, detail: 'Creating the cluster',
    };
  }
  const message = shortenTransition(cluster.transitioningMessage || '');

  if (cluster.state === 'error' || cluster.transitioning === 'error') {
    return {
      ...base, phase: 'error', step: 1, detail: message || 'Provisioning failed',
    };
  }
  if (cluster.state !== 'active') {
    return {
      ...base, phase: 'provisioning', step: 1, detail: message || `Provisioning (${ cluster.state })`,
    };
  }

  // The cluster is up: its node's address is where Rancher will answer, once the chart the
  // bundle installs has a ready pod.
  const [nodes, deployments] = await Promise.all([
    devFetch(`${ clusterBase(cluster.id) }/v1/nodes`).catch(() => null),
    devFetch(`${ clusterBase(cluster.id) }/v1/apps.deployments/cattle-system`).catch(() => null),
  ]);
  const addresses: Json[] = (nodes?.data || []).flatMap((node: Json) => node.status?.addresses || []);
  const address = addresses.find((a) => a.type === 'ExternalIP')?.address || addresses.find((a) => a.type === 'InternalIP')?.address || '';
  // The chart's release is named for the instance, so its Deployment is `<name>-rancher`
  // (`ha-rancher`); a Rancher installed by hand is plain `rancher`.
  const deployment: Json = (deployments?.data || []).find((d: Json) => [`${ name }-rancher`, 'rancher'].includes(d.metadata?.name)) || null;
  const ready = (deployment?.status?.readyReplicas || 0) > 0;

  if (ready && address) {
    return {
      ...base, phase: 'ready', step: 3, detail: '', url: rancherAddress(name, address),
    };
  }
  if (/^Err/.test(bundleState)) {
    return {
      ...base, phase: 'error', step: 2, detail: shortenTransition(bundleMessage) || 'Installing Rancher failed',
    };
  }

  return {
    ...base, phase: 'installing', step: 2, detail: deployment ? 'Rancher is starting' : 'Installing Rancher',
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
export async function createRancherInstance(store: Store, name: string, app = RANCHER_SINGLE_APP): Promise<void> {
  const clean = name.trim().toLowerCase();

  if (!/^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$/.test(clean)) {
    throw new Error('A Rancher\'s name is lowercase letters, digits and dashes, up to 32 characters.');
  }
  const instance = await store.dispatch('management/create', {
    type:     APP_INSTANCE,
    metadata: { name: clean, labels: { 'dev.rancher.io/kind': 'rancher' } },
    spec:     {
      app, provisionCluster: { enabled: true }, targets: [], values: {},
    },
  });

  await instance.save();
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
 * What a new workspace is made with: the starred Rancher as its `rancherUrl`, or nothing,
 * which leaves the App's own default - the Rancher this cluster belongs to, by node address.
 */
export async function defaultRancherValues(): Promise<Record<string, string>> {
  const url = await defaultRancher().catch(() => '');

  return url ? { rancherUrl: url } : {};
}
