// Agents: conversations that start themselves.
//
// An agent is a prompt (usually a skill) run in a workspace when something happens: a person
// presses Run, a schedule comes round, a call arrives at the in-cluster API, or - next - a
// resource changes. Each run is an ordinary conversation in an ordinary workspace, which is
// the point: what an agent does is what a person would have typed, so everything the PR and
// Review tabs show about a conversation shows about a run.
//
// Definitions and their run history are ConfigMaps in dev-system (one each per agent), so any
// dashboard sees the same agents and the in-cluster API can queue a run for one. The clock is
// the dashboard's: DevSidebar's poll calls tickAgents while any Dev page is open, which starts
// what is due and records what has finished. A dashboard that is closed runs nothing; a run
// that was due while none was open is not made up later.

import {
  devFetch, clusterBase, createWorkspace, listAllWorkspaces, DEV_SYSTEM_NAMESPACE
} from './api';
import { startConversation, startPaneDetached } from './conversations';
import {
  ensureWorkspaceReady, waitForWorkspacePod, queuePrompt, conversationPane
} from './workspace-tools';
import { defaultRancherValues } from './ranchers';
import { DEFAULT_APP } from './config/constants';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Store = any;

export type TriggerType = 'manual' | 'cron' | 'api' | 'resource';

export interface AgentDef {
  name: string;
  description: string;
  /** What the conversation opens with; a skill invocation (`/my-pr-full-review ...`) or prose. */
  prompt: string;
  workspace: {
    /** An existing workspace by name, or a new one per run from an App. */
    mode: 'existing' | 'new';
    name?: string;
    app?: string;
    prefix?: string;
  };
  trigger: {
    type: TriggerType;
    /** Five-field cron, in the browser's local time. */
    cron?: string;
    resource?: { type: string; namespace?: string; event: 'any' | 'created' | 'updated' | 'deleted' };
  };
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AgentRun {
  id: string;
  agent: string;
  trigger: string;
  /** The minute a cron run was for, so one dashboard's tick does not repeat another's. */
  slot?: string;
  workspace: string;
  conversation: string;
  state: 'requested' | 'starting' | 'running' | 'done' | 'failed';
  startedAt: string;
  endedAt?: string;
  note?: string;
}

const BASE = clusterBase('local');
const KIND_LABEL = 'dev.rancher.io/kind';
const AGENT_LABEL = 'dev.rancher.io/agent';
const KEEP_RUNS = 50;

const defName = (name: string) => `dev-agent-${ name }`;
const runsName = (name: string) => `dev-agent-runs-${ name }`;

/** The skill a prompt invokes, when it starts with one. */
export function skillOf(prompt: string): string {
  return /^\s*\/([a-z0-9-]+)/i.exec(prompt || '')?.[1] || '';
}

export function validName(name: string): boolean {
  return /^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$/.test(name);
}

// ── Definitions ─────────────────────────────────────────────────────────────────────────────

function parseDef(cm: Json): AgentDef | null {
  try {
    const def = JSON.parse(cm?.data?.['agent.json'] || '');

    return def?.name ? def : null;
  } catch {
    return null;
  }
}

export async function listAgents(): Promise<AgentDef[]> {
  const cms = await devFetch(`${ BASE }/v1/configmaps/${ DEV_SYSTEM_NAMESPACE }?labelSelector=${ KIND_LABEL }%3Dagent`).catch(() => null);

  return ((cms?.data || []) as Json[])
    .filter((cm) => cm.metadata?.labels?.[KIND_LABEL] === 'agent')
    .map(parseDef)
    .filter((d): d is AgentDef => !!d)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function getAgent(name: string): Promise<AgentDef | null> {
  const cm = await devFetch(`${ BASE }/v1/configmaps/${ DEV_SYSTEM_NAMESPACE }/${ defName(name) }`).catch(() => null);

  return cm ? parseDef(cm) : null;
}

export async function saveAgent(def: AgentDef): Promise<void> {
  if (!validName(def.name)) {
    throw new Error('An agent\'s name is lowercase letters, digits and dashes, up to 40 characters.');
  }
  const url = `${ BASE }/v1/configmaps/${ DEV_SYSTEM_NAMESPACE }/${ defName(def.name) }`;
  const existing = await devFetch(url).catch(() => null);
  const now = new Date().toISOString();
  const body = { ...def, createdAt: def.createdAt || now, updatedAt: now };
  const data = { 'agent.json': JSON.stringify(body) };

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
        namespace: DEV_SYSTEM_NAMESPACE, name: defName(def.name), labels: { [KIND_LABEL]: 'agent', [AGENT_LABEL]: def.name },
      },
      data,
    }),
  });
}

