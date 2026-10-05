// What one person has chosen about this product: which Apps Plus apps they want offered.
//
// Every App in the cluster is a template here, and a cluster has Apps that are not for making
// workspaces from - a Rancher HA install, a static site. Rather than guess which, the person
// says, in Settings, and the sidebar and the Create page offer only those. Kept per person in
// a ConfigMap of their own in dev-system, beside their secrets, for the same reason the secrets
// are per person: a colleague's clutter is not yours to tidy.

import { devFetch, currentOwner, DEV_SYSTEM_NAMESPACE, clusterBase } from './api';

/**
 * What the Focus view keeps per person: what has been pulled out of the deck, what has been put
 * off, and what has been dealt with.
 *
 * Here rather than in focus.ts so that file can import it without this one importing that one -
 * and because it is a preference in exactly the sense the rest of this file means: one person's
 * arrangement of a thing everybody can see.
 */
export interface FocusPrefs {
  /** Queue keys pinned beside the deck. */
  pinned: string[];
  /** Queue key to the ISO time it comes back. */
  snoozed: Record<string, string>;
  /** Queue key to when it was dealt with, so it does not come straight back. */
  done: Record<string, string>;
  /**
   * Cards put aside until an agent stops, by queue key.
   *
   * The person's, not the browser's, because it changes the deck's ranking and has to be the same
   * on every tab and after a reload - which is the whole point of it. What is stored is the
   * conversation and the counters it was at when the work was handed over: the card is held back
   * until one of them moves, and `stops`/`asks` move on the way OUT of a turn and never on the way
   * in, which is why they are what is kept rather than a revision. `epoch` and `bornAt` are the two
   * ways the thing being counted can be replaced underneath - a deleted document, and
   * `sessions.sh new` handing the same ordinal to somebody else's conversation.
   */
  awaiting?: Record<string, { conversation: string; stops: number; asks: number; epoch: string; bornAt: string; at: string }>;
}

export interface DevPrefs {
  /** App ids the person has hidden. Everything not listed is shown; a new App shows up on its own. */
  hiddenApps: string[];
  /** The Rancher new workspaces point at, by URL; '' is the one this dashboard is on. See ranchers.ts. */
  defaultRancher: string;
  focus: FocusPrefs;
}

const EMPTY_FOCUS: FocusPrefs = { pinned: [], snoozed: {}, done: {} };
const EMPTY: DevPrefs = { hiddenApps: [], defaultRancher: '', focus: EMPTY_FOCUS };

/** A record of strings, or an empty one: what came out of JSON is whatever was written. */
function strings(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object') {
    return {};
  }

  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, at]) => typeof at === 'string')) as Record<string, string>;
}
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
      focus:          {
        pinned:  Array.isArray(parsed.focus?.pinned) ? parsed.focus.pinned.filter((key: unknown) => typeof key === 'string') : [],
        snoozed: strings(parsed.focus?.snoozed),
        done:    strings(parsed.focus?.done),
      },
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
