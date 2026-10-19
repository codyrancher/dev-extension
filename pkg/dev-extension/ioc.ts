// Where a component's data comes from, as something that can be replaced.
//
// agents.md item 3 asks for the implementation in two halves: an API, and components that use
// it by default but do not depend on it. The API half is dev-api, which already exists and now
// describes itself. This is the seam for the other half.
//
// Today every page imports its data functions directly - `import { allTools } from '../tools'`
// - which is the shortest thing that works and the one thing that makes a component impossible
// to put anywhere else. It cannot be rendered against a fixture, against a second Rancher, or
// inside a host that already has the data, because the import *is* the dependency.
//
// So the functions are gathered into one object, that object is the thing a component asks for,
// and the default is the REST one. A host that wants something else provides it; a component
// that is given nothing gets the API, which is what "use the restful api by default" means.
//
// `restSources()` is deliberately thin - it holds no logic of its own, only the existing
// clients. If it ever grows behaviour, that behaviour has stopped being available to whatever
// replaces it, which is the failure this pattern exists to avoid.
import type { InjectionKey } from 'vue';
import {
  allTools, workspaceTools, startTool, renewTool, stopTool, type Tool, type ToolKind
} from './tools';
import { createWorkspaceTool, removeWorkspaceTool } from './tools';
import { jiraQueue, type JiraQueue } from './jira';

/** Everything a page of this product reads or changes, in one replaceable object. */
export interface DevSources {
  /** Every tool running anywhere. */
  allTools(): Promise<Tool[]>;
  /** All kinds for one workspace, running or not. */
  workspaceTools(workspace: string): Promise<Tool[]>;
  startTool(workspace: string, kind: ToolKind, minutes?: number): Promise<Tool>;
  renewTool(workspace: string, kind: ToolKind, minutes?: number): Promise<Tool>;
  stopTool(workspace: string, kind: ToolKind): Promise<void>;
  /** Take a workspace, and give it back. */
  createWorkspace(name: string, app?: string, cluster?: string): Promise<{ name: string; namespace: string }>;
  removeWorkspace(name: string): Promise<void>;
  /** The SURE queue. */
  jiraQueue(): Promise<JiraQueue>;
}

/**
 * The default: every call goes to dev-api, exactly as it does today.
 *
 * A function per line and nothing else. The point of this object is that it can be swapped, and
 * an implementation that does any thinking of its own is one whose thinking is lost when it is.
 */
export function restSources(): DevSources {
  return {
    allTools,
    workspaceTools,
    startTool,
    renewTool,
    stopTool,
    createWorkspace: createWorkspaceTool,
    removeWorkspace: removeWorkspaceTool,
    jiraQueue,
  };
}

/**
 * The REST sources with some of them replaced.
 *
 * Partial on purpose: a fixture that only needs to answer `allTools` should not have to stub
 * the other seven, and a test that stubs everything is a test that stops noticing when a
 * component starts calling something new.
 */
export function withSources(overrides: Partial<DevSources>): DevSources {
  return { ...restSources(), ...overrides };
}

/**
 * What a component asks for. `inject(DEV_SOURCES, restSources())` - the default argument is the
 * whole design: a component with no provider is a component talking to the API.
 */
export const DEV_SOURCES: InjectionKey<DevSources> = Symbol('dev.sources');

/**
 * The custom properties a host may set to restyle these components.
 *
 * Styling is a separate question from where the data comes from, and this half is mostly
 * already true: the components are written in tokens rather than literal colours, so a host
 * that redefines the tokens restyles them without touching the components. This names the ones
 * that are this product's own rather than Rancher's, so there is a list to override rather than
 * a reading exercise.
 *
 * Deliberately short. A long list of knobs nobody turns is worse than a few that are honest.
 */
export const STYLE_TOKENS = [
  '--dev-space-1', '--dev-space-2', '--dev-space-3', '--dev-space-4', '--dev-space-6',
] as const;
