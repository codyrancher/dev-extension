// Automations: what runs by itself, and what sets it off.
//
// An automation is an action - an agent conversation (a prompt, usually a skill) or a script -
// and what starts it: a person pressing Run, a schedule, a call to the in-cluster API, a resource
// changing, or an event from the Automations page's log (a workspace's stage moving, something
// happening on an assigned GitHub issue or PR). An agent run is an ordinary conversation in the
// agents drawer; a script runs in the agent pod as the pane user, with the event on stdin.
//
// Definitions are ConfigMaps in dev-system, one per automation (`dev-agent-<name>`: the name is
// from when these were only agents), so every dashboard sees the same ones. dev-api runs them:
// it records the events, puts each to every automation, keeps the schedules and starts the runs,
// so nothing waits for a dashboard to be open (dev-api/automation-rules.mjs and the Automations
// section of dev-api/server.mjs). The one trigger still watched from here is a resource change,
// which is read through the person's own Rancher session: DevSidebar's poll calls tickAgents.

import { devFetch, clusterBase, DEV_SYSTEM_NAMESPACE } from './api';
import { devApi } from './reviews';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Store = any;

export type TriggerType = 'manual' | 'cron' | 'api' | 'resource' | 'event';

export interface Trigger {
  type: TriggerType;
  /** Five-field cron, in the zone the definition saves as `tz`. */
  cron?: string;
  resource?: ResourceTrigger;
  event?: EventTrigger;
}

/** An event from the Automations log: which source, which names, and the constraints. */
export interface EventTrigger {
  /** `github`, `workspace`, or '' for either. */
  source: string;
  /** Event names, `*` a wildcard: `pr.commented`, `pr.*`, `*.closed`. None is every name. */
  names: string[];
  /** One JavaScript expression per line, over `event`/`e`, `payload`/`p` and `me`; all must hold. */
  condition?: string;
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
  /** What it does: an agent conversation (the default) or a script. */
  action?: 'agent' | 'script';
  /** What the conversation opens with; a skill invocation (`/my-pr-full-review ...`) or prose. */
  prompt: string;
  /** The script, for a script automation: bash unless it starts with `#!`. */
  script?: string;
  /** How long a script may run, in seconds. */
  timeoutSec?: number;
  /** The zone the schedule is written in: the browser's, saved with it. */
  tz?: string;
  /** What sets it off: by hand always, and any of a schedule, an API call, a resource change. */
  triggers: Trigger[];
  /** Definitions before 0.3.17 had one trigger and a workspace to run in; read, never written. */
  trigger?: Trigger;
  workspace?: { mode: 'existing' | 'new'; name?: string; app?: string; prefix?: string };
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

/** One run, as dev-api records it. */
export interface AgentRun {
  id: string;
  automation?: string;
  /** From before the history moved to dev-api. */
  agent?: string;
  kind?: 'agent' | 'script';
  trigger: string;
  /** The event that started it, when one did. */
  event?: { id: string; source: string; name: string; subject: string; title: string; url: string; workspace: string } | null;
  /** What a resource trigger or an API call said about why. */
  context?: Record<string, string> | null;
  /** Runs before 0.3.17 were conversations in a workspace. */
  workspace?: string;
  /** The drawer conversation an agent run is. */
  conversation: string;
  state: 'requested' | 'starting' | 'running' | 'waiting' | 'done' | 'failed';
  startedAt: string;
  endedAt?: string;
  exitCode?: number | null;
  /** An agent's last word, or a script's last line. */
  result?: string;
  note?: string;
}

const BASE = clusterBase('local');
const KIND_LABEL = 'dev.rancher.io/kind';
const AGENT_LABEL = 'dev.rancher.io/agent';

const defName = (name: string) => `dev-agent-${ name }`;

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

export function skillOf(prompt: string): string {
  return /^\s*\/([a-z0-9-]+)/i.exec(prompt || '')?.[1] || '';
}

/** Words the API's own paths use under /automations, which no automation can be called. */
const RESERVED = new Set(['events', 'status', 'runs', 'mutes']);

export function validName(name: string): boolean {
  return /^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$/.test(name) && !RESERVED.has(name);
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
  await devFetch(`${ BASE }/v1/configmaps/${ DEV_SYSTEM_NAMESPACE }/dev-agent-runs-${ name }`, { method: 'DELETE' }).catch(() => null);
  await devFetch(`${ BASE }/v1/configmaps/${ DEV_SYSTEM_NAMESPACE }/dev-agent-watch-${ name }`, { method: 'DELETE' }).catch(() => null);
  await devApi(`/automations/${ name }/runs`, { method: 'DELETE' }).catch(() => null);
}

// ── Runs ────────────────────────────────────────────────────────────────────────────────────
//
// dev-api keeps them, beside each run's output, and starts them; see its Automations section.

export async function listRuns(name: string): Promise<AgentRun[]> {
  const answer = await devApi(`/automations/${ name }/runs`).catch(() => null);

  return Array.isArray(answer?.runs) ? answer.runs : [];
}

/** Run an automation now: by hand, for an API call or a resource, or on one recorded event. */
export async function runAutomation(name: string, body: { trigger?: string; context?: Record<string, string>; note?: string; eventId?: string } = {}): Promise<AgentRun> {
  const answer = await devApi(`/automations/${ name }/run`, { method: 'POST', body: JSON.stringify(body) });

  return answer?.run;
}

// ── Cron ────────────────────────────────────────────────────────────────────────────────────

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

  for (const [i, change] of fire.slice(0, BURST).entries()) {
    const context = contextOf(spec, change.event, change.id, change.seen, change.resource);
    // Said on the last run rather than swallowed: a filter that matches forty things at once is
    // a filter to narrow, and the person has to be able to see that it did.
    const note = i === BURST - 1 && fire.length > BURST ? `${ fire.length } resources changed at once; ${ BURST } runs started` : '';

    await runAutomation(def.name, { trigger: 'resource', context, note }).catch(() => {});
  }
}

let ticking = false;
let lastTick = 0;

/**
 * The browser's part of the clock: resource triggers, which are read through the person's own
 * Rancher session and so cannot be watched from dev-api. Everything else - schedules, events, API
 * calls, seeing a run finish - is dev-api's. Called from the sidebar's poll; cheap when no
 * automation watches a resource.
 */
export async function tickAgents(store: Store): Promise<void> {
  if (ticking || Date.now() - lastTick < 20_000) {
    return;
  }
  ticking = true;
  lastTick = Date.now();
  try {
    for (const def of await listAgents()) {
      for (const t of triggersOf(def)) {
        if (t.type === 'resource' && t.resource?.type) {
          await watchResources(store, def, t.resource).catch(() => {});
        }
      }
    }
  } finally {
    ticking = false;
  }
}
