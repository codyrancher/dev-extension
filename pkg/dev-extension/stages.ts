// The stage a workspace is at, stored rather than guessed afresh every time.
//
// The stage used to be re-derived on every read from whatever GitHub and the agent happened to say
// that second, so one flaky read - a PR mis-linked to a passing mention, an agent that went briefly
// idle - moved the rail to the wrong step and moved it back a poll later. This keeps the stage
// instead, and lets it change only on signals worth trusting:
//
// (A read that outright FAILS is a separate defence: prDetail throws, the caller keeps the last
// value, and getStore below tells a failed store read apart from an empty store. What this does not
// second-guess is a hard fact from a read that SUCCEEDED - a merge, a review, a reviewer's reply -
// which is taken as ground truth. The one such fact that a degraded read can get wrong, the viewer's
// own identity coming back blank, is marked soft at its source in reviewWork so it cannot regress a
// stored stage.)
//
//  - A HARD signal - a real GitHub fact: the PR merged, a genuinely-linked PR opened, a review was
//    submitted, a reviewer replied. These always win, and they release a manual hold, because they
//    are ground truth and ground truth is what the person set the stage by hand to stand in for.
//  - A SOFT signal - the agent's own busy/idle state, or a default. These never undo a stored stage;
//    they only fill one in that was never set, or carry a pre-PR workspace from Assess to Code.
//  - A MANUAL choice - the person set the stage themselves. It holds against every soft signal and
//    is superseded only when a hard fact overtakes it (the chosen behaviour: hold until ground truth).
//
// Durable and shared: one ConfigMap in dev-system, so every viewer and device sees the same stage and
// it survives a reload. Written only when the stage actually changes, so it is not churned each poll.
import { devFetch, DEV_SYSTEM_NAMESPACE, clusterBase } from './api';
import type { Stage, FixStage, ReviewStage } from './workspace-status';
import { STAGE_LABELS } from './workspace-status';

type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any

/** What is kept for one workspace. `hard` records whether the stored stage came from a hard signal. */
export interface StageRecord {
  stage: Stage;
  stageLabel?: string;
  /** The person set this stage; it holds until a hard fact overtakes it. */
  manual: boolean;
  /** The stored stage came from a hard signal (or a manual choice); a soft read must not undo it. */
  hard: boolean;
  round: number;
  reviewed: boolean;
  /** The PR the stage was about when stored, for context; the live PR is read fresh elsewhere. */
  pr: number;
  at: string;
}

/** A freshly-derived stage, before the store has its say. `soft` marks an agent-state-only guess. */
export interface DerivedStage {
  kind: 'fix' | 'review';
  stage: Stage;
  stageLabel?: string;
  soft: boolean;
  round: number;
  reviewed: boolean;
  pr: number;
}

// How advanced each stage is within its kind, so a soft signal can carry a workspace forward but not
// back. A hard signal ignores this - a review dropping from Approved back to Your pass on a new round
// is real progress, not a regression - so ranking only ever gates soft moves.
const FIX_ORDER: FixStage[] = ['assess', 'code', 'draft', 'review', 'feedback', 'merged'];
const REVIEW_ORDER: ReviewStage[] = ['agent', 'findings', 'submitted', 'response', 'approved'];

function rank(kind: 'fix' | 'review', stage: Stage): number {
  const order: string[] = kind === 'review' ? REVIEW_ORDER : FIX_ORDER;
  const i = order.indexOf(stage);

  return i < 0 ? 0 : i;
}

const CONFIGMAP = 'dev-workspace-stages';
const KIND_LABEL = 'dev.rancher.io/kind';
const DATA_KEY = 'stages.json';
// Always local: the store is a property of the workspaces, and dev-system is on the local cluster.
const BASE = clusterBase('local');
const URL = `${ BASE }/v1/configmaps/${ DEV_SYSTEM_NAMESPACE }/${ CONFIGMAP }`;
/** How long the in-memory copy is trusted before another read picks up another device's change. */
const REFRESH_MS = 60_000;

let cache: Record<string, StageRecord> = {};
let loadedAt = 0;
let loading: Promise<void> | null = null;

