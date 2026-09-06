// Agents: conversations that start themselves.
//
// An agent is a prompt (usually a skill) run in a workspace when something happens: a person
// presses Run, a schedule comes round, a call arrives at the in-cluster API, or - next - a
// resource changes. Each run is an ordinary conversation in the agents drawer, which is
// the point: what an agent does is what a person would have typed, so everything the PR and
// Review tabs show about a conversation shows about a run.
//
// Definitions and their run history are ConfigMaps in dev-system (one each per agent), so any
// dashboard sees the same agents and the in-cluster API can queue a run for one. The clock is
// the dashboard's: DevSidebar's poll calls tickAgents while any Dev page is open, which starts
// what is due and records what has finished. A dashboard that is closed runs nothing; a run
// that was due while none was open is not made up later.

import {
  devFetch, clusterBase, DEV_SYSTEM_NAMESPACE
, podExecOnce
} from './api';
import { waitForStudio } from './conversations';
import type { StudioBrowserApi } from './conversations';
import {
  conversationPane
} from './workspace-tools';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Store = any;

export type TriggerType = 'manual' | 'cron' | 'api' | 'resource';

export interface Trigger {
  type: TriggerType;
  /** Five-field cron, in the browser's local time. */
  cron?: string;
  resource?: ResourceTrigger;
}

export interface ResourceTrigger {
  /** A steve type: `management.cattle.io.cluster`, `pod`, `catalog.cattle.io.app`. */
  type: string;
  namespace?: string;
  event: 'any' | 'created' | 'updated' | 'deleted';
  /**
   * Which of them, as a JavaScript expression over `resource` (alias `r`) and `event`. Empty
   * means all of them. `r.spec.displayName === 'prod'`, `r.status.conditions.some(c => c.type
   * === 'Ready' && c.status !== 'True')`, `!r.metadata.name.startsWith('helm-operation-')`.
   */
  filter?: string;
  /** Only when the filter starts matching, rather than on every change while it matches. */
  edge?: boolean;
}

export interface AgentDef {
  name: string;
  description: string;
  /** What the conversation opens with; a skill invocation (`/my-pr-full-review ...`) or prose. */
  prompt: string;
  /** What sets it off: by hand always, and any of a schedule, an API call, a resource change. */
  triggers: Trigger[];
  /** Definitions before 0.3.17 had one trigger and a workspace to run in; read, never written. */
  trigger?: Trigger;
  workspace?: { mode: 'existing' | 'new'; name?: string; app?: string; prefix?: string };
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
  /** Runs before 0.3.17 were conversations in a workspace; now they are the agents drawer's. */
  workspace: string;
  /** The drawer conversation (`agent-<n>`) the run is. */
  conversation: string;
  state: 'requested' | 'starting' | 'running' | 'done' | 'failed';
  /** What set this run off, for the prompt's placeholders: name, namespace, type, event. */
  context?: Record<string, string>;
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
/** What sets an agent off: its list, or the one trigger a definition from before 0.3.17 had. */
export function triggersOf(def: Pick<AgentDef, 'triggers' | 'trigger'>): Trigger[] {
  if (def.triggers?.length) {
    return def.triggers;
  }

  return def.trigger ? [def.trigger] : [{ type: 'manual' }];
}

/**
 * The filter, as a function of the resource and the event.
 *
 * An expression by default (`r.spec.displayName === 'prod'`), a body when it says `return`.
 * It is the person's own JavaScript, run in their own browser over data their own Rancher
 * gave them - the same trust as the prompt beside it, which drives an agent with their
 * credentials. A filter that throws matches nothing rather than everything: a mistake in it
 * should start no conversations, not all of them.
 */
export function compileFilter(src?: string): (resource: Json, event: string) => boolean {
  const text = (src || '').trim();

  if (!text) {
    return () => true;
  }
  const body = /\breturn\b/.test(text) ? text : `return (${ text });`;

  try {
    // eslint-disable-next-line no-new-func
    const fn = new Function('resource', 'event', 'r', body) as (resource: Json, event: string, r: Json) => unknown;

    return (resource, event) => {
      try {
        return !!fn(resource, event, resource);
      } catch {
        return false;
      }
    };
  } catch {
    return () => false;
  }
}

/** Why a filter will not compile, for the editor to say so before it is saved. */
export function filterError(src?: string): string {
  const text = (src || '').trim();

  if (!text) {
    return '';
  }
  try {
    // eslint-disable-next-line no-new-func
    new Function('resource', 'event', 'r', /\breturn\b/.test(text) ? text : `return (${ text });`);

    return '';
  } catch (e: Json) {
    return e?.message || String(e);
  }
}

/** The placeholders a prompt may carry, filled from what set the run off. */
export const PROMPT_KEYS = ['name', 'namespace', 'type', 'event'];

export function fillPrompt(prompt: string, context?: Record<string, string>): string {
  if (!context) {
    return prompt;
  }

  return prompt.replace(/\{\{\s*(\w+)\s*\}\}/g, (whole, key) => (key in context ? context[key] : whole));
}

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

