// A workspace's conversations: all of them in the agent pod, each one working in its workspace.
//
// The harness ran a project's conversations inside the project's container, and so did this
// until it had several: every pod then held its own claude, its own login and its own copy of
// the skills, and the login is the one of those that expires. One went stale on its own
// schedule and the conversations in that workspace died at their next turn, while the pod next
// to it was fine.
//
// So there is one pod now. claude runs in the agent pod - one login, one place its transcripts
// live - with the workspace's checkout as its working directory, reached through the mount that
// pod has of every workspace's tree. What it *runs* still happens in the workspace's own pod,
// where the dev server, the browser sidecar and the toolchain are: each pane carries a
// CLAUDE_CODE_SHELL_PREFIX, the wrapper the seed writes at <workspace>/bin/dev-shell, and every
// command claude runs goes through it into that pod. The tree is at `/workspaces/<name>` on
// both sides, so a path means the same thing wherever it is read.
//
// What the agents extension keeps is the registry - which conversations a workspace has, their
// titles, the ids (`p-<workspace>-<n>`) - the queue, and the terminal component every pane is
// drawn with. Nothing here holds a credential or opens a socket of its own.

import {
  workspaceNamespace, workspacePod, WORKSPACE_CONTAINER, podExecOnce, clusterBase
} from './api';

type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any
import {
  workspaceWorkdir, workspaceShellWrapper, AGENT_HOME, AGENT_WORKSPACE
} from './config/constants';

/** Where the agents extension's API is. The agents extension made the agent pod, so this is its cluster. */
export const STUDIO_CLUSTER = 'local';

/**
 * The base every exec into the agent pod must use. `podExecOnce` defaults to the module-global BASE,
 * which follows the last-opened workspace's cluster - so on a downstream workspace (BASE = that
 * cluster) an agent-pod exec would go to a cluster the pod is not in, and every conversation call
 * (list, states, start a pane, reconnect) would 404 there. The agent pod is always on STUDIO_CLUSTER,
 * so pin these to it and never to BASE. This is the same BASE-leak that bit the secret store; see api.ts.
 */
const AGENT_BASE = clusterBase(STUDIO_CLUSTER);

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
 * The argv a pane runs, in the agent pod: that pod's own shell.sh, pointed at this workspace.
 *
 * The workspace's checkout is the working directory, so claude reads that workspace's CLAUDE.md
 * and its skills and keeps a conversation history of its own. The home is the agent pod's, which
 * is the point: one login for every conversation in this dashboard. The last argument is the
 * tunnel - the wrapper claude runs every command through, which puts it in the workspace's pod.
 */
export function paneCommand(workspace: string, id: string, mode: 'claude' | 'shell' = 'claude'): string[] {
  return [
    '/bin/sh', '/seed/shell.sh', id, workspaceWorkdir(workspace), AGENT_HOME, mode, workspaceShellWrapper(workspace),
  ];
}

/**
 * `kubectl` in the agent pod, wherever its tools were installed: the pod's seed puts it in the
 * pane user's `~/.local/bin`, which an exec's own PATH does not have, so a pane that ran a bare
 * `kubectl` stopped working the first time the pod restarted onto a fresh image.
 */
export const KUBECTL = ['/bin/sh', '-c', 'export PATH=/workspace/.home/.local/bin:/usr/local/bin:$PATH; exec kubectl "$@"', 'kubectl'];

