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
  /**
   * Where it is driven, when that is somewhere other than where it is read: Firefox's
   * WebDriver BiDi socket. Absent for every other tool, which is driven where it is read.
   */
  bidi?: string;
  /** In-cluster address - what an agent or the shared browser opens. */
  url?: string;
  /** This Rancher's proxy path - what a person opens. */
  proxy?: string;
  /** Being removed, or why it is not answering yet. */
  removing?: boolean;
  detail?: string;
  /** The browser tool: the one Chromium every workspace shares, rather than a pod of its own. */
  shared?: boolean;
  error?: string;
}

/**
 * What each tool is, in the words the page and the agent's rule both use - and whether two
 * pieces of work can hold one at the same time.
 *
 * `multitenant` is the fact a lease has to act on, and the reason it is here rather than only on
 * the Apps: three of these four are an App whose instance is per workspace
 * (`dev-<workspace>-<kind>`), and the fourth is not an App at all. The browser is one Chromium
 * that every workspace drives, so two agents using it at once are in each other's tabs. That is
 * the case the flag exists for; without it, "all tools are per workspace" is true of the ones
 * that happen to be Apps and false of the product.
 */
export const TOOLS: Record<ToolKind, { label: string; icon: string; what: string; multitenant: boolean; sharing?: string }> = {
  'dev-server': {
    label:       'Dev server',
    icon:        'icon-play',
    what:        'The dashboard compiled and served from this checkout, so a change can be seen. Two gigabytes while it runs.',
    multitenant: true,
  },
  storybook: {
    label:       'Storybook',
    icon:        'icon-document',
    what:        'The component gallery built from this checkout, for a change to a component in isolation.',
    multitenant: true,
  },
  rancher: {
    label:       'Rancher',
    icon:        'icon-cluster',
    what:        'A Rancher of its own to point the work at, with its own embedded k3s. Up in a couple of minutes.',
    multitenant: true,
  },
  firefox: {
    label:       'Firefox',
    icon:        'icon-compass',
    what:        'A Firefox of this workspace\'s own, with a desktop to watch and WebDriver BiDi to drive. For the bug that only happens outside Chromium.',
    multitenant: true,
    sharing:     'Yours while the lease lasts, and only yours: Firefox accepts one WebDriver BiDi session at a time, so there is no taking a context of your own the way the shared Chromium allows. End your session when you are done - a client that disconnects without ending it holds the browser until the pod restarts.',
  },
  browser: {
    label:       'Browser',
    icon:        'icon-globe',
    what:        'The shared Chromium every workspace drives, with the GitHub and Rancher logins already in it. Always there, nothing to attach.',
    multitenant: false,
    sharing:     'One Chromium for every workspace. Two agents driving it at once are in each other\'s tabs, so take a context of your own (see the shared-CDP context in the agent rules) rather than the default one, and do not close tabs you did not open.',
  },
};

/** Tools two pieces of work cannot simply both have. Nothing else needs to know the reason. */
export const SHARED_TOOLS: ToolKind[] = (Object.keys(TOOLS) as ToolKind[]).filter((kind) => !TOOLS[kind].multitenant);

/** The order they are offered in: the one almost every piece of work wants, first. */
export const TOOL_ORDER: ToolKind[] = ['dev-server', 'browser', 'firefox', 'storybook', 'rancher'];

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
  if (tool.shared) {
    return tool.detail || 'shared, always available';
  }

  return tool.ready ? (leaseLeft(tool) || 'running') : (tool.detail || 'starting');
}

/*
 * The workspace itself, as a thing that can be taken and given back.
 *
 * Items 3 and 4 of the backlog, and the reading taken: a workspace is not a fifth `ToolKind` -
 * it is what tools attach *to*, and making it one would mean `tools start workspace` inside a
 * workspace, which is a sentence with no meaning. What they ask for is that a workspace be as
 * disposable as a tool and reachable the same way, so it is described and driven here beside
 * them rather than folded into them.
 *
 * `POST /workspaces` existed already; `DELETE /workspaces/<name>` is new, and without it a
 * workspace an agent made for one job stayed until a person deleted it from a page. Both halves
 * are in the API's own OpenAPI now, for the reason that spec exists: an agent given a URL and a
 * sentence invents the rest.
 *
 * Existing workspaces are untouched by any of this - item 3.1. Nothing above changes how one is
 * made from the page, what it contains, or when it is swept.
 */
export interface WorkspaceAsTool {
  label: string;
  what: string;
  /** Every workspace is its own; two pieces of work never share one. */
  multitenant: true;
  openapi: string;
}

export const WORKSPACE_TOOL: WorkspaceAsTool = {
  label: 'Workspace',
  what:  'A unit of work: a checkout with its dependencies and its command-line tools, with nothing running until a tool is attached. An agent can take one and give it back.',
  multitenant: true,
  openapi: [
    'openapi: 3.1.0',
    'info:',
    '  title: Workspaces',
    '  version: "1"',
    '  description: Take a workspace, and give it back. Served by dev-api.',
    'paths:',
    '  /workspaces:',
    '    get:',
    '      summary: Every workspace, with its namespace, App and cluster.',
    '    post:',
    '      summary: Make one. Defaults to the leased App; the answer says the name it ended up with.',
    '  /workspaces/{name}:',
    '    delete:',
    '      summary: Remove one. Releases its tools; the sweep keeps its artifacts and then takes the tree.',
  ].join('\n'),
};

/** Make a workspace. The leased App unless something says otherwise. */
export async function createWorkspaceTool(name: string, app?: string, cluster = 'local'): Promise<{ name: string; namespace: string }> {
  return devApi('/workspaces', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, app, cluster }),
  });
}

/** Give it back. Releases the tools; the artifacts are kept by the sweep that takes the tree. */
export async function removeWorkspaceTool(name: string): Promise<void> {
  await devApi(`/workspaces/${ encodeURIComponent(name) }`, { method: 'DELETE' });
}
