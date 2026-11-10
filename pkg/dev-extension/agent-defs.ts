// Automations: what runs by itself, and what sets it off.
//
// An automation is an action - an agent conversation (a prompt, usually a skill), a script, or a
// review of a pull request as My Work's Review button does it - and what starts it: a person pressing Run, a schedule, a call to the in-cluster API, a resource
// changing, or an event from the Automations page's log (a workspace's stage moving, something
// happening on an assigned GitHub issue or PR). An agent run is an ordinary conversation in the
// agents drawer; a script runs in the agent pod as the pane user, with the event on stdin.
//
// Definitions are ConfigMaps in dev-system, one per automation (`dev-agent-<name>`: the name is
// from when these were only agents), so every dashboard sees the same ones. dev-api runs them:
// it records the events, puts each to every automation, keeps the schedules and starts the runs,
// so nothing waits for a dashboard to be open (dev-api/automation-rules.mjs and the Automations
// and Resource triggers sections of dev-api/server.mjs).

import { devFetch, clusterBase, DEV_SYSTEM_NAMESPACE } from './api';
import { devApi, startPrReview } from './reviews';

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
  /** Only these repositories (`rancher/dashboard`, `rancher/*`). None is all of them. */
  repos?: string[];
  /** Only work by these people: the issue's or pull request's author. None is everybody. */
  authors?: string[];
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
  /** What it does: an agent conversation (the default), a script, or a review of the event's PR. */
  action?: 'agent' | 'script' | 'review';
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
  kind?: 'agent' | 'script' | 'review';
  /** A review's pull request. */
  pr?: { repo: string; number: number; title: string } | null;
  /** A review's workspace, once a dashboard has started it. */
  workspace?: string;
  trigger: string;
  /** The event that started it, when one did. */
  event?: { id: string; source: string; name: string; subject: string; title: string; url: string; workspace: string } | null;
  /** What a resource trigger or an API call said about why. */
  context?: Record<string, string> | null;
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

let ticking = false;
let lastTick = 0;

/** Which tab this is, for a claim: so dev-api can say who is starting a review. */
const TAB = `tab-${ Math.random().toString(36).slice(2, 8) }`;

/**
 * Start the reviews dev-api could not: it starts every review itself now (the Starting a review
 * section of dev-api/server.mjs), and hands one back only when a new workspace needs a Rancher
 * token and none of the person's works - minting one takes this session. The first dashboard to
 * claim it starts it, as My Work's Review button would. One at a time per tick.
 */
async function claimReviews(store: Store): Promise<void> {
  const waiting = await devApi('/automations/claims').catch(() => null);
  const run = (waiting?.runs || [])[0];

  if (!run?.pr) {
    return;
  }
  const claimed = await devApi(`/automations/runs/${ run.id }/claim`, { method: 'POST', body: JSON.stringify({ by: TAB }) }).catch(() => null);

  if (!claimed?.run) {
    return; // another tab got it
  }
  const report = (body: Record<string, string>) => devApi(`/automations/runs/${ run.id }/report`, { method: 'POST', body: JSON.stringify(body) }).catch(() => null);

  try {
    const started = await startPrReview(store, { number: run.pr.number, title: run.pr.title }, run.pr.repo, '', false);

    await report({
      state: 'running', workspace: started.workspace, conversation: started.conversation.id, note: started.created ? `made ${ started.workspace } and started the review` : `started the review in ${ started.workspace }`,
    });
  } catch (e: Json) {
    await report({ state: 'failed', note: e?.message || String(e) });
  }
}

/**
 * The browser's part of the clock, which is now only the reviews waiting for a dashboard to start
 * them. Everything else - events, schedules, resource changes, API calls, seeing a run finish - is
 * dev-api's. Called from the sidebar's poll; one GET when there is nothing to do.
 */
export async function tickAgents(store: Store): Promise<void> {
  if (ticking || Date.now() - lastTick < 20_000) {
    return;
  }
  ticking = true;
  lastTick = Date.now();
  try {
    await claimReviews(store).catch(() => {});
  } finally {
    ticking = false;
  }
}
