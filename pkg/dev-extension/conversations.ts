// A workspace's conversations, which live in the agent pod the agents extension keeps.
//
// The harness ran a workspace's conversations in the workspace's own container. Here they run
// where every other conversation in this Rancher runs - the one agent pod, which can see every
// extension and every cluster - namespaced by the workspace's name (`p-<workspace>-<n>`) so the
// agent drawer, which lists only its own, never shows them. The agents extension offers exactly
// that on `window.__agents`: list, start with a prompt, rename, end, read a pane, and the
// terminal component that draws one. Nothing here holds a credential or opens a socket of its
// own.


import { clusterBase } from './api';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

/** Where the Studio's API is. The Studio is what made the agent pod, so this is its cluster. */
export const STUDIO_CLUSTER = 'local';

/** How to open a terminal on one conversation: the apiserver exec subresource's four facts. */
export interface Attachment {
  namespace: string;
  pod: string;
  container: string;
  command: string[];
}

export interface ProjectConversation {
  id: string;
  title: string;
  attach: Attachment;
}


/**
 * A conversation's attachment: the four facts a terminal or an exec needs to reach it.
 *
 * Built from the agents extension's own account of its pod rather than reported by an API: the
 * pod's name is asked for at the moment it is wanted, so a pod that rolled since the list was
 * read is still the pod that is reached.
 */
async function attachmentFor(id: string): Promise<Attachment> {
  const api = await requireAgents();
  const pod = await api.agent.pod();

  if (!pod) {
    throw new Error('The agent pod is not running yet, so there is nowhere to hold a conversation.');
  }

  return {
    namespace: api.agent.namespace, pod, container: api.agent.container, command: api.agent.command(id),
  };
}

export async function listConversations(workspace: string): Promise<ProjectConversation[]> {
  const api = await requireAgents();
  const sessions = await api.agent.projectSessions(workspace);
  const pod = await api.agent.pod();

  return sessions.map((session) => ({
    id:     session.id,
    title:  session.title,
    attach: {
      namespace: api.agent.namespace, pod: pod || '', container: api.agent.container, command: api.agent.command(session.id),
    },
  }));
}

/** Start a conversation, optionally with a name and the prompt it opens with. */
export async function startConversation(workspace: string, title = '', prompt = ''): Promise<ProjectConversation> {
  const api = await requireAgents();
  const id = await api.agent.startInProject(workspace, title, prompt);

  return { id, title: title || id.slice(id.lastIndexOf('-') + 1), attach: await attachmentFor(id) };
}

export async function renameConversation(workspace: string, id: string, title: string): Promise<void> {
  await (await requireAgents()).agent.rename(id, title);
}

export async function endConversation(workspace: string, id: string): Promise<void> {
  await (await requireAgents()).agent.end(id);
}

/**
 * Queue a prompt for a conversation to open with, or say something into one that is running.
 *
 * The agents extension writes it where the pane's runner reads it: `/workspace/.queue/<id>`,
 * picked up on the pane's first start. The conversation need not be running yet; that is the
 * point of a queue.
 */
export async function queuePrompt(attach: Attachment, prompt: string): Promise<void> {
  await (await requireAgents()).agent.queue(attach.command[2], prompt);
}

// ── The Studio's browser API ──────────────────────────────────────────────────────────────
//
// Extension Studio puts its terminal, and the agent pod behind it, on `window.__extensionStudio`
// (its public-api.ts). Every pane this extension shows onto the agent pod is that component:
// the conversation list, the review agent docked over a pull request, a discussion under one
// comment. Borrowed rather than copied, so there is one terminal in this dashboard and one
// place it is fixed.

/** Where the agents extension's browser API is, and the name Extension Studio used before it. */
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

/** The Studio's browser API, if its bundle has loaded. */
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
 * The Studio's browser API, waiting for it if the Studio's bundle is still loading.
 *
 * Extensions load in no particular order, so a page of this one can render before the Studio
 * has installed its API. It fires an event when it does; failing that, a short poll, because a
 * Studio that is installed but slow is the common case and one that is absent is the rare one.
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

/** The DevTerminal props for one conversation's pane. */
export function paneFor(conversation: ProjectConversation): { namespace: string; labels: Record<string, string>; container: string; command: string[]; cluster: string } {
  return {
    namespace: conversation.attach.namespace,
    // The agent pod by its label rather than by the name the list reported: a pod that rolled
    // between the list and the click has a new name and the same label.
    labels:    { app: 'extension-studio-agent' },
    container: conversation.attach.container,
    command:   conversation.attach.command,
    cluster:   STUDIO_CLUSTER,
  };
}
