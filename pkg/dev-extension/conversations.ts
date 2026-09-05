// A workspace's conversations, which live in Extension Studio's agent pod.
//
// The harness ran a workspace's conversations in the workspace's own container. Here they run
// where every other conversation in this Rancher runs - the one agent pod Extension Studio
// keeps, which can see every extension and every cluster - and are namespaced by the
// workspace's name so that the Studio's terminal drawer, which lists the agent pod's own
// conversations, never shows them. The Studio offers exactly that over its in-pod API,
// /v1/projects/{project}/conversations, and the "attach" block each conversation comes with
// is what a terminal needs to open the apiserver's exec subresource on the right pod.
//
// Same-origin fetch against the Studio API's service proxy, with the session the dashboard
// already has. The service forwards the R_SESS cookie and the CSRF header to Rancher and acts
// as the person in the browser, so nothing here holds a credential.

import { devFetch, podExecOnce, clusterBase } from './api';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

/** Where the Studio's API is. The Studio is what made the agent pod, so this is its cluster. */
export const STUDIO_CLUSTER = 'local';
const STUDIO_NS = 'extension-studio';
const STUDIO_API = `${ clusterBase(STUDIO_CLUSTER) }/api/v1/namespaces/${ STUDIO_NS }/services/http:extension-studio-api:8006/proxy`;

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

function studioError(e: Json, what: string): Error {
  const message = e?.message || String(e);

  if (/404|no such path|not found/i.test(message)) {
    return new Error(`Extension Studio is not installed, or is older than 0.5.91, so there is nowhere to ${ what }. Install or upgrade the extension-studio extension.`);
  }

  return new Error(`Could not ${ what }: ${ message }`);
}

export async function listConversations(workspace: string): Promise<ProjectConversation[]> {
  try {
    const body = await devFetch(`${ STUDIO_API }/v1/projects/${ encodeURIComponent(workspace) }/conversations`);

    return body?.conversations || [];
  } catch (e) {
    throw studioError(e, `read ${ workspace }'s conversations`);
  }
}

export async function startConversation(workspace: string, title = ''): Promise<ProjectConversation> {
  try {
    const body = await devFetch(`${ STUDIO_API }/v1/projects/${ encodeURIComponent(workspace) }/conversations`, {
      method: 'POST',
      body:   JSON.stringify(title ? { title } : {}),
    });

    return { id: body.id, title: body.title, attach: body.attach };
  } catch (e) {
    throw studioError(e, `start a conversation in ${ workspace }`);
  }
}

export async function renameConversation(workspace: string, id: string, title: string): Promise<void> {
  try {
    await devFetch(`${ STUDIO_API }/v1/projects/${ encodeURIComponent(workspace) }/conversations/${ encodeURIComponent(id) }`, {
      method: 'PUT',
      body:   JSON.stringify({ title }),
    });
  } catch (e) {
    throw studioError(e, `rename ${ id }`);
  }
}

export async function endConversation(workspace: string, id: string): Promise<void> {
  try {
    await devFetch(`${ STUDIO_API }/v1/projects/${ encodeURIComponent(workspace) }/conversations/${ encodeURIComponent(id) }`, { method: 'DELETE' });
  } catch (e) {
    throw studioError(e, `end ${ id }`);
  }
}

/**
 * Queue a prompt for a conversation to open with.
 *
 * The pane's runner reads `$MC_QUEUE` - `/workspace/.queue/<conversation id>` in the agent pod -
 * on its first start and hands the contents to claude as its opening message. Written the way
 * the harness wrote it: base64 through a shell, so a prompt with quotes, newlines and dollar
 * signs in it arrives whole. The conversation need not be running yet; that is the point of a
 * queue.
 */
export async function queuePrompt(attach: Attachment, prompt: string): Promise<void> {
  const id = attach.command[2];
  const bytes = new TextEncoder().encode(prompt);
  let binary = '';

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  const encoded = btoa(binary);
  const script = `mkdir -p /workspace/.queue && echo ${ encoded } | base64 -d > /workspace/.queue/${ id } && chown 1000:1000 /workspace/.queue /workspace/.queue/${ id } 2>/dev/null; echo queued`;
  const out = await podExecOnce(attach.namespace, attach.pod, attach.container, ['/bin/sh', '-c', script], clusterBase(STUDIO_CLUSTER));

  if (!out.includes('queued')) {
    throw new Error('The prompt could not be written into the agent pod.');
  }
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
