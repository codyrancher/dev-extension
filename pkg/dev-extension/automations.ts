// The Automations page's reads and writes against dev-api: the events log, mutes, runs.
//
// The paths are watchable (events.ts), so the page subscribes to them rather than polling: the
// events log, every automation's recent runs and blocked attempts, and one run's output while
// its log is open. See the Automations section of dev-api/server.mjs.
import { devApi } from './reviews';
import { evaluateEvent, conditionScope } from './dev-api/automation-rules.mjs';
import type { AgentDef, AgentRun } from './agent-defs';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

export const EVENTS_PATH = '/automations/events';
export const STATUS_PATH = '/automations/status';
export const runPath = (id: string) => `/automations/runs/${ id }`;

/** What an event did to one automation that listens to it. */
export interface EventMatch {
  automation: string;
  outcome: 'run' | 'blocked' | 'error' | 'disabled' | 'muted' | 'throttled';
  reason: string;
  condition?: string;
  runId?: string;
}

export interface AutoEvent {
  id: string;
  source: 'github' | 'workspace' | string;
  name: string;
  at: string;
  subject: string;
  title: string;
  url: string;
  actor: string;
  workspace: string;
  self: boolean;
  muted: boolean;
  matches: EventMatch[];
  /** Only on a full read. */
  payload?: Json;
}

export interface SourceStatus {
  ok?: boolean;
  error?: string;
  at?: string;
  next?: string;
  every?: number;
  items?: number;
  open?: number;
  login?: string;
  live?: boolean;
  since?: string;
}

export interface EventsAnswer {
  events: AutoEvent[];
  total: number;
  mutes: string[];
  names: Record<string, string[]>;
  sources: { github: SourceStatus; workspace: SourceStatus };
  recorder: string;
}

export interface Attempt {
  at: string;
  event: AutoEvent;
  outcome: EventMatch['outcome'];
  reason: string;
  condition: string;
}

export interface StatusAnswer {
  runs: Record<string, AgentRun[]>;
  attempts: Record<string, Attempt[]>;
}

export interface RunAnswer {
  run: AgentRun;
  output: string;
  size: number;
  truncated: boolean;
  prompt: string;
  script: string;
  event: string;
}

export function readEvent(id: string): Promise<AutoEvent> {
  return devApi(`/automations/events/${ id }`).then((a: Json) => a.event);
}

/** Recent events with their payloads, for trying constraints against before saving them, and whose login `me` is. */
export function recentEvents(limit = 300): Promise<{ events: AutoEvent[]; me: string }> {
  return devApi(`${ EVENTS_PATH }?full=1&limit=${ limit }`).then((a: Json) => ({ events: a.events || [], me: a.sources?.github?.login || '' }));
}

export function pollNow(): Promise<Json> {
  return devApi('/automations/events/poll', { method: 'POST', body: '{}' });
}

export function setMutes(workspaces: string[]): Promise<string[]> {
  return devApi('/automations/mutes', { method: 'PUT', body: JSON.stringify({ workspaces }) }).then((a: Json) => a.mutes || []);
}

export function readRun(id: string): Promise<RunAnswer> {
  return devApi(runPath(id));
}

export function stopRun(id: string): Promise<Json> {
  return devApi(`${ runPath(id) }/stop`, { method: 'POST', body: '{}' });
}

/**
 * An unsaved definition against recorded events: what each would have done with it.
 *
 * In the browser and not in dev-api on purpose. The constraints are the person's own JavaScript,
 * and dev-api only ever runs what is saved in a ConfigMap; a route that ran whatever it was sent
 * would run it for anything in the cluster that can reach the Service.
 */
export function tryDefinition(def: AgentDef, events: AutoEvent[], me = ''): { event: AutoEvent; match: EventMatch }[] {
  const out: { event: AutoEvent; match: EventMatch }[] = [];

  for (const event of events) {
    const scope = conditionScope(event, me);
    const names = Object.keys(scope);
    const values = Object.values(scope);
    const check = (line: string) => {
      // eslint-disable-next-line no-new-func
      return new Function(...names, `return (${ line }\n);`)(...values);
    };
    const match = evaluateEvent({ ...def, enabled: true }, event, { muted: false, check }) as EventMatch | null;

    if (match) {
      out.push({ event, match });
    }
  }

  return out;
}

/** "3m ago", "in 2m", for a time near now. */
export function near(iso: string | undefined, now = Date.now()): string {
  const at = Date.parse(iso || '');

  if (!at) {
    return '';
  }
  const s = Math.round((at - now) / 1000);
  const a = Math.abs(s);
  const span = a < 60 ? `${ a }s` : a < 3600 ? `${ Math.round(a / 60) }m` : a < 86400 ? `${ Math.round(a / 3600) }h` : `${ Math.round(a / 86400) }d`;

  return s >= 0 ? `in ${ span }` : `${ span } ago`;
}

/** A time the way a log line says it: today's as a clock, older ones with the day. */
export function stamp(iso: string | undefined): string {
  const d = new Date(iso || '');

  if (Number.isNaN(d.getTime())) {
    return '';
  }
  const today = new Date().toDateString() === d.toDateString();

  return d.toLocaleString([], today ? { hour: '2-digit', minute: '2-digit', second: '2-digit' } : {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

/** How long a run took or has been going. */
export function duration(run: Pick<AgentRun, 'startedAt' | 'endedAt'>, now = Date.now()): string {
  const start = Date.parse(run.startedAt || '');

  if (!start) {
    return '';
  }
  const s = Math.max(0, Math.round(((run.endedAt ? Date.parse(run.endedAt) : now) - start) / 1000));

  return s < 60 ? `${ s }s` : s < 3600 ? `${ Math.floor(s / 60) }m ${ s % 60 }s` : `${ (s / 3600).toFixed(1) }h`;
}

/** The words for what happened to an event at an automation. */
export const OUTCOME_WORDS: Record<string, string> = {
  run:       'ran',
  blocked:   'blocked',
  error:     'constraint error',
  disabled:  'disabled',
  muted:     'muted',
  throttled: 'throttled',
};
