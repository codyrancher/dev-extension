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

export interface RancherTarget {
  id: string;
  name: string;
  /** Where it is reached; empty while an instance's cluster has no node yet. */
  url: string;
  kind: 'host' | 'instance';
  note: string;
}

/**
 * This Rancher first, then every rancher-ha instance, by the address its App promises:
 * `<name>.<node ip>.sslip.io`, on the cluster the instance provisioned for itself.
 */
export async function listRanchers(store: Store): Promise<RancherTarget[]> {
  const out: RancherTarget[] = [{
    id: 'host', name: 'This Rancher', url: window.location.origin, kind: 'host', note: 'the Rancher this dashboard is on',
  }];
  const instances: Json[] = await store.dispatch('management/findAll', { type: APP_INSTANCE }).catch(() => []);
  const ranchers = instances.filter((instance) => [RANCHER_HA_APP, RANCHER_SINGLE_APP].includes(instance.spec?.app));

  if (!ranchers.length) {
    return out;
  }

  const clusters: Json[] = (await devFetch('/v3/clusters').catch(() => null))?.data || [];

  for (const instance of ranchers) {
    const name = instance.metadata?.name;
    const cluster = clusters.find((c) => c.name === name || c.id === name);
    let address = '';

    if (cluster) {
      const nodes = await devFetch(`${ clusterBase(cluster.id) }/v1/nodes`).catch(() => null);
      const addresses: Json[] = (nodes?.data || []).flatMap((node: Json) => node.status?.addresses || []);

      address = addresses.find((a) => a.type === 'ExternalIP')?.address || addresses.find((a) => a.type === 'InternalIP')?.address || '';
    }

    out.push({
      id:   `instance:${ name }`,
      name,
      url:  address ? rancherAddress(name, address) : '',
      kind: 'instance',
      note: cluster ? (address ? `on cluster ${ cluster.name }` : `cluster ${ cluster.name } has no node yet`) : 'its cluster is not up yet',
    });
  }

  return out;
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