function parse(cm: Json): Record<string, StageRecord> {
  try {
    const parsed = JSON.parse(cm?.data?.[DATA_KEY] || '{}');

    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Read the store, telling three cases apart that a plain devFetch would collapse into one: it is
 * there (200 with a body), it does not exist yet (404), or the read said nothing about the store (a
 * token blip, a 5xx, the network, or a 200 whose body would not parse). The last must NOT be read as
 * "the store is empty" - that is exactly the transient this whole file exists to survive, and
 * treating it as empty would wipe the copy in memory and re-derive every stage from scratch.
 */
async function getStore(): Promise<{ status: number; cm: Json | null }> {
  try {
    const resp = await fetch(URL, { headers: { Accept: 'application/json' } });

    if (resp.status === 404) {
      return { status: 404, cm: null };
    }
    if (!resp.ok) {
      return { status: resp.status, cm: null };
    }
    const cm = await resp.json().catch(() => null);

    // A 200 with no readable body is as uninformative as a failed read - do not treat it as empty.
    return cm ? { status: 200, cm } : { status: 0, cm: null };
  } catch {
    return { status: 0, cm: null };
  }
}

/** Read the store once, then keep the copy for REFRESH_MS; concurrent callers share the one read. */
async function ensureLoaded(): Promise<void> {
  if (Date.now() - loadedAt < REFRESH_MS) {
    return;
  }
  if (!loading) {
    loading = (async() => {
      const { status, cm } = await getStore();

      if (status === 404) {
        cache = {}; // genuinely no store yet
        loadedAt = Date.now();
      } else if (status === 200) {
        // The server's copy wins for every workspace this device has NOT changed and not yet
        // flushed; the pending changes are laid back on top so a load mid-flush cannot lose them.
        cache = { ...parse(cm), ...dirty };
        loadedAt = Date.now();
      } else {
        // A read that failed for a transient reason: keep the copy we have, and try again soon
        // rather than after the full REFRESH_MS, so a stage does not sit unreconciled for a minute.
        loadedAt = Date.now() - REFRESH_MS + 5_000;
      }
      loading = null;
    })();
  }
  await loading;
}

// Writes are coalesced through one queue. Every change is recorded in `dirty` and in the in-memory
// cache at once (so a read right after sees it), and a single flush folds all pending changes onto
// the server's current copy: the server wins for workspaces this device did not touch (another
// device's newer write survives), and every pending local change wins over the server (so two
// workspaces changing in one tick do not revert each other). A batch that fails to write is kept
// dirty and retried by the next change.
let dirty: Record<string, StageRecord> = {};
let flushing: Promise<void> = Promise.resolve();

function save(name: string, record: StageRecord): Promise<void> {
  cache[name] = record;
  dirty[name] = record;
  flushing = flushing.then(flush).catch(() => { /* kept dirty; the next change retries */ });

  return flushing;
}

async function flush(): Promise<void> {
  const pending = dirty;

  if (!Object.keys(pending).length) {
    return;
  }
  dirty = {};
  const { status, cm } = await getStore();

  // A transient read: do not write (a create would 409 over a store that is really there, a PUT
  // would carry a stale copy). Put the batch back, keeping any change made since we took it.
  if (status !== 200 && status !== 404) {
    dirty = { ...pending, ...dirty };

    return;
  }
  const merged = { ...cache, ...parse(cm), ...pending };

  cache = merged;
  const data = { [DATA_KEY]: JSON.stringify(merged) };

  try {
    if (status === 200 && cm) {
      await devFetch(URL, { method: 'PUT', body: JSON.stringify({ ...cm, data }) });

      return;
    }
    await devFetch(`${ BASE }/v1/configmaps`, {
      method: 'POST',
      body:   JSON.stringify({
        apiVersion: 'v1',
        kind:       'ConfigMap',
        metadata:   { namespace: DEV_SYSTEM_NAMESPACE, name: CONFIGMAP, labels: { [KIND_LABEL]: 'workspace-stages' } },
        data,
      }),
    });
  } catch {
    // The write failed (a lost resourceVersion race, a blip): keep the batch dirty to try again.
    dirty = { ...pending, ...dirty };
  }
}

function recordOf(d: DerivedStage, manual: boolean, hard: boolean): StageRecord {
  return {
    stage: d.stage, stageLabel: d.stageLabel, manual, hard, round: d.round, reviewed: d.reviewed, pr: d.pr, at: new Date().toISOString(),
  };
}

function same(a: StageRecord, b: StageRecord): boolean {
  return a.stage === b.stage && a.stageLabel === b.stageLabel && a.manual === b.manual && a.hard === b.hard && a.round === b.round && a.reviewed === b.reviewed;
}

/**
 * The stored stage for a workspace, reconciled with what was just derived. This is where the trust
 * rules live: a hard fact wins (and releases a manual hold), a soft guess never undoes a stored
 * stage, a manual choice holds until a hard fact overtakes it. Writes the store only on a change.
 */
export async function reconcileStage(name: string, d: DerivedStage): Promise<StageRecord> {
  await ensureLoaded();
  const stored = cache[name];

  const accept = (manual: boolean, hard: boolean): StageRecord => {
    const rec = recordOf(d, manual, hard);

    if (!stored || !same(stored, rec)) {
      void save(name, rec);
    } else {
      cache[name] = rec; // keep `at`/pr fresh in memory without a write
    }

    return rec;
  };

  if (!stored) {
    return accept(false, !d.soft);
  }
  if (stored.manual) {
    // Held by the person: only a hard fact overtakes it. A soft guess leaves the manual stage be.
    return d.soft ? stored : accept(false, true);
  }
  if (!d.soft) {
    return accept(false, true); // a hard fact always wins over an auto stage
  }
  // A soft guess: never undo a stored stage. Carry a still-soft workspace forward within its kind
  // (Assess -> Code), and otherwise keep exactly what is stored.
  if (!stored.hard && rank(d.kind, d.stage) > rank(d.kind, stored.stage)) {
    return accept(false, false);
  }

  return stored;
}

/** The person sets the stage by hand. It holds until a hard fact overtakes it. */
export async function setManualStage(name: string, stage: Stage): Promise<StageRecord> {
  await ensureLoaded();
  const prev = cache[name];
  const rec: StageRecord = {
    stage,
    stageLabel: STAGE_LABELS[stage],
    manual:     true,
    hard:       true,
    round:      prev?.round || 1,
    reviewed:   prev?.reviewed || false,
    pr:         prev?.pr || 0,
    at:         new Date().toISOString(),
  };

  await save(name, rec);

  return rec;
}

/** Hand the stage back to the automatic heuristics; the next read reconciles it. */
export async function clearManualStage(name: string): Promise<void> {
  await ensureLoaded();
  const prev = cache[name];

  if (!prev?.manual) {
    return;
  }
  await save(name, { ...prev, manual: false, hard: false, at: new Date().toISOString() });
}

/** Whether the person is holding a workspace's stage by hand - so the page can offer to release it. */
export function isManual(name: string): boolean {
  return !!cache[name]?.manual;
}
