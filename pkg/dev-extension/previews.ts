// A static preview: the dashboard built at a ref and served on a link, pointed at a Rancher.
//
// One Installation of the dashboard-preview App per workspace (see apps.ts for what that App
// is). It is labelled as a workspace so the sidebar lists it, and named after the workspace it
// previews so the two are found from each other. What a reviewer gets is the node's address
// and the Service's NodePort; what they need beyond that is an account on the Rancher the
// preview was built for.

import { devFetch, clusterBase, nodeAddress, workspaceNamespace, deleteWorkspace } from './api';

export { deleteWorkspace };
import { createWorkspaceInstance, deleteWorkspaceInstance, workspaceInstance } from './apps';
import { PREVIEW_APP } from './apps';
import {
  buildShare, workspaceBranch, readInWorkspace, workspaceTarget
} from './workspace-tools';
import { defaultRancher } from './ranchers';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Store = any;

export interface PreviewState {
  name: string;
  exists: boolean;
  /** building (init container), serving, failed, or absent */
  state: 'absent' | 'building' | 'serving' | 'failed';
  detail: string;
  /**
   * The link to share: this Rancher's own address, through its service proxy. Same origin as
   * the Rancher, so a reviewer signs in the way they always do - GitHub included - and the API
   * the build talks to is simply here. It also means the link asks for a Rancher login, which
   * is what a build of an unreviewed branch should ask for.
   */
  url: string;
  /**
   * The NodePort, on a name rather than a number: sslip.io answers `172-17-0-2.sslip.io` with
   * 172.17.0.2. Only offered where it works - a Storybook is a static site and serves from
   * anywhere; a dashboard build is routed for the proxied address and only serves there.
   */
  direct: string;
  ref: string;
  rancherUrl: string;
  kind: ShareKind;
  /** The workspace build nginx serves, as `<workspace>/share/<kind>`; '' when it was built from `ref`. */
  sourceDir: string;
}

export type ShareKind = 'dashboard' | 'storybook';

/** Where a workspace's own build of a kind lives, under the node's dev-workspaces. See buildShare. */
export function shareSourceDir(workspace: string, kind: ShareKind): string {
  return `${ workspace }/share/${ kind }`;
}

/** The path a dashboard build is routed and served at: through this Rancher's service proxy. */
export function previewBase(workspace: string, cluster = 'local', kind: ShareKind = 'dashboard'): string {
  return kind === 'storybook' ? '/' : `${ proxyBase(workspaceNamespace(previewName(workspace, kind)), cluster, 8080) }dashboard/`;
}

/** What a share is called: the dashboard build keeps the older `preview-` name. */
export function previewName(workspace: string, kind: ShareKind = 'dashboard'): string {
  return `${ kind === 'storybook' ? 'storybook' : 'preview' }-${ workspace }`.slice(0, 40);
}

export async function deployPreview(store: Store, workspace: string, values: { repo: string; ref: string; rancherUrl: string; kind?: ShareKind; sourceDir?: string }, cluster = 'local'): Promise<string> {
  const kind: ShareKind = values.kind || 'dashboard';
  const name = previewName(workspace, kind);

  // Not while the last one's namespace is still going. A Fleet bundle that installs into a
  // namespace it finds terminating does not own it, fails the install, and never retries - so a
  // Remove followed by a Build sat "waiting for a pod" for good. Waiting here is what the
  // person would otherwise be told to do.
  await namespaceGone(workspaceNamespace(name), cluster);
  // The dashboard routes and fetches its assets under the proxied address, so the link on this
  // Rancher is the one that works; the port is the App's default, which the Service listens on.
  const base = `${ proxyBase(workspaceNamespace(name), cluster, 8080) }dashboard/`;

  await createWorkspaceInstance(store, name, PREVIEW_APP, cluster, {
    ...values, kind, base, sourceDir: values.sourceDir || 'none',
  });

  return name;
}

/**
 * The Share tab's build-and-share, as one call: the workspace builds its checkout as it is,
 * and an nginx is put up to serve that directory. Rebuilding is building again; nginx serves
 * whatever is there.
 */
export async function shareWorkspace(store: Store, workspace: string, kind: ShareKind, rancherUrl: string, cluster = 'local'): Promise<void> {
  const { branch } = await workspaceBranch(workspace);

  await buildShare(workspace, kind, previewBase(workspace, cluster, kind));

  const state = await previewState(store, workspace, cluster, kind);

  if (!state.exists || !state.sourceDir) {
    if (state.exists) {
      await removePreview(store, workspace, kind);
    }
    await deployPreview(store, workspace, {
      repo: 'rancher/dashboard', ref: branch || 'HEAD', kind, rancherUrl, sourceDir: shareSourceDir(workspace, kind),
    }, cluster);
  }
}

/**
 * Shared by default: a workspace that has never been shared gets its dashboard built and put
 * on a link the first time it is ready, without anybody pressing anything. Once: a marker in
 * the workspace says it happened, so a share somebody removed stays removed.
 */
export async function ensureDefaultShare(store: Store, workspace: string, cluster = 'local'): Promise<void> {
  const target = await workspaceTarget(workspace).catch(() => null);

  if (!target) {
    return;
  }
  const done = await readInWorkspace(workspace, 'test -f /workspace/.share/auto && echo AUTO-DONE || true');

  if (done.includes('AUTO-DONE')) {
    return;
  }
  const state = await previewState(store, workspace, cluster, 'dashboard');

  if (!state.exists) {
    await shareWorkspace(store, workspace, 'dashboard', (await defaultRancher().catch(() => '')) || window.location.origin, cluster);
  }
  await readInWorkspace(workspace, 'mkdir -p /workspace/.share && touch /workspace/.share/auto');
}