export async function deleteAgent(name: string): Promise<void> {
  await devFetch(`${ BASE }/v1/configmaps/${ DEV_SYSTEM_NAMESPACE }/${ defName(name) }`, { method: 'DELETE' }).catch(() => null);
  await devFetch(`${ BASE }/v1/configmaps/${ DEV_SYSTEM_NAMESPACE }/${ runsName(name) }`, { method: 'DELETE' }).catch(() => null);
}

// ── Runs ────────────────────────────────────────────────────────────────────────────────────

export async function listRuns(name: string): Promise<AgentRun[]> {
  const cm = await devFetch(`${ BASE }/v1/configmaps/${ DEV_SYSTEM_NAMESPACE }/${ runsName(name) }`).catch(() => null);

  try {
    const runs = JSON.parse(cm?.data?.['runs.json'] || '[]');

    return Array.isArray(runs) ? runs : [];
  } catch {
    return [];
  }
}

async function writeRuns(name: string, runs: AgentRun[]): Promise<void> {
  const url = `${ BASE }/v1/configmaps/${ DEV_SYSTEM_NAMESPACE }/${ runsName(name) }`;
  const existing = await devFetch(url).catch(() => null);
  const data = { 'runs.json': JSON.stringify(runs.slice(-KEEP_RUNS)) };

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
        namespace: DEV_SYSTEM_NAMESPACE, name: runsName(name), labels: { [KIND_LABEL]: 'agent-runs', [AGENT_LABEL]: name },
      },
      data,
    }),
  });
}

async function updateRun(name: string, id: string, changes: Partial<AgentRun>): Promise<void> {
  const runs = await listRuns(name);
  const at = runs.findIndex((r) => r.id === id);

  if (at >= 0) {
    runs[at] = { ...runs[at], ...changes };
  }
  await writeRuns(name, runs);
}

// ── Cron ────────────────────────────────────────────────────────────────────────────────────

function fieldMatches(field: string, value: number, low: number): boolean {
  return field.split(',').some((part) => {
    const [range, stepText] = part.trim().split('/');
    const step = stepText ? Number(stepText) : 1;
    let lo = low;
    let hi = 99;

    if (range !== '*') {
      if (range.includes('-')) {
        [lo, hi] = range.split('-').map(Number);
      } else {
        lo = Number(range);
        hi = stepText ? 99 : lo;
      }
    }

    return Number.isFinite(lo) && value >= lo && value <= hi && (value - lo) % (step || 1) === 0;
  });
}

/** Whether a five-field cron expression names this minute. */
export function cronDue(expr: string, at = new Date()): boolean {
  const f = (expr || '').trim().split(/\s+/);

  if (f.length !== 5) {
    return false;
  }

  return fieldMatches(f[0], at.getMinutes(), 0) && fieldMatches(f[1], at.getHours(), 0) &&
    fieldMatches(f[2], at.getDate(), 1) && fieldMatches(f[3], at.getMonth() + 1, 1) && fieldMatches(f[4], at.getDay(), 0);
}

export function cronValid(expr: string): boolean {
  const f = (expr || '').trim().split(/\s+/);

  return f.length === 5 && f.every((x) => /^[\d*,/-]+$/.test(x));
}

/** A few schedules in words, for the form. */
export const CRON_PRESETS = [
  { label: 'Every hour', cron: '0 * * * *' },
  { label: 'Every day at 09:00', cron: '0 9 * * *' },
  { label: 'Weekdays at 09:00', cron: '0 9 * * 1-5' },
  { label: 'Every Monday at 09:00', cron: '0 9 * * 1' },
];

// ── Running ─────────────────────────────────────────────────────────────────────────────────

const inFlight = new Set<string>();

function stamp(): string {
  const d = new Date();
  const two = (n: number) => String(n).padStart(2, '0');

  return `${ d.getFullYear() }${ two(d.getMonth() + 1) }${ two(d.getDate()) }-${ two(d.getHours()) }${ two(d.getMinutes()) }`;
}

function newId(): string {
  return `${ Date.now().toString(36) }${ Math.random().toString(36).slice(2, 6) }`;
}

/**
 * Start one run: the workspace (made if the agent wants a new one), a conversation in it, the
 * prompt queued, and the pane started detached so it runs with nobody watching. Returns as
 * soon as the run is recorded; the rest carries on and updates the record.
 */
