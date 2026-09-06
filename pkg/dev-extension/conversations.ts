// A workspace's conversations: registered in the agent pod, running in the workspace's own pod.
//
// The harness ran a project's conversations in the project's container, because that is where
// the checkout, the browser and the environment were. So does this: the pane is claude in the
// workspace's pod, in its checkout, with everything workspace-tools.ts put there. What the
// agents extension keeps is the registry - which conversations a workspace has, their titles,
// the ids (`p-<workspace>-<n>`) - and the terminal component every pane is drawn with; the
// terminal execs into the agent pod, which reaches the workspace's pod with kubectl, so one
// exec path and one cookie serve every pane in this dashboard. Nothing here holds a credential
// or opens a socket of its own.

import { workspaceNamespace, workspacePod, WORKSPACE_CONTAINER } from './api';
import { WORKSPACE_WORKDIR, WORKSPACE_HOME } from './config/constants';
import { queuePrompt as queueInWorkspace, endPane } from './workspace-tools';

/** Where the agents extension's API is. The agents extension made the agent pod, so this is its cluster. */
export const STUDIO_CLUSTER = 'local';

/** How to open a terminal on one conversation, and what it is: the workspace and the id. */
export interface Attachment {
  namespace: string;
  pod: string;
  container: string;
  command: string[];
  workspace: string;
  id: string;
}

export interface ProjectConversation {
  id: string;
  title: string;
  attach: Attachment;
}

/**
 * The argv the agent pod runs to land in a conversation's pane: kubectl into the workspace's
 * pod, then the workspace's own shell.sh with the session, the checkout, the home and the mode,
 * exactly as the workspace's shell row runs it. The Deployment rather than a pod by name, so a
 * pod that rolled since the page loaded is still the one reached.
 */
export function paneCommand(workspace: string, id: string, mode: 'claude' | 'shell' = 'claude'): string[] {
  const namespace = workspaceNamespace(workspace);

  return [
    ...KUBECTL,
    'exec', '-i', '-t', '-n', namespace, `deploy/${ namespace }`, '-c', WORKSPACE_CONTAINER, '--',
    '/bin/sh', '/seed/shell.sh', id, WORKSPACE_WORKDIR, WORKSPACE_HOME, mode,
  ];
}

/**
 * `kubectl` in the agent pod, wherever its tools were installed: the pod's seed puts it in the
 * pane user's `~/.local/bin`, which an exec's own PATH does not have, so a pane that ran a bare
 * `kubectl` stopped working the first time the pod restarted onto a fresh image.
 */
export const KUBECTL = ['/bin/sh', '-c', 'export PATH=/workspace/.home/.local/bin:/usr/local/bin:$PATH; exec kubectl "$@"', 'kubectl'];

function attachment(workspace: string, id: string, pod: string): Attachment {
  return {
    namespace: workspaceNamespace(workspace), pod, container: WORKSPACE_CONTAINER, command: paneCommand(workspace, id), workspace, id,
  };
}

export async function listConversations(workspace: string): Promise<ProjectConversation[]> {
  const api = await requireAgents();
  const sessions = await api.agent.projectSessions(workspace);
  const pod = sessions.length ? (await workspacePod(workspace).catch(() => null)) || '' : '';

  return sessions.map((session) => ({ id: session.id, title: session.title, attach: attachment(workspace, session.id, pod) }));
}

/**
 * Start a conversation, optionally with a name and the prompt it opens with.
 *
 * Registered with the agents extension, which is what hands out the id; the prompt is queued in
 * the workspace's pod, where the pane will run. A workspace whose pod is not up yet takes the
 * registration and rejects the prompt: callers that can wait (reviews.ts) queue it themselves
 * once the pod is there.
 */
export async function startConversation(workspace: string, title = '', prompt = ''): Promise<ProjectConversation> {
  const api = await requireAgents();
  const before = new Set((await api.agent.projectSessions(workspace).catch(() => [])).map((s) => s.id));
  let id: string;

  try {
    id = await api.agent.startInProject(workspace, title);
  } catch (e) {
    // The registry's exec answers through a websocket the apiserver proxy sometimes closes
    // before the final status frame, and the agents extension reports that as a failure even
    // when the mkdir and the rename behind it went through. So before giving up, look: if
    // exactly one conversation appeared, that is the one that was asked for.
    const after = (await api.agent.projectSessions(workspace).catch(() => [])).filter((s) => !before.has(s.id));

    if (after.length !== 1) {
      throw e;
    }
    id = after[0].id;
    if (title && after[0].title !== title) {
      await api.agent.rename(id, title).catch(() => {});
    }
  }

  const conversation = { id, title: title || id.slice(id.lastIndexOf('-') + 1), attach: attachment(workspace, id, (await workspacePod(workspace).catch(() => null)) || '') };

  if (prompt) {
    await queueInWorkspace(workspace, id, prompt);
  }

  return conversation;
}