async function namespaceGone(namespace: string, cluster: string): Promise<void> {
  const base = clusterBase(cluster);

  for (let i = 0; i < 40; i++) {
    const found = await devFetch(`${ base }/v1/namespaces/${ namespace }`).catch(() => null);

    if (!found || !found.metadata?.deletionTimestamp) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
}

/**
 * Where a build is reached through this Rancher: its service, proxied. The path the proxy strips
 * before handing the request to nginx, which is why the dashboard is built to route under it -
 * `base` below - while nginx goes on serving /dashboard/.
 */
export function proxyBase(namespace: string, cluster: string, port: number): string {
  return `${ clusterBase(cluster) }/api/v1/namespaces/${ namespace }/services/http:${ namespace }:${ port }/proxy/`;
}

/** An address as a name sslip.io resolves: 172.17.0.2 becomes 172-17-0-2.sslip.io. */
export function sslipName(address: string): string {
  return /^\d+\.\d+\.\d+\.\d+$/.test(address) ? `${ address.replace(/\./g, '-') }.sslip.io` : address;
}

export async function removePreview(store: Store, workspace: string, kind: ShareKind = 'dashboard'): Promise<void> {
  await deleteWorkspaceInstance(store, previewName(workspace, kind));
}

/** Restart the preview's pod, which rebuilds it: the init container is the build. */
export async function rebuildPreview(workspace: string, cluster = 'local', kind: ShareKind = 'dashboard'): Promise<void> {
  const namespace = workspaceNamespace(previewName(workspace, kind));
  const base = clusterBase(cluster);
  const pods = await devFetch(`${ base }/v1/pods/${ namespace }`).catch(() => null);

  for (const pod of pods?.data || []) {
    await devFetch(`${ base }/v1/pods/${ namespace }/${ pod.metadata.name }`, { method: 'DELETE' }).catch(() => null);
  }
}

/**
 * Point a served dashboard at another Rancher. Only the instance's value changes: Apps Plus
 * re-renders the nginx in front of the build with the new upstream, and the build stays.
 */
export async function retargetPreview(store: Store, workspace: string, kind: ShareKind, rancherUrl: string): Promise<void> {
  const instance = await workspaceInstance(store, previewName(workspace, kind));

  if (!instance) {
    throw new Error('Nothing is shared yet: build and share it first.');
  }
  instance.spec.values = { ...(instance.spec.values || {}), rancherUrl: rancherUrl.replace(/\/$/, '') };
  await instance.save();
}

export async function previewState(store: Store, workspace: string, cluster = 'local', kind: ShareKind = 'dashboard'): Promise<PreviewState> {
  const name = previewName(workspace, kind);
  const instance = await workspaceInstance(store, name).catch(() => null);
  const empty: PreviewState = {
    name, exists: false, state: 'absent', detail: '', url: '', direct: '', ref: '', rancherUrl: '', kind, sourceDir: '',
  };

  if (!instance) {
    return empty;
  }

  const namespace = workspaceNamespace(name);
  const base = clusterBase(cluster);
  const [pods, services, address] = await Promise.all([
    devFetch(`${ base }/v1/pods/${ namespace }`).catch(() => null),
    devFetch(`${ base }/v1/services/${ namespace }`).catch(() => null),
    nodeAddress(),
  ]);
  const pod: Json = (pods?.data || []).find((candidate: Json) => !candidate.metadata?.deletionTimestamp) || null;
  const service: Json = (services?.data || []).find((svc: Json) => svc.metadata?.name === namespace) || null;
  const nodePort = service?.spec?.ports?.[0]?.nodePort || 0;
  const port = service?.spec?.ports?.[0]?.port || 8080;
  const init: Json = pod?.status?.initContainerStatuses?.[0] || null;
  const main: Json = pod?.status?.containerStatuses?.[0] || null;
  let state: PreviewState['state'] = 'building';
  let detail = 'Waiting for a pod';

  if (init?.state?.waiting?.reason && /BackOff|Error/.test(init.state.waiting.reason)) {
    state = 'failed';
    detail = `Failed to prepare (${ init.state.waiting.reason }); see the pod's build container log.`;
  } else if (init?.state?.running) {
    detail = 'Preparing the build to serve';
  } else if (main?.ready) {
    state = 'serving';
    detail = 'Serving';
  } else if (main) {
    detail = 'Built; nginx is starting';
  }

  return {
    name,
    exists:     true,
    state,
    detail,
    url:        service ? `${ window.location.origin }${ proxyBase(namespace, cluster, port) }${ kind === 'storybook' ? '' : 'dashboard/' }` : '',
    direct:     nodePort && kind === 'storybook' ? `http://${ sslipName(address) }:${ nodePort }/` : '',
    ref:        String(instance.spec?.values?.ref || ''),
    rancherUrl: String(instance.spec?.values?.rancherUrl || ''),
    sourceDir:  String(instance.spec?.values?.sourceDir || '') === 'none' ? '' : String(instance.spec?.values?.sourceDir || ''),
    kind,
  };
}