export async function runAgent(store: Store, def: AgentDef, trigger = 'manual', existing?: AgentRun): Promise<AgentRun> {
  const workspace = def.workspace.mode === 'new' ? `${ def.workspace.prefix || def.name }-${ stamp() }`.slice(0, 40) : (def.workspace.name || '');

  if (!workspace) {
    throw new Error(`Agent ${ def.name } has no workspace to run in.`);
  }
  const run: AgentRun = existing
    ? {
      ...existing, workspace, state: 'starting', startedAt: new Date().toISOString(),
    }
    : {
      id: newId(), agent: def.name, trigger, workspace, conversation: '', state: 'starting', startedAt: new Date().toISOString(),
    };

  if (existing) {
    await updateRun(def.name, run.id, run);
  } else {
    await writeRuns(def.name, [...(await listRuns(def.name)), run]);
  }
  inFlight.add(run.id);

  drive(store, def, run);

  return run;
}

/**
 * The steps of a run, each recorded as it is reached, so a dashboard that closes halfway
 * leaves a record the next tick can pick up from: a conversation already made is reused, a
 * workspace already there is not made again, and the pane start is safe to repeat.
 */
async function drive(store: Store, def: AgentDef, run: AgentRun): Promise<void> {
  const workspace = run.workspace;

  inFlight.add(run.id);
  try {
    const have = (await listAllWorkspaces().catch(() => [])).some((w) => w.name === workspace);

    if (!have) {
      await updateRun(def.name, run.id, { note: 'making the workspace' });
      await createWorkspace(store, workspace, def.workspace.app || DEFAULT_APP, undefined, await defaultRancherValues());
    }
    let conversation = run.conversation;

    if (!conversation) {
      conversation = (await startConversation(workspace, `${ def.name } · ${ new Date().toLocaleString([], {
        month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
      }) }`)).id;
      await updateRun(def.name, run.id, { conversation, note: 'waiting for the workspace pod' });
    }
    await waitForWorkspacePod(workspace);
    await updateRun(def.name, run.id, { note: 'preparing the workspace' });
    await ensureWorkspaceReady(workspace);
    await updateRun(def.name, run.id, { note: 'starting the conversation' });
    await queuePrompt(workspace, conversation, def.prompt);
    await startPaneDetached(workspace, conversation);
    await updateRun(def.name, run.id, { state: 'running', note: '' });
  } catch (e: Json) {
    await updateRun(def.name, run.id, { state: 'failed', note: e?.message || String(e), endedAt: new Date().toISOString() }).catch(() => {});
  } finally {
    inFlight.delete(run.id);
  }
}

const BUSY = /esc to interrupt|Interrupt ·|tokens · esc|⏳|Thinking…|Working…/i;
let ticking = false;
let lastTick = 0;

/**
 * The clock: start what is due, pick up what the API queued, and record what has finished.
 * Called from the sidebar's poll; cheap when there are no agents.
 */
export async function tickAgents(store: Store): Promise<void> {
  if (ticking || Date.now() - lastTick < 20_000) {
    return;
  }
  ticking = true;
  lastTick = Date.now();
  try {
    const agents = await listAgents();

    if (!agents.length) {
      return;
    }
    const now = new Date();
    const slot = now.toISOString().slice(0, 16);

    for (const def of agents) {
      const runs = await listRuns(def.name);

      // A cron agent whose minute this is, once per minute across every open dashboard.
      if (def.enabled && def.trigger.type === 'cron' && def.trigger.cron && cronDue(def.trigger.cron, now) && !runs.some((r) => r.slot === slot)) {
        await runAgent(store, def, 'cron', {
          id: newId(), agent: def.name, trigger: 'cron', slot, workspace: '', conversation: '', state: 'requested', startedAt: now.toISOString(),
        }).catch(() => {});
      }

      // Runs the in-cluster API asked for.
      for (const r of runs.filter((x) => x.state === 'requested' && !x.slot)) {
        if (def.enabled) {
          await runAgent(store, def, r.trigger || 'api', r).catch(() => {});
        }
      }

      // Runs a dashboard was driving when it closed: nothing has touched them for a while,
      // and this one is not driving them. Picked up where they were left.
      for (const r of runs.filter((x) => x.state === 'starting' && !inFlight.has(x.id) && Date.now() - Date.parse(x.startedAt) > 4 * 60_000)) {
        drive(store, def, r).catch(() => {});
      }

      // Runs that are over: the pane is gone, or claude is back at its prompt.
      for (const r of runs.filter((x) => x.state === 'running' && x.conversation && !inFlight.has(x.id))) {
        const pane = await conversationPane(r.workspace, r.conversation, 30).catch(() => null);

        if (pane && (!pane.running || !BUSY.test(pane.text)) && Date.now() - Date.parse(r.startedAt) > 90_000) {
          await updateRun(def.name, r.id, { state: 'done', endedAt: new Date().toISOString() }).catch(() => {});
        }
      }
    }
  } finally {
    ticking = false;
  }
}
