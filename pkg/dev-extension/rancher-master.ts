// rancher/dashboard's master, on one link everybody can use: the browser's half.
//
// The tool itself is the `rancher-master` App (apps-rancher.ts): a share in front of a sidebar
// Rancher whose dashboard is master's own CI build, swapped for the next one as each lands. It
// is one Installation for everybody rather than a tool per workspace, because what it answers -
// "does master do this too?" - is the same question from every workspace, and the alternative
// was each agent building master for itself to find out.
//
// What lives where:
// - installing and removing it is Apps Plus, which only renders in a browser, so it is here;
// - pausing and going back are the ConfigMap `control` in its namespace on the Rancher's
//   cluster, which the browser can write and dev-api cannot (it has no way into a downstream
//   cluster) - so that is here too;
// - where it is, and what it is serving, is dev-api's: `GET /rancher-master`, which is also what
//   an agent's `tools url rancher-master` reads. The browser tells dev-api where it put it.

import { devApi } from './reviews';
import { devFetch, clusterBase } from './api';
import { APP_INSTANCE, LABEL_APP, LABEL_CLUSTER } from './config/constants';
import { RANCHER_MASTER_APP, deleteInstance, appsPlusAvailable } from './apps';
import type { RancherTarget } from './ranchers';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Store = any;

/** The one Installation, and the namespace it renders into on the Rancher's cluster. */
export const RANCHER_MASTER = 'rancher-master';
export const RANCHER_MASTER_NAMESPACE = `dev-${ RANCHER_MASTER }`;

export interface MasterBuild {
  /** The commit, as the build's own VERSION.txt names it (seven characters). */
  sha: string;
  /** When this tool fetched it (ISO). */
  fetched: string;
  /** The commit's first line and date, looked up by dev-api; absent when GitHub would not say. */
  message?: string;
  date?: string;
}

/** What the sync container says it is doing, from `/.rancher-master.json`. */
export interface MasterStatus {
  /** master's head right now (full sha); its build may still be on the way. */
  head: string;
  /** The build being served. */
  current: string;
  paused: boolean;
  /** The build it was told to hold, or ''. */
  pin: string;
  checked: string;
  error: string;
  /** Kept builds, newest first. */
  builds: MasterBuild[];
}

export interface RancherMaster {
  installed: boolean;
  /** `https://<host>/dashboard/`, what a person or an agent opens. */
  url: string;
  host: string;
  /** Management id of the cluster it runs on. */
  cluster: string;
  /** The sidebar Rancher it fronts, by name, and that Rancher's own address. */
  rancher: string;
  rancherUrl: string;
  /** null until the pod answers. */
  status: MasterStatus | null;
  /** Why there is no status, when there is none. */
  detail: string;
}

export async function readRancherMaster(): Promise<RancherMaster> {
  return devApi('/rancher-master');
}

/** The Rancher Service the share proxies to: `<name>-rancher` in cattle-system, on port 80. */
async function rancherUpstream(cluster: string): Promise<string> {
  const services = (await devFetch(`${ clusterBase(cluster) }/api/v1/namespaces/cattle-system/services`))?.items || [];
  const svc = services.find((s: Json) => /(^|-)rancher$/.test(s.metadata?.name || ''));

  if (!svc) {
    throw new Error(`That Rancher's cluster has no Rancher Service in cattle-system to put master in front of (there are: ${ services.map((s: Json) => s.metadata?.name).join(', ') || 'none' }).`);
  }
  const port = svc.spec?.ports?.find((p: Json) => p.port === 80)?.port || svc.spec?.ports?.[0]?.port || 80;

  return `http://${ svc.metadata.name }.cattle-system.svc.cluster.local:${ port }`;
}

/**
 * Put master in front of a sidebar Rancher.
 *
 * Only a Rancher of the sidebar's: it needs a public node for the link to open from anywhere, and
 * the share reaches the Rancher by its in-cluster Service, so the two have to be on one cluster.
 */
