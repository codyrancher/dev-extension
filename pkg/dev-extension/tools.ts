// The tools a leased workspace attaches, from the dashboard's side.
//
// Everything here is one call to dev-api, which is where tools are rendered, leased and swept
// (see dev-api/server.mjs). It is deliberately the same API an agent uses from inside a
// workspace with `tools start dev-server`, so the button on the page and the command in the
// conversation do the same thing to the same objects - there is no second path that can drift.

import { devApi } from './reviews';
import { DEFAULT_LEASE_MINUTES, TOOL_KINDS, ToolKind } from './config/constants';

export type { ToolKind };

export interface Tool {
  kind: ToolKind;
  workspace: string;
  /** Whether it exists at all: a namespace, or a browser context. */
  running: boolean;
  /** Whether it is answering yet. Pod tools only. */
  ready?: boolean;
  /** When the lease runs out (ISO), and what it was granted for. */
  expires?: string;
  minutes?: number;
  /** Where it is, for a pod tool: its namespace and how it is reached. */
  namespace?: string;
  port?: number;
  scheme?: string;
  /** In-cluster address - what an agent or the shared browser opens. */
  url?: string;
  /** This Rancher's proxy path - what a person opens. */
  proxy?: string;
  /** Being removed, or why it is not answering yet. */
  removing?: boolean;
  detail?: string;
  /** The shared browser's context, for the browser tool. */
  browserContextId?: string;
  error?: string;
}

/** What each tool is, in the words the page and the agent's rule both use. */
export const TOOLS: Record<ToolKind, { label: string; icon: string; what: string }> = {
  'dev-server': {
    label: 'Dev server',
    icon:  'icon-play',
    what:  'The dashboard compiled and served from this checkout, so a change can be seen. Two gigabytes while it runs.',
  },
  storybook: {
    label: 'Storybook',
    icon:  'icon-book',
    what:  'The component gallery built from this checkout, for a change to a component in isolation.',
  },
  rancher: {
    label: 'Rancher',
    icon:  'icon-cluster',
    what:  'A Rancher of its own to point the work at, with its own embedded k3s. Up in a couple of minutes.',
  },
  browser: {
    label: 'Browser',
    icon:  'icon-globe',
    what:  'A window and a session on the shared browser - its own cookies and storage, so no other agent is in the way.',
  },
};

/** The order they are offered in: the one almost every piece of work wants, first. */
export const TOOL_ORDER: ToolKind[] = ['dev-server', 'browser', 'storybook', 'rancher'];

export async function workspaceTools(workspace: string): Promise<Tool[]> {
  const answer = await devApi(`/tools/${ encodeURIComponent(workspace) }`).catch(() => null);

  return answer?.tools || TOOL_KINDS.map((kind) => ({ kind, workspace, running: false } as Tool));
}

/** Every tool running anywhere, for the overview. */
export async function allTools(): Promise<Tool[]> {
  return (await devApi('/tools').catch(() => null))?.tools || [];
}

export async function startTool(workspace: string, kind: ToolKind, minutes = DEFAULT_LEASE_MINUTES, values: Record<string, unknown> = {}): Promise<Tool> {
  return devApi(`/tools/${ encodeURIComponent(workspace) }/${ kind }`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ minutes, values }),
  });
}

export async function renewTool(workspace: string, kind: ToolKind, minutes = DEFAULT_LEASE_MINUTES): Promise<Tool> {
  return devApi(`/tools/${ encodeURIComponent(workspace) }/${ kind }/renew`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ minutes }),
  });
}

export async function stopTool(workspace: string, kind: ToolKind): Promise<void> {
  await devApi(`/tools/${ encodeURIComponent(workspace) }/${ kind }`, { method: 'DELETE' });
}

/**
 * Release every tool a workspace holds.
 *
 * dev-api's sweep does this anyway once the Installation is gone, within the minute. This is so
 * that a delete pressed on the page takes the dev server down *now* rather than leaving it
 * compiling through the confirmation and the teardown - and so that a delete that stalls on
 * something else has still freed the expensive part.
 */
export async function releaseTools(workspace: string): Promise<void> {
  const tools = await workspaceTools(workspace).catch(() => [] as Tool[]);

  await Promise.all(tools.filter((tool) => tool.running).map((tool) => stopTool(workspace, tool.kind).catch(() => {})));
}

/** Where a person opens it: this Rancher, then the proxy path dev-api worked out. */
export function toolHref(tool: Tool): string {
  return tool.proxy ? `${ window.location.origin }${ tool.proxy }` : '';
}

/** How much of the lease is left, in the fewest words that are still true. */
export function leaseLeft(tool: Tool): string {
  const left = Date.parse(tool.expires || '') - Date.now();

  if (!Number.isFinite(left)) {
    return '';
  }
  if (left <= 0) {
    return 'lease over';
  }
  const minutes = Math.round(left / 60_000);

  return minutes < 60 ? `${ minutes }m left` : `${ Math.round(minutes / 60) }h left`;
}

/** What a tool's row says it is doing, in a few words. */
export function toolState(tool: Tool): string {
  if (tool.error) {
    return tool.error;
  }
  if (!tool.running) {
    return 'not running';
  }
  if (tool.removing) {
    return 'being released';
  }
  if (tool.kind === 'browser') {
    return tool.detail || 'a window of its own';
  }

  return tool.ready ? (leaseLeft(tool) || 'running') : (tool.detail || 'starting');
}
