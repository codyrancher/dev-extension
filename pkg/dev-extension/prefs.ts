// What one person has chosen about this product: which Apps Plus apps they want offered.
//
// Every App in the cluster is a template here, and a cluster has Apps that are not for making
// workspaces from - a Rancher HA install, a static site. Rather than guess which, the person
// says, in Settings, and the sidebar and the Create page offer only those. Kept per person in
// a ConfigMap of their own in dev-system, beside their secrets, for the same reason the secrets
// are per person: a colleague's clutter is not yours to tidy.

import { devFetch, currentOwner, DEV_SYSTEM_NAMESPACE, clusterBase } from './api';

export interface DevPrefs {
  /** App ids the person has hidden. Everything not listed is shown; a new App shows up on its own. */
  hiddenApps: string[];
  /** The Rancher new workspaces point at, by URL; '' is the one this dashboard is on. See ranchers.ts. */
  defaultRancher: string;
}

const EMPTY: DevPrefs = { hiddenApps: [], defaultRancher: '' };
const KIND_LABEL = 'dev.rancher.io/kind';
const OWNER_LABEL = 'dev.rancher.io/owner';

// Always the local cluster: prefs are the person's, not a workspace's, and dev-system is there.
const BASE = clusterBase('local');

async function prefsName(): Promise<string> {
  return `dev-prefs-${ await currentOwner() }`;
}

export async function readPrefs(): Promise<DevPrefs> {
  const name = await prefsName();
  const found = await devFetch(`${ BASE }/v1/configmaps/${ DEV_SYSTEM_NAMESPACE }/${ name }`).catch(() => null);

  try {
    const parsed = JSON.parse(found?.data?.['prefs.json'] || '{}');

    return {
      ...EMPTY,
      hiddenApps:     Array.isArray(parsed.hiddenApps) ? parsed.hiddenApps.filter((id: unknown) => typeof id === 'string') : [],
      defaultRancher: typeof parsed.defaultRancher === 'string' ? parsed.defaultRancher : '',
    };
  } catch {
    return { ...EMPTY };
  }
}

/** Save some of the preferences; the rest keep what they were, so two pages never undo each other. */
export async function savePrefs(changes: Partial<DevPrefs>): Promise<void> {
  const name = await prefsName();
  const url = `${ BASE }/v1/configmaps/${ DEV_SYSTEM_NAMESPACE }/${ name }`;
  const existing = await devFetch(url).catch(() => null);
  const prefs: DevPrefs = { ...(await readPrefs()), ...changes };
  const data = { 'prefs.json': JSON.stringify(prefs) };

  if (existing) {
    await devFetch(url, { method: 'PUT', body: JSON.stringify({ ...existing, data }) });

    return;
  }

  await devFetch(`${ BASE }/v1/configmaps`, {
    method: 'POST',
    body:   JSON.stringify({
      apiVersion: 'v1',
      kind:       'ConfigMap',
      metadata:   {
        namespace: DEV_SYSTEM_NAMESPACE,
        name,
        labels:    { [KIND_LABEL]: 'prefs', [OWNER_LABEL]: await currentOwner() },
      },
      data,
    }),
  });
}

/** The apps a person wants offered: every App minus the ones they hid. */
export function shownApps<T extends { id: string }>(apps: T[], prefs: DevPrefs): T[] {
  const hidden = new Set(prefs.hiddenApps);

  return apps.filter((app) => !hidden.has(app.id));
}