function attachment(workspace: string, id: string, pod: string): Attachment {
  // The namespace and pod are the workspace's, and they are what the pane is *about* rather
  // than where it runs: the terminal always opens on the agent pod (StudioTerminal.vue) and
  // runs the argv below. Pages read these to say which pod a conversation's commands land in.
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
 * Which of a workspace's conversations have run at least once, whatever the workspace's own pod
 * is doing now.
 *
 * A conversation lives in the agent pod: its pane, its transcript and the id file the pane's
 * loop records after claude's first run (claude-session.sh) are all there, beside the agent's
 * home. So a workspace whose pod is restarting - an OOM kill, a re-render, a node under load -
 * has not lost its conversations, and the ones that already started can be shown, and go on,
 * while it is away; only a conversation that has never run waits for the pod, because the
 * prompt it opens with wants the checkout.
 *
 * Two marks of having run, either will do: the state file the pane's hooks write the moment
 * claude starts (chat-hook.mjs, SessionStart), and the id file the pane's loop writes once it
 * has seen claude's transcript - which, for a conversation still on its first run, can be
 * later than that. The state file is the one a running conversation has.
 */
export async function startedConversations(workspace: string): Promise<Set<string>> {
  const api = await requireAgents();
  const pod = await api.agent.pod().catch(() => null);

  if (!pod) {
    return new Set();
  }
  const listing = await podExecOnce(api.agent.namespace, pod, api.agent.container, ['/bin/sh', '-c', `ls ${ AGENT_WORKSPACE }/sessions 2>/dev/null`], AGENT_BASE).catch(() => '');
  const prefix = `p-${ workspace }-`;

  return new Set(listing.split('\n')
    .map((line) => line.replace(/\r$/, ''))
    .filter((file) => file.startsWith(prefix))
    .map((file) => file.match(/^(.+)\.(id|state\.json)$/)?.[1] || '')
    .filter(Boolean));
}

export interface ConversationState {
  id: string;
  workspace: string;
  /** Whether the pane is there - a tmux session in the agent pod. */
  alive: boolean;
  /** The last hook event the pane recorded (chat-hook.mjs), and when. */
  event: string;
  notification: string;
  at: string;
  /**
   * Seconds since anything was written to the conversation's transcript or to one of its
   * subagents', or -1 when there is no transcript to look at. The hook only fires at a turn's
   * edges; this is what says whether the turn is still going.
   */
  wroteAgo: number;
}

/**
 * Every workspace conversation's state, in one exec: the last hook event each pane wrote
 * (`<sessions>/<id>.state.json`) and whether its tmux session exists. The state file is one
 * short JSON line, so the whole listing is small however many conversations there are.
 */
export async function conversationStates(): Promise<ConversationState[]> {
  const api = await requireAgents();
  const pod = await api.agent.pod().catch(() => null);

  if (!pod) {
    return [];
  }
  // The hook file says what claude last told us; the transcript says whether anything is
  // still happening. Both are needed: a hook only fires at a turn's edges, so a turn that
  // spends twenty minutes inside subagents looks finished to it - and the subagents write
  // their own transcripts beside the session's, which is what gives them away.
  const script = [
    'export PATH=/workspace/.home/.local/bin:/usr/local/bin:/usr/bin:/bin:$PATH',
    `cd ${ AGENT_WORKSPACE }/sessions 2>/dev/null || exit 0`,
    'now=$(date +%s)',
    'for f in p-*.state.json; do',
    '  [ -f "$f" ] || continue',
    '  id=${f%.state.json}; a=no',
    '  if [ "$(id -u)" = 0 ]; then setpriv --reuid=1000 --regid=1000 --init-groups env HOME=/workspace/.home tmux has-session -t "mc-$id" 2>/dev/null && a=yes; else tmux has-session -t "mc-$id" 2>/dev/null && a=yes; fi',
    '  t=$(sed -n \'s/.*"transcript":"\\([^"]*\\)".*/\\1/p\' "$f" | head -1); m=0',
    '  if [ -n "$t" ] && [ -f "$t" ]; then',
    '    m=$(stat -c %Y "$t" 2>/dev/null || echo 0)',
    '    for s in "${t%.jsonl}"/subagents/*.jsonl; do',
    '      [ -f "$s" ] || continue',
    '      sm=$(stat -c %Y "$s" 2>/dev/null || echo 0); [ "$sm" -gt "$m" ] && m=$sm',
    '    done',
    '  fi',
    '  if [ "$m" -gt 0 ]; then wrote=$((now - m)); else wrote=-1; fi',
    '  printf "%s\t%s\t%s\t%s\n" "$id" "$a" "$wrote" "$(head -c 800 "$f" | tr -d "\n\t")"',
    'done',
  ].join('\n');
  const listing = await podExecOnce(api.agent.namespace, pod, api.agent.container, ['/bin/sh', '-c', script], AGENT_BASE).catch(() => '');
  const out: ConversationState[] = [];

  for (const line of listing.split('\n')) {
    const [id, alive, wrote, json] = line.replace(/\r$/, '').split('\t');

    if (!id || !/^p-.+-\d+$/.test(id)) {
      continue;
    }
    let event: Json = {};

    try {
      event = JSON.parse(json || '{}');
    } catch { /* a state file caught mid-write; the next poll reads it whole */ }
    out.push({
      id, workspace: id.replace(/^p-/, '').replace(/-\d+$/, ''), alive: alive === 'yes', event: String(event.event || ''), notification: String(event.notification || ''), at: String(event.at || ''), wroteAgo: Number(wrote ?? -1),
    });
  }

  return out;
}

export interface AgentReport {
  at: string;
  text: string;
  /** The conversation it came from, so the page can open it. */
  conversation: string;
}

/**
 * The last thing the agent said in a workspace, out of the newest transcript of its
 * conversations: the report a skill ends with, or wherever it has got to. Read in the agent
 * pod with node, which is there, rather than pulling a transcript that can be many megabytes
 * through an exec. Meta lines and subagents' side chains are skipped.
 */
export async function latestAgentReport(workspace: string): Promise<AgentReport | null> {
  const api = await requireAgents();
  const pod = await api.agent.pod().catch(() => null);

  if (!pod) {
    return null;
  }
  const dir = `${ AGENT_HOME }/.claude/projects/${ workspaceWorkdir(workspace).replace(/\//g, '-') }`;
  const js = [
    'const fs=require("fs");const f=process.argv[1];const lines=fs.readFileSync(f,"utf8").split("\\n");',
    'let out=null;for(let i=lines.length-1;i>=0&&!out;i--){let e;try{e=JSON.parse(lines[i])}catch{continue}',
    'if(e.type!=="assistant"||e.isSidechain||e.isMeta)continue;const c=e.message&&e.message.content;if(!Array.isArray(c))continue;',
    'const t=c.filter(b=>b.type==="text"&&b.text&&b.text.trim()&&!/^</.test(b.text.trim())).map(b=>b.text).join("\\n").trim();',
    'if(t)out={at:e.timestamp||"",text:t.slice(0,2000)}}',
    'process.stdout.write(JSON.stringify(out));',
  ].join('');
  const script = [
    'export PATH=/workspace/.home/.local/bin:/usr/local/bin:/usr/bin:/bin:$PATH',
    `f=$(ls -t ${ dir }/*.jsonl 2>/dev/null | head -1)`,
    '[ -n "$f" ] || { echo null; exit 0; }',
    `echo "@@FILE $f"`,
    `node -e '${ js.replace(/'/g, "'\\''") }' "$f"`,
  ].join('\n');
  const out = await podExecOnce(api.agent.namespace, pod, api.agent.container, ['/bin/sh', '-c', script], AGENT_BASE).catch(() => '');
  const file = /@@FILE (\S+)/.exec(out)?.[1] || '';
  const json = out.slice(out.lastIndexOf('\n') + 1).trim();

  try {
    const parsed = JSON.parse(json || 'null');

    return parsed ? { ...parsed, conversation: file.split('/').pop()?.replace(/\.jsonl$/, '') || '' } : null;
  } catch {
    return null;
  }
}

/**
 * Type something into a conversation that is already running.
 *
 * `queuePrompt` writes the file the pane's loop reads *when claude starts*, which is right for
 * a conversation that has not begun and does nothing at all for one that has: the prompt sat
 * in the queue and the person watched an idle pane. This is the other half - the text pasted
 * into the pane's tmux and entered, which is what a person at the terminal does.
 *
 * Through a buffer rather than `send-keys` with the text on the command line: a prompt holds
 * quotes, newlines and dollars, and a buffer is the one path that carries them untouched.
 */
export async function sendToPane(id: string, text: string): Promise<void> {
  const api = await requireAgents();
  const pod = await api.agent.pod();

  if (!pod) {
    throw new Error('The agent pod is not running, so there is nothing to type into.');
  }
  const bytes = new TextEncoder().encode(text);
  let binary = '';

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  const file = `/tmp/.say-${ Date.now().toString(36) }`;
  const script = [
    'export PATH=/workspace/.home/.local/bin:/usr/local/bin:/usr/bin:/bin:$PATH',
    `echo ${ btoa(binary) } | base64 -d > ${ file }`,
    `chmod 666 ${ file } 2>/dev/null || true`,
    // As the pane's user: the tmux server is theirs, and root's is a different one.
    `as_user() { if [ "$(id -u)" = 0 ]; then setpriv --reuid=1000 --regid=1000 --init-groups env HOME=${ AGENT_HOME } "$@"; else env HOME=${ AGENT_HOME } "$@"; fi; }`,
    `as_user tmux load-buffer -b mc-send ${ file }`,
    `as_user tmux paste-buffer -b mc-send -t mc-${ id } -d -p`,
    'sleep 0.3',
    `as_user tmux send-keys -t mc-${ id } Enter`,
    `rm -f ${ file }`,
    'echo SENT',
  ].join('\n');
  const out = await podExecOnce(api.agent.namespace, pod, api.agent.container, ['/bin/sh', '-c', script], AGENT_BASE);

  if (!out.includes('SENT')) {
    throw new Error(`The message could not be typed into ${ id }: ${ out.trim().slice(-200) || 'the pane did not answer' }`);
  }
}

/** Where one conversation's transcript is, in the agent pod: from the id its pane recorded, or its state file. */
export async function transcriptPathOf(workspace: string, id: string): Promise<string> {
  const api = await requireAgents();
  const pod = await api.agent.pod().catch(() => null);

  if (!pod || !/^p-.+-\d+$/.test(id)) {
    return '';
  }
  const dir = `${ AGENT_HOME }/.claude/projects/${ workspaceWorkdir(workspace).replace(/\//g, '-') }`;
  const script = [
    `s=$(cat ${ AGENT_WORKSPACE }/sessions/${ id }.id 2>/dev/null | tr -d '\\n')`,
    `[ -n "$s" ] || s=$(node -e 'try{process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).sessionId||""))}catch(e){}' ${ AGENT_WORKSPACE }/sessions/${ id }.state.json 2>/dev/null)`,
    `[ -n "$s" ] && [ -f "${ dir }/$s.jsonl" ] && echo "${ dir }/$s.jsonl"`,
  ].join('\n');

  return (await podExecOnce(api.agent.namespace, pod, api.agent.container, ['/bin/sh', '-c', script], AGENT_BASE).catch(() => '')).trim();
}

/**
 * The conversations that have a prompt queued and no pane yet - registered, told what to do,
 * and never started.
 *
 * The queue file is written when the prompt is queued and read and removed by the pane's loop
 * the moment claude first starts (claude-session.sh), so a queue file with no tmux session
 * behind it is exactly a conversation nobody has opened. Answered from the agent pod, where
 * both live. The tmux server is the pane user's, so the question is asked as that user.
 */
export async function queuedNotStarted(): Promise<{ id: string; workspace: string }[]> {
  const api = await requireAgents();
  const pod = await api.agent.pod().catch(() => null);

  if (!pod) {
    return [];
  }
  const script = [
    'export PATH=/workspace/.home/.local/bin:/usr/local/bin:/usr/bin:/bin:$PATH',
    `for f in ${ AGENT_WORKSPACE }/.queue/*; do`,
    '  [ -f "$f" ] || continue',
    '  id=$(basename "$f")',
    '  if [ "$(id -u)" = 0 ]; then setpriv --reuid=1000 --regid=1000 --init-groups env HOME=/workspace/.home tmux has-session -t "mc-$id" 2>/dev/null || echo "$id"; else tmux has-session -t "mc-$id" 2>/dev/null || echo "$id"; fi',
    'done',
  ].join('\n');
  const listing = await podExecOnce(api.agent.namespace, pod, api.agent.container, ['/bin/sh', '-c', script], AGENT_BASE).catch(() => '');

  return listing.split('\n')
    .map((line) => line.trim())
    .filter((id) => /^p-.+-\d+$/.test(id))
    .map((id) => ({ id, workspace: id.replace(/^p-/, '').replace(/-\d+$/, '') }));
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
    await api.agent.queue(id, prompt);
  }

  return conversation;
}

