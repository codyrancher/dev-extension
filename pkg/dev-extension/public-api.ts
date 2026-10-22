// What this extension offers the others in the same dashboard: its terminal, and the agent pod
// behind it.
//
// Every pane in this Rancher that opens onto a pod should be *this* pane: the same exec
// subresource, the same cookie the browser already has, the same reconnect, image paste and
// clickable paths. Extension Studio's editor opens one onto each dev-server pod; the Dev
// extension opens them onto the agent pod's conversations - a workspace's list, a review agent,
// a discussion under one comment. None of them import this bundle, and none of them copy it:
// the component is put on `window`, which is the one thing every bundle in the page shares,
// with a version beside it and an event when it lands.
//
// The functions beside the component are the agent pod's conversations - list, start (with a
// name and an opening prompt), rename, end, read what a pane shows - which is the whole of what
// a caller needs to place a conversation somewhere and know what it is doing.
import PodTerminal from './components/PodTerminal.vue';
import {
  AGENT_CONTAINER, agentPod, agentSessions, projectSessions, startAgentSession, startProjectSession,
  renameAgentSession, endAgentSession, queueSessionPrompt, sessionCommand, sessionPane,
} from './agent';
import type { ConversationOrigin } from './agent';
import { AGENT_NS } from './pod';

/** Where the API is: `window.__agents`. */
export const AGENTS_GLOBAL = '__agents';

/**
 * The name Extension Studio put it under while it owned this code (0.5.92 and 0.5.93). Kept as
 * an alias for one release, so a page that loads this bundle beside an older Dev extension is a
 * page where the terminals still work.
 */
export const LEGACY_GLOBAL = '__extensionStudio';

/** Fired on `window` when the API is installed, for a bundle that loaded before this one did. */
export const AGENTS_READY_EVENT = 'agents:ready';
export const LEGACY_READY_EVENT = 'extension-studio:ready';

export interface AgentsBrowserApi {
  /** This extension's package version, for a caller that needs a feature a given version added. */
  version: string;
  terminal: {
    /**
     * The terminal, as a Vue component. Its props: `session` and `mode` for one of the agent
     * pod's conversations, or `command` (argv), `findPod` (async, answers a pod name or null),
     * `namespace`, `container`, `imageDir`, `home`, `waitingText` and `label` to open it onto
     * any other pod. It emits `state`: waiting, connecting, open, closed.
     */
    component: unknown;
  };
  agent: {
    /** The namespace and container every one of the agent pod's panes opens in. */
    namespace: string;
    container: string;
    /** The agent pod's current name, or null while there is none. */
    pod(): Promise<string | null>;
    /** The argv a pane runs for one conversation: what the component's `command` prop takes. */
    command(id: string, mode?: 'claude' | 'agy' | 'shell'): string[];
    /**
     * Every `agent-<n>` conversation, whoever started it. The panel lists only its own.
     *
     * `cli` is which CLI holds it - 'claude', 'agy', or '' for one that has never run - read in
     * the pod from the record the pane wrote, because nothing in a browser can know it about a
     * conversation it did not just create. Optional on the way out so a caller compiled against
     * the older shape still type-checks.
     */
    sessions(): Promise<{ id: string; title: string; cli?: string }[]>;
    /** One project's conversations - `p-<project>-<n>` and `p-<project>_<where>-<n>`, which the
     * drawer never lists. */
    projectSessions(project: string): Promise<{ id: string; title: string; cli?: string }[]>;
    /**
     * Start a free-standing conversation.
     *
     * It is marked as started through this API, which is what keeps it out of the agent panel's
     * tabs: the panel is for the conversations somebody opened on it, and a conversation some
     * machinery started turning up there as a tab nobody opened - closable, and closing it
     * ended the work - is what this is for. Reach it by its id, with the terminal component or
     * `pane`, which is how whatever started it knows about it in the first place.
     *
     * `from` is where it is being started: `{ path, line }`, a label, or an already slugged
     * location. It goes into the id itself - `agent_pr-19630-review-4` - so the conversation
     * can be found again, resumed, or ended with the thing it was about. Leave it out when
     * there is nowhere in particular; the id then keeps the short form.
     */
    start(from?: ConversationOrigin): Promise<string>;
    startInProject(project: string, title?: string, prompt?: string, from?: ConversationOrigin): Promise<string>;
    /** Queue what a conversation opens with; read the first time a pane attaches. */
    queue(id: string, prompt: string): Promise<void>;
    rename(id: string, title: string): Promise<void>;
    end(id: string): Promise<void>;
    /** What a conversation's pane is showing, for reading a verdict off it. */
    pane(id: string, lines?: number): Promise<{ text: string; running: boolean }>;
  };
}

export function installBrowserApi(version: string): AgentsBrowserApi {
  const api: AgentsBrowserApi = {
    version,
    terminal: { component: PodTerminal },
    agent:    {
      namespace:      AGENT_NS,
      container:      AGENT_CONTAINER,
      pod:            agentPod,
      command:        sessionCommand,
      sessions:       agentSessions,
      projectSessions,
      // 'api' and not the default: see `start` above. Everything that is not the panel itself
      // comes through here, so this is the one place it has to be said.
      start:          (from?: ConversationOrigin) => startAgentSession('api', from),
      startInProject: startProjectSession,
      queue:          queueSessionPrompt,
      rename:         renameAgentSession,
      end:            endAgentSession,
      pane:           sessionPane,
    },
  };
  const w = window as unknown as Record<string, unknown>;

  w[AGENTS_GLOBAL] = api;
  w[LEGACY_GLOBAL] = api;
  window.dispatchEvent(new CustomEvent(AGENTS_READY_EVENT, { detail: api }));
  window.dispatchEvent(new CustomEvent(LEGACY_READY_EVENT, { detail: api }));

  return api;
}