export async function renameConversation(workspace: string, id: string, title: string): Promise<void> {
  await (await requireAgents()).agent.rename(id, title);
}

/** End it in both places: the registry, and the pane in the workspace pod with claude in it. */
export async function endConversation(workspace: string, id: string): Promise<void> {
  await endPane(workspace, id).catch(() => {});
  await (await requireAgents()).agent.end(id);
}

/** Queue a prompt for a conversation to open with, or say something into one that is running. */
export async function queuePrompt(attach: Attachment, prompt: string): Promise<void> {
  await queueInWorkspace(attach.workspace, attach.id, prompt);
}

// ── The agents extension's browser API ──────────────────────────────────────────────────────
//
// The agents extension puts its terminal, and the agent pod behind it, on `window.__agents`
// (Extension Studio 0.5.92 to 0.5.93 put the same on `window.__extensionStudio`). Every pane
// this extension shows is that component: the conversation list, the review agent docked over
// a pull request, a discussion under one comment. Borrowed rather than copied, so there is one
// terminal in this dashboard and one place it is fixed.

export const AGENTS_GLOBAL = '__agents';
export const STUDIO_GLOBAL = '__extensionStudio';
export const AGENTS_READY_EVENT = 'agents:ready';
export const STUDIO_READY_EVENT = 'extension-studio:ready';

/** What has to be installed for any of this to work, for the message when it is not. */
export const STUDIO_API_SINCE = 'the agents extension (or Extension Studio 0.5.92 to 0.5.93)';

export interface StudioBrowserApi {
  version: string;
  terminal: { component: unknown };
  agent: {
    namespace: string;
    container: string;
    pod(): Promise<string | null>;
    command(id: string, mode?: 'claude' | 'shell'): string[];
    projectSessions(project: string): Promise<{ id: string; title: string }[]>;
    startInProject(project: string, title?: string, prompt?: string): Promise<string>;
    queue(id: string, prompt: string): Promise<void>;
    rename(id: string, title: string): Promise<void>;
    end(id: string): Promise<void>;
    pane(id: string, lines?: number): Promise<{ text: string; running: boolean }>;
  };
}

/** The agents extension's browser API, if its bundle has loaded. */
export function studioApi(): StudioBrowserApi | null {
  const w = window as unknown as Record<string, unknown>;
  const api = (w[AGENTS_GLOBAL] || w[STUDIO_GLOBAL]) as StudioBrowserApi | undefined;

  return api?.terminal?.component ? api : null;
}

/** The API, or an error that says what to install. */
async function requireAgents(): Promise<StudioBrowserApi> {
  const api = await waitForStudio();

  if (!api) {
    throw new Error(`Nothing here can hold a conversation: install ${ STUDIO_API_SINCE }, which brings the agent pod and its terminal.`);
  }

  return api;
}

/**
 * The API, waiting for it if the agents extension's bundle is still loading.
 *
 * Extensions load in no particular order, so a page of this one can render before the agents
 * extension has installed its API. It fires an event when it does; failing that, a short poll,
 * because one that is installed but slow is the common case and one that is absent is rare.
 */
export function waitForStudio(timeoutMs = 15000): Promise<StudioBrowserApi | null> {
  const now = studioApi();

  if (now) {
    return Promise.resolve(now);
  }

  return new Promise((resolve) => {
    let timer: ReturnType<typeof setInterval> | null = null;
    let deadline: ReturnType<typeof setTimeout> | null = null;
    const done = (api: StudioBrowserApi | null) => {
      window.removeEventListener(AGENTS_READY_EVENT, onReady);
      window.removeEventListener(STUDIO_READY_EVENT, onReady);
      if (timer) {
        clearInterval(timer);
      }
      if (deadline) {
        clearTimeout(deadline);
      }
      resolve(api);
    };
    const onReady = () => done(studioApi());

    window.addEventListener(AGENTS_READY_EVENT, onReady);
    window.addEventListener(STUDIO_READY_EVENT, onReady);
    timer = setInterval(() => {
      const api = studioApi();

      if (api) {
        done(api);
      }
    }, 500);
    deadline = setTimeout(() => done(studioApi()), timeoutMs);
  });
}