export async function renameConversation(workspace: string, id: string, title: string): Promise<void> {
  await (await requireAgents()).agent.rename(id, title);
}

/**
 * End it: the registry entry and the tmux session with claude in it, both in the agent pod.
 *
 * One call now that the pane lives there - the agents extension's `end` kills the session and
 * removes the conversation's directory together.
 */
export async function endConversation(workspace: string, id: string): Promise<void> {
  await (await requireAgents()).agent.end(id);
}

/**
 * End every conversation a workspace has, for a workspace that is being deleted.
 *
 * They are the one part of a workspace that is not in its namespace: a tmux session and a
 * transcript in the agent pod, named after the workspace. Left running, they are inherited by
 * the next workspace of that name - an agent mid-thought about a checkout that no longer
 * exists. Best effort, one at a time: the delete must not fail because a session was already
 * gone.
 */
export async function endWorkspaceConversations(workspace: string): Promise<number> {
  const conversations = await listConversations(workspace).catch(() => []);

  for (const conversation of conversations) {
    await endConversation(workspace, conversation.id).catch(() => null);
  }

  return conversations.length;
}

/**
 * Queue a prompt for a conversation to open with, or say something into one that is running.
 *
 * The agents extension's, because the pane is in its pod: it writes the file the pane reads on
 * its first start and types into the tmux session when one is already running.
 */