export async function installRancherMaster(store: Store, rancher: RancherTarget): Promise<RancherMaster> {
  if (!appsPlusAvailable(store)) {
    throw new Error('Apps Plus is not installed here, and rancher-master is an Apps Plus App.');
  }
  if (rancher.kind !== 'instance' || rancher.phase !== 'ready' || !rancher.clusterId || !rancher.nodeIp) {
    throw new Error(`${ rancher.name } is not a Rancher of the sidebar's that is up with a public node.`);
  }
  const host = `${ RANCHER_MASTER }.dev-extension.${ rancher.nodeIp }.sslip.io`;
  const instance = await store.dispatch('management/create', {
    type:     APP_INSTANCE,
    metadata: { name: RANCHER_MASTER, labels: { [LABEL_APP]: RANCHER_MASTER_APP, [LABEL_CLUSTER]: rancher.clusterId } },
    spec:     {
      app:              RANCHER_MASTER_APP,
      namespace:        RANCHER_MASTER_NAMESPACE,
      // Fleet targets a sidebar Rancher's cluster by the instance's own name (see pickShareHost).
      targets:          [{ clusterName: rancher.name }],
      values:           {
        host, hostCluster: rancher.clusterId, ingressClass: 'traefik', rancherUpstream: await rancherUpstream(rancher.clusterId),
      },
      provisionCluster: { enabled: false },
    },
  });

  await instance.save();

  return devApi('/rancher-master', {
    method:  'PUT',
    headers: { 'content-type': 'application/json' },
    body:    JSON.stringify({
      host, url: `https://${ host }/dashboard/`, cluster: rancher.clusterId, rancher: rancher.name, rancherUrl: rancher.url,
    }),
  });
}

export async function removeRancherMaster(): Promise<void> {
  await deleteInstance(RANCHER_MASTER);
  await devApi('/rancher-master', { method: 'DELETE' });
}

/**
 * Tell it what to serve: hold where it is, hold a kept build, or follow master again.
 *
 * `{ paused: false, pin: '' }` is following master. The sync loop reads this every 15 seconds.
 * Written whole each time, so what the page shows and what the pod reads are the same two values.
 */
export async function controlRancherMaster(cluster: string, control: { paused: boolean; pin: string }): Promise<void> {
  const base = `${ clusterBase(cluster) }/api/v1/namespaces/${ RANCHER_MASTER_NAMESPACE }/configmaps`;
  const body = {
    apiVersion: 'v1',
    kind:       'ConfigMap',
    metadata:   { name: 'control', namespace: RANCHER_MASTER_NAMESPACE },
    data:       { paused: control.paused ? 'true' : 'false', pin: control.pin || '' },
  };
  const json = { 'content-type': 'application/json' };

  try {
    await devFetch(`${ base }/control`, { method: 'PUT', headers: json, body: JSON.stringify(body) });
  } catch (e: Json) {
    if (!/not ?found|404/i.test(String(e?.message || e))) {
      throw e;
    }
    await devFetch(base, { method: 'POST', headers: json, body: JSON.stringify(body) });
  }
}

/** A commit on GitHub, for a link beside a build. */
export function masterCommitUrl(sha: string): string {
  return `https://github.com/rancher/dashboard/commit/${ sha }`;
}

/** How to talk to it, for the Tools page's "How to talk to it". */
export const RANCHER_MASTER_OPENAPI = [
  'openapi: 3.1.0',
  'info:',
  '  title: rancher-master',
  '  version: "1"',
  '  description: rancher/dashboard master in front of a Rancher, shared by every workspace. Served by dev-api.',
  'paths:',
  '  /rancher-master:',
  '    get:',
  '      summary: Where it is (url) and what it serves - status.current is the commit, status.head is master now, status.paused and status.pin say whether a person is holding it.',
  '  /tools/{workspace}/rancher-master:',
  '    get:',
  '      summary: The same as a tool - `tools url rancher-master` inside a workspace. Shared and not leased; start and stop change nothing.',
  '  <its url>/../.rancher-master.json:',
  '    get:',
  '      summary: The pod\'s own status, on its public address, CORS-open.',
].join('\n');
