// A static preview: the dashboard built at a ref and served on a link, pointed at a Rancher.
//
// One Installation of the dashboard-preview App per workspace (see apps.ts for what that App
// is). It is labelled as a workspace so the sidebar lists it, and named after the workspace it
// previews so the two are found from each other. What a reviewer gets is the node's address
// and the Service's NodePort; what they need beyond that is an account on the Rancher the
// preview was built for.

import { devFetch, clusterBase, nodeAddress, workspaceNamespace } from './api';
import { createWorkspaceInstance, deleteWorkspaceInstance, workspaceInstance } from './apps';
import { PREVIEW_APP } from './apps';

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
  url: string;
  ref: string;
  rancherUrl: string;
}

export function previewName(workspace: string): string {
  return `preview-${ workspace }`.slice(0, 40);
}

export async function deployPreview(store: Store, workspace: string, values: { repo: string; ref: string; rancherUrl: string }, cluster = 'local'): Promise<string> {
  const name = previewName(workspace);

  await createWorkspaceInstance(store, name, PREVIEW_APP, cluster, values);

  return name;
}

export async function removePreview(store: Store, workspace: string): Promise<void> {
  await deleteWorkspaceInstance(store, previewName(workspace));
}

/** Restart the preview's pod, which rebuilds it: the init container is the build. */
export async function rebuildPreview(workspace: string, cluster = 'local'): Promise<void> {
  const namespace = workspaceNamespace(previewName(workspace));
  const base = clusterBase(cluster);
  const pods = await devFetch(`${ base }/v1/pods/${ namespace }`).catch(() => null);

  for (const pod of pods?.data || []) {
    await devFetch(`${ base }/v1/pods/${ namespace }/${ pod.metadata.name }`, { method: 'DELETE' }).catch(() => null);
  }
}

export async function previewState(store: Store, workspace: string, cluster = 'local'): Promise<PreviewState> {
  const name = previewName(workspace);
  const instance = await workspaceInstance(store, name).catch(() => null);
  const empty: PreviewState = {
    name, exists: false, state: 'absent', detail: '', url: '', ref: '', rancherUrl: '',
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
  const init: Json = pod?.status?.initContainerStatuses?.[0] || null;
  const main: Json = pod?.status?.containerStatuses?.[0] || null;
  let state: PreviewState['state'] = 'building';
  let detail = 'Waiting for a pod';

  if (init?.state?.waiting?.reason && /BackOff|Error/.test(init.state.waiting.reason)) {
    state = 'failed';
    detail = `The build failed (${ init.state.waiting.reason }); see the pod's build container log.`;
  } else if (init?.state?.running) {
    detail = 'Building: a clone, a yarn install and a production build, which takes several minutes';
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
    url:        nodePort ? `http://${ address }:${ nodePort }/dashboard/` : '',
    ref:        String(instance.spec?.values?.ref || ''),
    rancherUrl: String(instance.spec?.values?.rancherUrl || ''),
  };
}