export async function queuePrompt(attach: Attachment, prompt: string): Promise<void> {
  await (await requireAgents()).agent.queue(attach.id, prompt);
}

/**
 * Start a conversation's pane with nobody attached: shell.sh in `start` mode makes the tmux
 * session detached, and claude in it reads whatever was queued. Run from the agent pod the
 * way a terminal would, so an agent's run begins the moment it is asked for rather than the
 * next time somebody opens the tab.
 */
export async function startPaneDetached(workspace: string, id: string): Promise<void> {
  const api = await requireAgents();
  const pod = await api.agent.pod();

  if (!pod) {
    throw new Error('The agent pod is not running, so there is nothing to start the pane from.');
  }
  const argv = ['/bin/sh', '/seed/shell.sh', id, workspaceWorkdir(workspace), AGENT_HOME, 'start', workspaceShellWrapper(workspace)];

  await podExecOnce(api.agent.namespace, pod, api.agent.container, argv, AGENT_BASE);
}

/**
 * Put a conversation back onto the login on disk, without losing it.
 *
 * The pod's own `claude-credentials.mjs reconnect` does it: claude in the pane is stopped and
 * the loop that owns the pane starts it again on the same conversation, so the transcript, the
 * name and the scrollback are all still there. The pane itself is never killed, which is the
 * difference between this and closing the tab.
 *
 * It is manual on purpose. The daemon that keeps one login shared between pods used to do this
 * by itself whenever a newer token arrived, which - while a login is being refreshed - is every
 * few seconds, and it interrupted whatever each conversation was doing. Now it writes the token
 * and leaves the panes alone; this is the button that picks it up.
 */
export async function reconnectConversation(attach: Attachment): Promise<void> {
  await reconnectIn(attach.workspace, attach.id);
}

/** The same for every conversation in one place: the drawer, or one workspace. */
export async function reconnectEverything(workspace: string): Promise<void> {
  await reconnectIn(workspace, '');
}

async function reconnectIn(workspace: string, id: string): Promise<void> {
  const argv = ['node', '/seed/claude-credentials.mjs', 'reconnect', ...(id ? [id] : [])];
  // Every pane, a workspace's included, is a tmux session in the agent pod, so `workspace` says
  // nothing about where to run this - only `id` does, and without one it reconnects them all.
  const api = await requireAgents();
  const pod = await api.agent.pod();

  if (!pod) {
    throw new Error('The agent pod is not running, so there is nothing to reconnect.');
  }
  await podExecOnce(api.agent.namespace, pod, api.agent.container, argv, AGENT_BASE);
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
    /** The drawer's own conversations (`agent-<n>`). */
    sessions(): Promise<{ id: string; title: string }[]>;
    projectSessions(project: string): Promise<{ id: string; title: string }[]>;
    /** A new drawer conversation; its id. */
    start(): Promise<string>;
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