    if (!def?.name) {
      return null;
    }
    def.triggers = triggersOf(def);

    return def;
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


function newId(): string {
  return `${ Date.now().toString(36) }${ Math.random().toString(36).slice(2, 6) }`;
}

/**
 * Start one run: the workspace (made if the agent wants a new one), a conversation in it, the
 * prompt queued, and the pane started detached so it runs with nobody watching. Returns as
 * soon as the run is recorded; the rest carries on and updates the record.
 */
export async function runAgent(store: Store, def: AgentDef, trigger = 'manual', existing?: AgentRun, context?: Record<string, string>): Promise<AgentRun> {
  // Every run is a conversation in the agents drawer, here on the local cluster: the agents
  // extension's pod holds it, and the strip at the bottom of the dashboard shows it.
  const workspace = '';
  const run: AgentRun = existing
    ? {
      ...existing, workspace, state: 'starting', startedAt: new Date().toISOString(),
    }
    : {
      id: newId(), agent: def.name, trigger, workspace, conversation: '', state: 'starting', context, startedAt: new Date().toISOString(),
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
  inFlight.add(run.id);
  try {
    const api = await waitForStudio();

    if (!api) {
      throw new Error('The agents extension is not loaded, so nothing can hold the conversation.');
    }
    let conversation = run.conversation;

    if (!conversation) {
      await updateRun(def.name, run.id, { note: 'opening a conversation' });
      conversation = await api.agent.start();
      await api.agent.rename(conversation, `${ def.name } · ${ new Date().toLocaleString([], {
        month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
      }) }`).catch(() => {});
      await updateRun(def.name, run.id, { conversation });
    }
    await updateRun(def.name, run.id, { note: 'starting the conversation' });
    await api.agent.queue(conversation, fillPrompt(def.prompt, run.context));
    await startDrawerPane(api, conversation);
    await updateRun(def.name, run.id, { state: 'running', note: '' });
  } catch (e: Json) {
    await updateRun(def.name, run.id, { state: 'failed', note: e?.message || String(e), endedAt: new Date().toISOString() }).catch(() => {});
  } finally {
    inFlight.delete(run.id);
  }
}

/**
 * Start a drawer conversation's pane with nobody attached: the same argv a terminal tab would
 * run, with `start` for the mode, so shell.sh makes the tmux session detached and claude in it
 * reads what was queued. Run in the agent pod, which is where drawer conversations live.
 */
async function startDrawerPane(api: StudioBrowserApi, id: string): Promise<void> {
  const pod = await api.agent.pod();

  if (!pod) {
    throw new Error('The agent pod is not running, so there is nothing to start the conversation in.');
  }
  const argv = api.agent.command(id, 'claude');
  const last = argv.length - 1;
  const detached = ['claude', 'shell'].includes(argv[last]) ? [...argv.slice(0, last), 'start'] : argv;

  await podExecOnce(api.agent.namespace, pod, api.agent.container, detached);
}

// ── Watching resources ────────────────────────────────────────────────────────────────────
//
// The clock is a dashboard (see the note at the top), so the watch is a poll on the same tick:
// list the type, compare it with what was there last time, and start a run for each change the
// filter accepts. What was there last time is a ConfigMap beside the agent - shared, so two
// open dashboards agree on what has already been seen, and written *before* anything is
// started, with the resourceVersion it was read at: the dashboard whose write is refused lost
// the race and starts nothing, which is what keeps one change from becoming two conversations.

const watchName = (name: string) => `dev-agent-watch-${ name }`;

/** One resource, as last seen: its version, whether the filter matched it, and what it is. */
interface Seen {
  rv: string;
  m?: boolean;
  n?: string;
  ns?: string;
}

/** How many resources of a type are watched. A list longer than this is watched to here and no further. */
const WATCH_LIMIT = 4000;
/** How many conversations one change of heart may start at once. */
const BURST = 3;

function watchKey(spec: ResourceTrigger): string {
  return `${ spec.type }/${ spec.namespace || '' }`;
}

async function readWatch(name: string): Promise<{ cm: Json; state: Record<string, Record<string, Seen>> }> {
  const cm = await devFetch(`${ BASE }/v1/configmaps/${ DEV_SYSTEM_NAMESPACE }/${ watchName(name) }`).catch(() => null);

  try {
    return { cm, state: JSON.parse(cm?.data?.['seen.json'] || '{}') };
  } catch {
    return { cm, state: {} };
  }
}

/**
 * Write the baseline back, and say whether this dashboard is the one that got to. A create
 * that collides, or a put against a version somebody else has already replaced, both mean
 * another dashboard has recorded these same changes and is starting the runs for them.
 */
async function writeWatch(name: string, cm: Json, state: Record<string, Record<string, Seen>>): Promise<boolean> {
  const data = { 'seen.json': JSON.stringify(state) };

  try {
    if (cm) {
      await devFetch(`${ BASE }/v1/configmaps/${ DEV_SYSTEM_NAMESPACE }/${ watchName(name) }`, { method: 'PUT', body: JSON.stringify({ ...cm, data }) });
    } else {
      await devFetch(`${ BASE }/v1/configmaps`, {
        method: 'POST',
        body:   JSON.stringify({
          apiVersion: 'v1',
          kind:       'ConfigMap',
          metadata:   {
            namespace: DEV_SYSTEM_NAMESPACE, name: watchName(name), labels: { [KIND_LABEL]: 'agent-watch', [AGENT_LABEL]: name },
          },
          data,
        }),
      });
    }

    return true;
  } catch {
    return false;
  }
}

/** Everything a fired run is told about what fired it: the prompt's placeholders and the note. */
function contextOf(spec: ResourceTrigger, event: string, id: string, seen: Seen | undefined, resource: Json): Record<string, string> {
  return {
    type:      spec.type,
    event,
    name:      resource?.metadata?.name || seen?.n || id.split('/').pop() || '',
    namespace: resource?.metadata?.namespace || seen?.ns || (id.includes('/') ? id.split('/')[0] : ''),
  };
}

/**
 * One resource trigger, once. Nothing is started the first time an agent looks at a type: a
 * watch that fired for everything already there would open a conversation per cluster the
 * moment it was saved. That first pass records the baseline, and changes from then on fire.
 */
async function watchResources(store: Store, def: AgentDef, spec: ResourceTrigger): Promise<void> {
  if (!spec.type) {
    return;
  }
  const url = `${ BASE }/v1/${ spec.type }${ spec.namespace ? `/${ spec.namespace }` : '' }`;
  const list = await devFetch(url).catch(() => null);

  // A type this Rancher does not have, or one this person may not list: nothing to say about
  // it, and nothing to write down either.
  if (!Array.isArray(list?.data)) {
    return;
  }
  const key = watchKey(spec);
  const { cm, state } = await readWatch(def.name);
  const before = state[key];
  const first = !before;
  const seen = before || {};
  const filter = compileFilter(spec.filter);
  const next: Record<string, Seen> = {};
  const fire: { event: string; id: string; resource: Json; seen?: Seen }[] = [];

  for (const resource of list.data.slice(0, WATCH_LIMIT)) {
    const id = resource.id || resource.metadata?.uid || `${ resource.metadata?.namespace || '' }/${ resource.metadata?.name }`;
    const rv = String(resource.metadata?.resourceVersion || '');
    const was = seen[id];
    const matches = filter(resource, was ? 'updated' : 'created');

    next[id] = {
      rv, m: matches, n: resource.metadata?.name, ns: resource.metadata?.namespace,
    };

    if (first) {
      continue;
    }
    const event = was ? 'updated' : 'created';

    if (was && was.rv === rv) {
      continue;
    }
    if (spec.event !== 'any' && spec.event !== event) {
      continue;
    }
    // `edge` is the difference between "while it is unhealthy" and "when it becomes
    // unhealthy": a resource that already matched last time is not fired for again.
    if (matches && !(spec.edge && was?.m)) {
      fire.push({ event, id, resource });
    }
  }

  if (!first && ['any', 'deleted'].includes(spec.event)) {
    for (const [id, was] of Object.entries(seen)) {
      if (next[id]) {
        continue;
      }
      // What is gone cannot be read, so the filter sees the shape of it: its name and
      // namespace, and whether it matched when it was last there.
      const gone = { id, metadata: { name: was.n, namespace: was.ns } };

      if (filter(gone, 'deleted')) {
        fire.push({
          event: 'deleted', id, resource: gone, seen: was,
        });
      }
    }
  }

  if (!first && !fire.length) {
    // Versions still move on; recording them is what keeps the next tick from re-reporting.
    if (JSON.stringify(before) !== JSON.stringify(next)) {
      state[key] = next;
      await writeWatch(def.name, cm, state);
    }

    return;
  }

  state[key] = next;
  if (!await writeWatch(def.name, cm, state)) {
    return;
  }
  if (first || !def.enabled) {
    return;
  }

  for (const change of fire.slice(0, BURST)) {
    const context = contextOf(spec, change.event, change.id, change.seen, change.resource);

    await runAgent(store, def, 'resource', undefined, context).catch(() => {});
  }
  if (fire.length > BURST) {
    // Said on the last run rather than swallowed: a filter that matches forty things at once
    // is a filter to narrow, and the person has to be able to see that it did.
    const runs = await listRuns(def.name);
    const last = runs[runs.length - 1];

    if (last) {
      await updateRun(def.name, last.id, { note: `${ fire.length } resources changed at once; ${ BURST } runs started` }).catch(() => {});
    }
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

      // A schedule whose minute this is, once per minute across every open dashboard.
      const due = triggersOf(def).some((t) => t.type === 'cron' && t.cron && cronDue(t.cron, now));

      if (def.enabled && due && !runs.some((r) => r.slot === slot)) {
        await runAgent(store, def, 'cron', {
          id: newId(), agent: def.name, trigger: 'cron', slot, workspace: '', conversation: '', state: 'requested', startedAt: now.toISOString(),
        }).catch(() => {});
      }

      // Resources that changed since the last look.
      for (const t of triggersOf(def)) {
        if (t.type === 'resource' && t.resource?.type) {
          await watchResources(store, def, t.resource).catch(() => {});
        }
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
        const pane = r.workspace
          ? await conversationPane(r.workspace, r.conversation, 30).catch(() => null)
          : await (await waitForStudio())?.agent.pane(r.conversation, 30).catch(() => null);

        if (pane && (!pane.running || !BUSY.test(pane.text)) && Date.now() - Date.parse(r.startedAt) > 90_000) {
          await updateRun(def.name, r.id, { state: 'done', endedAt: new Date().toISOString() }).catch(() => {});
        }
      }
    }
  } finally {
    ticking = false;
  }
}
