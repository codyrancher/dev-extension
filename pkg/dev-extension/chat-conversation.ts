// A conversation, with nothing drawn: what it is, what it is doing, and how to say something to it.
//
// This is the whole of what ChatPane.vue used to own privately - reading the transcript claude
// writes, reading the pane it runs in, deriving what state the conversation is in, sending, the
// queue, the pending messages, the questions, the tool calls, the subagents, the model options -
// lifted out so that *where* a conversation is drawn is a separate question from *what* it is.
//
// It was lifted because the Focus deck's bar needed to be a chat rather than a button that
// opens one, and the only two ways to do that from a 4,137-line component are to embed the
// component (which drags its drawer, its toggle and its own idea of layout onto a bar) or to
// write the send path a second time (which drifts: there are four places in here that know what
// "claude has not recorded this message yet" means, and two copies of them would disagree
// within a week). So neither: one conversation, two skins. ChatPane.vue is the drawer's skin and
// components/focus/FocusChatBar.vue is the bar's, and both of them call this.
//
// Two things feed it, both read out of the pod the pane runs in - see chat.ts for the detail:
//
//   - the transcript claude writes as it goes, which is what the messages, the tool calls and
//     their results are rendered from;
//   - the last lines of the pane itself, which is where a question with numbered answers, a
//     permission prompt or the login flow shows up.
//
// What it is *not* is a store. There is no `provide`/`inject` here and there is no module-level
// singleton, deliberately: a UMD-loaded extension gets its own copy of vue, so an injection
// that crosses the extension boundary resolves to `undefined` - it works on the dev server and
// is silently dead in the installed plugin. A host creates one of these and passes what it
// returns to its children as props, which is the one arrangement that cannot break that way.

import { canonicalTool } from './chat-format.mjs';
import {
  computed, onBeforeUnmount, onMounted, ref, watch,
} from 'vue';
import {
  parseTranscript, renderMarkdown, renderPlain, linkPaths, readPane, toolSummary, projectKey,
  agentsFrom, noteFrom,
  type ChatAgent, type ChatMessage, type ChatToolCall,
} from './chat';
import {
  ago, deriveState, parseEntries, reconcilePending, unwrapPasted,
} from './chat-state.mjs';
import {
  AGY_COMMANDS, AGY_CUSTOMIZE, agyPhase, agyTailText,
} from './agent-clis.mjs';
import { frameNonce, isFramed, readFrames, spliceEarlier } from './chat-frames.mjs';
import { chatReadScript } from './chat-read.mjs';
import { podStateText, PodStateUnavailable } from './pod-state';
import { paneSendScript } from './pane-send.mjs';
import {
  modelAliases, flagChoices, parseMcpList, currentModel, isSafeOptionValue, type McpServer,
} from './chat-options';
import {
  podExecOnce, statPodPath, readPodFileBase64, type PodTarget,
} from './pod';
import { agentPod, sessionCommand } from './agent';
import type { SessionMode } from './agent';

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Where the conversation is, and what it is allowed to touch. The host's props, in other words. */
export interface ConversationSource {
  /** The conversation id, for the Studio's default argv. */
  session: string;
  /** Which CLI holds this conversation, and how the pane runs. See sessionCommand. */
  mode?: SessionMode;
  /** The argv the pane runs, when it is not one of the agent pod's own conversations. */
  command?: string[] | null;
  namespace: string;
  container: string;
  /** Where a pasted image is written, so its path can go into the message. */
  imageDir?: string;
  home?: string;
  /** Answers the pod name, when it is not the agent pod. */
  findPod?: (() => Promise<string | null>) | null;
  /** What to call the pod in a sentence somebody reads. */
  label?: string;
  /**
   * Whether to read at all.
   *
   * A poll is an exec into a pod every 1.5 seconds, and the Focus bar exists on the page from
   * the moment it loads while the conversation behind it is not made until somebody opens or
   * asks something. So a host says when it wants reading to start, and a host that does not
   * care leaves this alone.
   */
  enabled?: boolean;
}

/** One message as something to draw: the parsed turn, plus the HTML and the tool rows. */
export interface ConversationTurn extends ChatMessage {
  html: string;
  queued: boolean;
  inQueue: boolean;
  failed: boolean;
  toolRows: (ChatToolCall & { summary: string; summaryHtml: string })[];
}

/** A command this pane can be sent: claude's own, or a file in the pod. */
export interface ChatCommand {
  name: string;
  help: string;
  source: string;
  path?: string;
}

/** The subagent rows: who is still writing, and what each last said. */
export interface ChatAgentRow extends ChatAgent {
  working: boolean;
  last: string;
  when: string;
}

/** What the pane is asking, when it is asking something a text box cannot answer. */
export interface ConversationDialog {
  kind: string;
  header?: string;
  prompt: string;
  options: { key: string; label: string; description?: string; selected: boolean }[];
  url: string;
}

const POLL_MS = 1500;
const CHUNK = 3000;
const THUMB_MAX = 400_000;
const MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml',
};

/** What the send script can end with, said the way the chat shows it. */
const SAY_FAILURE: Record<string, string> = {
  NOBUFFER: 'the agent pod would not take the message: tmux refused the buffer it is pasted from',
  NOPANE:   'this conversation has no pane running to type into - reopen it and it will start again',
  STUCK:    'the message reached the conversation but it would not take it: the text is sitting in its prompt box unsent',
  NOTTYPED: 'the pane never took the message: its prompt box is exactly as it was. It may have been compacting - try again',
};

export function escapeText(text: unknown): string {
  return String(text || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Claude Code's interactive managers: commands that open a full-screen picker rather than
 * answering in the conversation.
 *
 * No chat can draw any of these, so sending one is the one thing a chat does that leaves the
 * pane in a state it has to hand to the terminal. Listed because knowing *what was sent* is the
 * only reliable way to know that has happened - the pane's own shape cannot be told apart from
 * an ordinary finished turn, which is the mistake an earlier version of this warning made.
 */
const MANAGER_COMMANDS = ['mcp', 'permissions', 'hooks', 'memory', 'agents', 'model', 'config', 'resume', 'vim'];

/** The manager a message opens, if it opens one: `/mcp`, `/mcp something`, and nothing else. */
export function managerIn(text: string): string {
  const match = /^\/([a-z-]+)\b/.exec(String(text || '').trim());

  return match && MANAGER_COMMANDS.includes(match[1]) ? match[1] : '';
}

/**
 * Slash commands that answer in the terminal and nowhere else.
 *
 * `/model` writes what it did into the transcript as a local-command line, and a chat shows that
 * as a note. `/cost`, `/usage`, `/status` and the rest print to the pane only - the transcript
 * has no record they were even typed - so after sending one of these the pane is read and what
 * it printed is shown instead. A person asking what this session cost gets the same answer in
 * either view.
 */
const TERMINAL_ONLY = ['cost', 'usage', 'status', 'context', 'doctor', 'help', 'todos', 'release-notes', 'version'];

export function terminalOnly(text: string): boolean {
  const match = /^\/([a-z-]+)\b/.exec(String(text || '').trim());

  return !!match && TERMINAL_ONLY.includes(match[1]);
}

/**
 * Where queued messages are kept between visits.
 *
 * They used to live only in the component's data, which meant they survived exactly as long as
 * the component did: switching conversation or leaving the page unmounts it, and coming back
 * showed a log with the message gone - while the terminal, reading the same pane, still had it
 * in claude's input queue. So the one view that promised "this is waiting" was the one that
 * forgot.
 *
 * Per pane, because a queue belongs to the conversation it was typed into. localStorage can
 * throw outright in a private window or with site data blocked, so every read and write is
 * guarded and an unavailable one simply means the old behaviour.
 */
const PENDING_KEY = 'mc-chat.pending';

function readPending(paneId: string): any[] {
  try {
    const all = JSON.parse(localStorage.getItem(PENDING_KEY) || '{}');

    return Array.isArray(all[paneId]) ? all[paneId] : [];
  } catch {
    return [];
  }
}

function writePending(paneId: string, list: any[]): void {
  try {
    const all = JSON.parse(localStorage.getItem(PENDING_KEY) || '{}');

    if (list.length) {
      all[paneId] = list;
    } else {
      delete all[paneId];
    }
    localStorage.setItem(PENDING_KEY, JSON.stringify(all));
  } catch {
    // A browser that will not remember is not a view that fails.
  }
}

/**
 * Claude Code's own slash commands, for the ones that are not files anywhere.
 *
 * The custom half of the list is read out of the pod, which is authoritative: a project's
 * commands and skills are files, and files can be listed. The built-in half cannot be - claude
 * knows them, the filesystem does not - so it is written here, and that is why an unrecognised
 * command is reported as "not one I know of" and never as invalid, and never blocks sending.
 * This list going stale must cost a hint, not a message.
 */
export const BUILTIN_COMMANDS: ChatCommand[] = [
  ['/add-dir', 'Add another working directory'],
  ['/agents', 'Manage agent configurations'],
  ['/clear', 'Clear the conversation history'],
  ['/compact', 'Summarise the conversation so far'],
  ['/config', 'Open the config panel'],
  ['/context', 'Show what is in the context window'],
  ['/cost', 'Token usage for this session'],
  ['/doctor', 'Check the installation'],
  ['/exit', 'Leave'],
  ['/export', 'Export the conversation'],
  ['/help', 'List the commands claude actually has'],
  ['/hooks', 'Configure hooks'],
  ['/init', 'Write a CLAUDE.md for this repository'],
  ['/login', 'Sign in'],
  ['/logout', 'Sign out'],
  ['/mcp', 'MCP servers and their tools'],
  ['/memory', 'Edit the memory files'],
  ['/model', 'Choose the model'],
  ['/permissions', 'Edit tool permissions'],
  ['/resume', 'Resume an earlier conversation'],
  ['/review', 'Review a pull request'],
  ['/rewind', 'Go back to an earlier point'],
  ['/status', 'Version, account and connectivity'],
  ['/todos', 'The current todo list'],
  ['/usage', 'Plan usage limits'],
  ['/vim', 'Toggle vim mode'],
].map(([name, help]) => ({ name, help, source: 'built-in' }));

/** Antigravity's, in the same shape. See AGY_COMMANDS for where the list comes from. */
export const AGY_BUILTIN_COMMANDS: ChatCommand[] = AGY_COMMANDS
  .map((pair: string[]) => ({ name: pair[0], help: pair[1], source: 'built-in' as const }));

/**
 * The built-in commands for one CLI.
 *
 * A menu showing the wrong CLI's commands is worse than no menu: every entry in it is a message
 * the pane will answer with "unknown command", and the person picked it from a list this product
 * showed them.
 */
export function builtinCommandsFor(cli: string): ChatCommand[] {
  return cli === 'agy' ? AGY_BUILTIN_COMMANDS : BUILTIN_COMMANDS;
}

/** And the pickers, likewise. */
export function customizeFor(cli: string) {
  return cli === 'agy' ? AGY_CUSTOMIZE : CUSTOMIZE;
}

/**
 * The Customize section of the command menu.
 *
 * The VS Code extension's `/` menu has one, and what is in it is "MCP servers, slash commands,
 * output styles, hooks, memory, permissions and plugins" - claude's own pickers, reached from
 * the command menu rather than from buttons on the prompt box. Only the ones a chat can actually
 * open are listed: each is a slash command typed into the pane, and its dialog comes back
 * through the path a chat already draws options for.
 */
export const CUSTOMIZE = [
  { command: 'mcp', help: 'MCP servers' },
  { command: 'permissions', help: 'tool permissions' },
  { command: 'hooks', help: 'hooks' },
  { command: 'memory', help: 'the memory files' },
  { command: 'agents', help: 'subagent definitions' },
];

/**
 * The template's view of the state: the same four things a chat always drew, decided by
 * chat-state.mjs rather than by the look of the terminal.
 */
function paneFromState(state: any, paneText = ''): { busy: boolean; idle: boolean; gone: boolean; dialog: ConversationDialog | null; status: string } {
  const gone = state.phase === 'gone' || state.phase === 'absent';
  let dialog: ConversationDialog | null = null;

  if (state.phase === 'question' && state.question) {
    const q = state.question;
    const first = q.questions[0] || {};
    const options = q.tool === 'ExitPlanMode'
      ? [{ key: '1', label: 'Yes, proceed', selected: false }, { key: '2', label: 'No, keep planning', selected: false }]
      : (first.options || []).map((o: any, i: number) => ({
        key: String(i + 1), label: o.label || `option ${ i + 1 }`, description: o.description || '', selected: false,
      }));

    dialog = {
      kind:    'options',
      header:  q.tool === 'ExitPlanMode' ? 'Plan ready' : (first.header || ''),
      prompt:  q.tool === 'ExitPlanMode' ? q.plan.slice(0, 4000) : String(first.question || ''),
      options,
      url:     '',
    };
  } else if (state.phase === 'login' && state.login) {
    dialog = {
      kind: state.login.kind, prompt: 'Claude needs you to sign in.', options: [], url: state.login.url,
    };
  } else if (state.phase === 'waiting') {
    // claude said it is waiting (the Notification hook) but the transcript has not written the
    // question yet - it can lag the prompt by minutes. The question is on the screen, though,
    // and the pane reader knows the shape of a numbered list with the current choice marked;
    // its options are the same keystrokes, so the buttons work the same. This is the one place
    // the terminal's look is read for structure, and only while claude itself says to.
    const seen = readPane(paneText);

    if (seen.dialog && seen.dialog.options.length) {
      dialog = { ...seen.dialog, header: '' } as ConversationDialog;
    }
  }

  return {
    busy: state.phase === 'working', idle: state.phase === 'idle', gone, dialog, status: state.status || '',
  };
}

function b64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary);
}

export type Conversation = ReturnType<typeof useConversation>;

/**
 * One conversation, read and written.
 *
 * `source` is a getter rather than a plain object so a host can change which conversation this
 * is - the Focus bar switches from the panel's own to a workspace's when a card is asked about -
 * without tearing the composable down. Everything derived from it recomputes, and the watcher
 * below throws away the transcript that belonged to the old one.
 */
export function useConversation(source: () => ConversationSource) {
  /**
   * Whether this conversation's reads go over HTTP.
   *
   * Per conversation rather than per page: one pane may be in another pod while the one beside
   * it is in the agent pod.
   *
   * `off` is final, and it is set for one reason only: an answer that came back without this
   * read's frames. That is a real disagreement about what a read looks like, and asking again
   * would not change it.
   *
   * A pod that is simply unavailable is not that, and used to be treated as if it were - so a
   * service that was starting, or a minute into a cooldown, took that conversation off HTTP for
   * as long as the tab stayed open. pod-state.ts already holds the circuit breaker that stops
   * a failing pod from being asked, and while it is open it refuses without making a request,
   * so leaving the decision there costs nothing and lets a conversation come back.
   */
  let httpRead: 'unknown' | 'on' | 'off' = 'unknown';

  const from = computed(() => source());
  const enabled = computed(() => from.value.enabled !== false && !!(from.value.session || from.value.command?.length));

  /* ── Where it is ──────────────────────────────────────────────────────────────────────────── */

  /** The pane's argv, and what it says about where the pane is. */
  const argv = computed<string[]>(() => (from.value.command?.length ? from.value.command : sessionCommand(from.value.session, from.value.mode || 'claude')));

  /**
   * Which CLI holds this conversation, for the two things in the read that differ by it: where
   * the transcript is, and which program's presence in the pane means "running".
   *
   * Everything else in the read is the same for both, and the pieces that are claude's alone -
   * the hook state file, the subagent transcripts - simply come back empty for agy rather than
   * needing a branch of their own.
   */
  const cli = computed<'claude' | 'agy'>(() => (from.value.mode === 'agy' ? 'agy' : 'claude'));
  const shellAt = computed(() => argv.value.indexOf('/seed/shell.sh'));
  const paneId = computed(() => (shellAt.value >= 0 ? argv.value[shellAt.value + 1] : from.value.session));
  const workdir = computed(() => (shellAt.value >= 0 && argv.value[shellAt.value + 2]) || '/workspace/conversations');
  const paneHome = computed(() => (shellAt.value >= 0 && argv.value[shellAt.value + 3]) || from.value.home || '/workspace/.home');

  /**
   * Everything up to the `--` of a `kubectl exec`, without the TTY flags, when the pane is in
   * another pod. The kubectl may be wrapped (a shell that sets PATH first, say); what marks it
   * is `kubectl` followed by `exec` somewhere before the `--`.
   */
  const prefix = computed<string[]>(() => {
    const list = argv.value;
    const dash = list.indexOf('--');
    const k = list.findIndex((arg, i) => arg === 'kubectl' && list[i + 1] === 'exec');

    if (k < 0 || dash < k) {
      return [];
    }

    return list.slice(0, dash + 1).filter((arg) => arg !== '-t' && arg !== '-i' && arg !== '-it' && arg !== '-ti');
  });

  /* ── What it is ───────────────────────────────────────────────────────────────────────────── */

  const messages = ref<ChatMessage[]>([]);
  const lines = ref<string[]>([]);
  const remainder = ref('');
  const offset = ref(0);
  /**
   * The byte the held history begins at, and whether there is anything before it.
   *
   * The first read of a long transcript takes only its last megabyte - the whole of one does not
   * arrive through a single exec - which used to be the end of it: everything earlier was simply
   * unreachable, so a conversation that had run all day opened on its last hour and that was all
   * there was. `loadEarlier` reads the page before this, and `historyStart` walks back to 0.
   */
  const historyStart = ref(0);
  const loadingEarlier = ref(false);
  /** Goes up when a page was joined onto the front, for a host that keeps its place while it is. */
  const prepended = ref(0);
  /** Nothing earlier to ask for: the view holds the transcript from its first byte. */
  const atStart = computed(() => historyStart.value <= 0);
  const file = ref('');
  const entries = ref<any[]>([]);
  const hook = ref<any>(null);
  const alive = ref(false);
  const attached = ref(false);
  const paneText = ref('');
  /**
   * What the conversation is doing, decided from claude's own record rather than from the look
   * of its terminal: see chat-state.mjs, which is also what the verifier runs. `pane` below is
   * derived from it for whoever is drawing.
   */
  const state = ref<any>({
    phase: 'absent', status: '', queue: [], question: null, login: null, model: '', effort: '', cost: null,
  });
  const pane = ref<{ busy: boolean; idle: boolean; gone: boolean; dialog: ConversationDialog | null; status: string }>({
    busy: false, idle: false, dialog: null, gone: false, status: '',
  });
  /** When the last poll came back, as ISO: a stalled poll is a view that stopped being true. */
  const polledAt = ref('');
  /**
   * Two counters a host watches instead of being told where to scroll.
   *
   * `grew` goes up whenever a poll landed new transcript; `restarted` goes up when the thing
   * being read changed outright - a first load, a different conversation, a subagent tab. A log
   * stays at the bottom only while the person is already there, and jumps to it unconditionally
   * on a restart, and those are two different events rather than one boolean. Counters rather
   * than events because this has no emitter: a host watches a number.
   */
  const grew = ref(0);
  const restarted = ref(0);
  const error = ref('');
  const polling = ref(false);
  let timer: ReturnType<typeof setInterval> | null = null;

  // Which conversation is shown: the main one, or one of the subagents it launched (by agent
  // id), whose transcript is followed the same way with an offset of its own.
  const view = ref('main');
  const sub = ref<{ offset: number; lines: string[]; remainder: string; messages: ChatMessage[] }>({
    offset: 0, lines: [], remainder: '', messages: [],
  });
  // The subagents' last words and when they last wrote, read on every poll.
  const tails = ref<Record<string, { at: number; last: string; name: string }>>({});

  /* ── What is on its way ───────────────────────────────────────────────────────────────────── */

  const draft = ref('');
  /** Where the cursor is in the box, so the command menu can follow it. */
  const caret = ref(0);
  const sending = ref(false);
  const code = ref('');
  const pasting = ref('');
  /**
   * What has been sent from a box and is not in the transcript yet.
   *
   * Everything in the log comes from the transcript claude writes, and claude writes a user turn
   * when it *starts* on it. So a message sent while it is working goes into its input queue and
   * is written minutes later, or not until the current turn ends - and until then a view had
   * cleared the box and shown nothing anywhere, which reads as the message having been dropped.
   * These are held here and drawn at the end of the log, marked as queued, until the transcript
   * catches up with them (see prunePending).
   */
  const pending = ref<any[]>(readPending(paneId.value));
  /**
   * Images being written into the pod, whose paths are already in the box.
   *
   * Pasting puts the path in immediately and uploads behind it, so this is the only thing that
   * still has to be waited for - and only at Send, and only if it has not finished by then.
   * Typing the rest of the message usually outlasts the upload.
   */
  const uploads = ref<Promise<void>[]>([]);
  /** What the terminal printed for a command the transcript does not record (see TERMINAL_ONLY). */
  const echoes = ref<any[]>([]);
  /** The terminal's panel for /usage, /status and the like, for a host to show until it is closed. */
  const panel = ref<{ title: string; text: string } | null>(null);
  /**
   * The interactive command last put into the pane, while its picker is still up.
   *
   * Set when one is sent and cleared the moment the conversation moves on - see `clearManager`.
   * It exists so `takenOver` is something known rather than something inferred.
   */
  const manager = ref('');

  /* ── What it can be set to ────────────────────────────────────────────────────────────────── */

  /** Read from claude rather than listed in a file: claude updates itself inside that pod. */
  const options = ref<{ read: boolean; models: string[]; efforts: string[]; model: string; modelSource: string; effort: string }>({
    read: false, models: [], efforts: [], model: '', modelSource: '', effort: '',
  });
  const mcp = ref<{ read: boolean; loading: boolean; servers: McpServer[]; error: string }>({
    read: false, loading: false, servers: [], error: '',
  });
  /** Whether claude thinks before answering: the alwaysThinkingEnabled setting in the pane's home. */
  const thinking = ref<boolean | null>(null);
  const optionBusy = ref('');
  /** The commands that are files in this pod. */
  const custom = ref<ChatCommand[]>([]);
  /** Where the files a message names live. Looked up once, then kept. */
  const media = ref<PodTarget | null>(null);
  /** Thumbnails fetched from the pod: path -> data URL, or 'missing'/'large'. */
  const thumbs = ref<Record<string, string>>({});

  /* ── Derived ──────────────────────────────────────────────────────────────────────────────── */

  /**
   * The subagents this conversation launched, for the tabs.
   *
   * Two CLIs say it in two places. claude names one in the `Agent` call that started it and
   * answers with its id, so the transcript holds the whole list - `agentsFrom`. agy writes a
   * file per subagent instead (`<brain>/<session>/.system_generated/subagents/<id>.json`,
   * carrying `subagentDescriptor.role`), and its transcript says nothing about them at all; the
   * frame lists that directory and sends each one's name beside its mtime, so here they come
   * off the tails. Which is also why an agy subagent appears a poll later than a claude one -
   * it appears when the directory does.
   */
  const agents = computed<ChatAgent[]>(() => {
    if (cli.value !== 'agy') {
      return agentsFrom(messages.value);
    }

    return Object.entries(tails.value).map(([id, t]) => ({ id, description: t.name || id.slice(0, 8) }));
  });

  /** The subagents with what each last said, the ones still writing first. */
  const agentRows = computed<ChatAgentRow[]>(() => {
    const now = Date.now() / 1000;

    return agents.value.map((a) => {
      const tail = tails.value[a.id] || ({} as any);
      const working = !!tail.at && now - tail.at < 45;

      return {
        ...a, working, last: tail.last || '', when: tail.at ? when(new Date(tail.at * 1000).toISOString()) : '',
      };
    }).sort((x, y) => Number(y.working) - Number(x.working));
  });

  const workingAgents = computed(() => agentRows.value.filter((a) => a.working).length);

  const shown = computed<any[]>(() => {
    if (view.value !== 'main') {
      return sub.value.messages;
    }

    /*
     * Only on the main conversation: a message typed here goes to claude, never to one of the
     * subagents whose transcript the tabs show.
     *
     * What is drawn is what the PERSON is waiting on claude to read. The CLI queues its own
     * lines the same way - a background task finishing, a system reminder, a slash command -
     * and those used to be drawn here too, as a note apiece. On a review with a dozen
     * background agents reporting in that was the whole bottom of the log: a stack of
     * "Background task completed: Monitor event…" cards pinned under the newest turn, which is
     * the one thing a person opens this to read.
     *
     * They are not lost by being left out. Each one appears in the history where claude reads
     * it, once, as the note it is - the path above this does that. And the fold these come from
     * leaves phantoms behind (see foldQueue), so some of those cards were waiting on nothing at
     * all and would never have gone away.
     */
    const queued = (state.value.queue || []).map((raw: string, i: number) => {
      const text = unwrapPasted(raw);

      return noteFrom(text) !== null ? null : {
        key: `queue-${ i }-${ text.slice(0, 24) }`, role: 'user', text, tools: [], thinking: '', images: [], at: '', queued: true, inQueue: true,
      };
    }).filter((m: any) => m?.text);

    const extra = [...echoes.value, ...queued, ...pending.value];

    return extra.length ? [...messages.value, ...extra] : messages.value;
  });

  /** Every turn as something to draw. The one place a message becomes HTML. */
  const turns = computed<ConversationTurn[]>(() => shown.value.map((m) => ({
    ...m,
    html:     m.role === 'user' ? renderPlain(m.text, m.parts) : linkPaths(renderMarkdown(m.text)),
    queued:   !!m.queued,
    inQueue:  !!m.inQueue,
    failed:   !!m.failed,
    // Through the canonical layer on the way to the view: a tool call arrives here in whatever
    // vocabulary its CLI writes, and leaves with the badge and the one-line summary the view
    // draws, keyed on what the call DID. See chat-format.mjs - this is the one place a message
    // becomes something drawable, so it is the one place that has to do it.
    toolRows: m.tools.map((t: ChatToolCall) => {
      const call = canonicalTool(t);

      return { ...call, summaryHtml: linkPaths(escapeText(call.summary)) };
    }),
  })));

  /** Every command that could be typed here: claude's own, then this pod's own. */
  const commands = computed<ChatCommand[]>(() => [...builtinCommandsFor(cli.value), ...custom.value]);

  /**
   * The command being typed at the cursor, wherever the cursor is.
   *
   * The menu used to open only for a slash in the first column, which is where claude's own
   * commands have to be - but half of what people type a skill's name into is a sentence ("when
   * CI is green run /my-pr-create"), and having to remember the name exactly because the menu
   * will not help you anywhere but the front is the wrong way round. So the menu follows the
   * cursor: a slash that starts a word, with the word still being typed.
   */
  const slashSpot = computed<{ name: string; start: number; end: number } | null>(() => {
    const at = Math.min(caret.value ?? draft.value.length, draft.value.length);
    const before = draft.value.slice(0, at);
    const match = /(^|[\s([{"'`])\/([a-zA-Z0-9_:-]*)$/.exec(before);

    if (!match) {
      return null;
    }
    const name = `/${ match[2] }`;

    return { name, start: at - name.length, end: at };
  });

  const slashMatches = computed<ChatCommand[]>(() => {
    if (!slashSpot.value) {
      return [];
    }
    const typed = slashSpot.value.name.toLowerCase();

    return commands.value.filter((c) => c.name.toLowerCase().startsWith(typed)).slice(0, 8);
  });

  /**
   * The draft with its command names marked, for a layer over the box.
   *
   * Only names this pod actually has are marked: a path with a slash in it, or a name claude has
   * never heard of, is left as plain text rather than promised something it cannot do.
   */
  const draftMarked = computed(() => {
    const known = new Map(commands.value.map((c) => [c.name.toLowerCase(), c]));
    const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    return `${ escape(draft.value).replace(/(^|[\s([{"'`])(\/[a-zA-Z0-9_:-]+)/g, (all, lead, name) => {
      const found = known.get(name.toLowerCase());

      return found ? `${ lead }<mark class="mc-chat__cmd" data-name="${ name }">${ name }</mark>` : all;
    }) }\n`;
  });

  const canSend = computed(() => !!draft.value.trim() && !sending.value);
  const working = computed(() => pane.value.busy);

  /**
   * The pane is showing a full-screen picker no chat can draw.
   *
   * Known positively, from what was sent, and NOT inferred from the pane's shape. The first
   * version of this asked "not busy, not idle, no dialog, not gone" - which sounds like a
   * description of a takeover and is really a description of everything readPane does not
   * classify. A finished turn whose last line is claude's own status - `Cooked for 10m 11s ·
   * done` - is none of them: not busy, because it says done, and not idle, because the prompt
   * row is not empty. So the warning fired on ordinary completed work, repeatedly, and told the
   * person their conversation was broken when it was not.
   */
  const takenOver = computed(() => attached.value && !!manager.value && !pane.value.dialog && !pane.value.gone);

  /** The last few lines of it, so what has taken the pane over is at least legible. */
  const paneTail = computed(() => paneText.value.split('\n').filter((l) => l.trim()).slice(-6).join('\n'));

  /**
   * When a subagent last wrote, said the way a turn's own stamp says it.
   *
   * Relative, not the wall clock, for the reason ChatTurn gives: in a conversation the
   * question is how long ago, not what o'clock. The two sat next to each other answering it
   * differently.
   */
  function when(iso: string): string {
    return ago(iso);
  }

  function firstLine(text: string): string {
    return (text || '').split('\n').find((l) => l.trim()) || '';
  }

  /* ── Reaching the pod ─────────────────────────────────────────────────────────────────────── */

  async function locatePod(): Promise<string | null> {
    try {
      const find = from.value.findPod;

      return find ? await find() : await agentPod();
    } catch {
      return null;
    }
  }

  /**
   * Run a script where the pane runs, as the pane's user, with its home. The script travels
   * base64 in one argument, so nothing in it is ever quoted for a shell.
   */
  async function run(script: string, timeoutMs = 20000): Promise<string> {
    const pod = await locatePod();

    if (!pod) {
      throw new Error('no running pod');
    }
    const path = `/tmp/.chat-${ Date.now().toString(36) }${ Math.random().toString(36).slice(2, 7) }.sh`;
    const wrapped = `export HOME=${ paneHome.value }; export PATH=$HOME/.local/bin:$PATH; ${ script }`;
    const inner = `echo ${ b64(wrapped) } | base64 -d > ${ path } && chmod 755 ${ path } && if [ "$(id -u)" = 0 ]; then su node -s /bin/bash -c "/bin/bash ${ path }" 2>&1; else /bin/bash ${ path } 2>&1; fi; rm -f ${ path }`;

    return podExecOnce(pod, [...prefix.value, '/bin/sh', '-c', inner], timeoutMs, from.value.container, from.value.namespace);
  }

  /**
   * One read, over HTTP where the pod can serve it and by exec where it cannot.
   *
   * This is the read that was costing: a live conversation polls every 1.5 seconds, so two of
   * them opened about eighty exec sockets a minute - a WebSocket handshake and a forked process
   * each - to learn something that usually had not changed. The pod serves the same script now,
   * over a plain GET.
   *
   * Two conditions, and both are about whether the pod that answers is the pod that has it.
   * `prefix` is non-empty when the pane is reached by a `kubectl exec` into somewhere else, and
   * `findPod` means this chat was pointed at a pod of its own - a workspace terminal. Neither
   * is the agent pod, which is the only one running a state service, so both keep exec.
   *
   * ── Why there is no read-both-and-compare ──
   *
   * It was the obvious safety net and it does not work. Two reads taken a moment apart differ
   * whenever the transcript grew between them, which is precisely what happens on the busy
   * conversations most worth moving - so a byte comparison would have failed exactly where it
   * was needed and passed where it did not matter.
   *
   * What makes this safe instead is that there is nothing to disagree about: both paths run the
   * same script from the same module, as the same user, in the same pod. So the check that is
   * worth making is whether the answer came back framed - `readFrames` finds this read's nonce
   * or it does not - and an answer that did not is treated as no answer, once, after which this
   * conversation goes back to exec and stays there.
   */
  async function readChat(at: Parameters<typeof chatReadScript>[0] & { home: string }, nonce: string): Promise<string> {
    const local = !prefix.value.length && !from.value.findPod;

    if (local && httpRead !== 'off') {
      const pod = await locatePod();

      if (pod) {
        try {
          const out = await podStateText(pod, `/chat?${ new URLSearchParams({
            id: at.id, off: String(at.off), sub: at.sub, soff: String(at.soff), n: nonce, proj: at.projKey, home: at.home, cli: at.cli,
          }) }`);

          // Framed, so the pod and this page agree about what a read looks like.
          if (isFramed(out, nonce)) {
            httpRead = 'on';

            return out;
          }
          console.debug(`[chat] the pod answered without this read's frames; using exec for ${ at.id }`); // eslint-disable-line no-console
          // Not framed: this pod and this page disagree about what a read looks like, which
          // asking again will not settle.
          httpRead = 'off';
        } catch (e) {
          if (!(e instanceof PodStateUnavailable)) {
            throw e;
          }
          /*
           * A pod with no service, a cluster that does not allow pods/proxy, a service that is
           * starting or inside its cooldown: all of them mean "ask the old way" this time, and
           * none of them is worth saying twice or holding against the next read. The breaker in
           * pod-state.ts is what keeps a failing pod from being asked - it throws without a
           * request while it is open - so this is left `unknown` and tried again when it closes.
           */
        }
      }
    }

    return run(chatReadScript(at));
  }

  /** Keys into the pane: a name tmux knows (Enter, Escape) or a literal string. */
  async function keys(...args: string[]): Promise<void> {
    const quoted = args.map((a) => `'${ String(a).replace(/'/g, `'\\''`) }'`).join(' ');

    await run(`tmux send-keys -t "mc-${ paneId.value }" ${ quoted }`);
  }

  /**
   * Text into the pane as one paste, then Enter: what the person typed, whatever is in it.
   *
   * And then checked, because one Enter is not reliably taken: a TUI still reading a bracketed
   * paste when the Enter arrives swallows it, and two live panes were found holding a message
   * that had never been entered, hours after the page said it was sent.
   *
   * The check is pane-send.mjs's now, which is the same one the rail's actions run. It was a
   * second copy of it, and it kept the half of the bug the rail's copy had already had fixed:
   * "the message is not in the composer" was read as "it was submitted", and it also means
   * "it never arrived".
   */
  async function say(text: string): Promise<void> {
    if (!text.trim()) {
      return;
    }
    // Enough of the first line to be this message and not some other text on the screen, and
    // short enough that the composer's own wrapping cannot break it across two lines.
    const probe = (firstLine(text) || text).trim().slice(0, 48);
    const pane = `"mc-${ paneId.value }"`;
    const out = await run([
      `F=/tmp/.chat-say-${ Date.now().toString(36) }`,
      'P=$F.probe',
      `echo ${ b64(text) } | base64 -d > $F`,
      `echo ${ b64(probe) } | base64 -d > $P`,
      ...paneSendScript({
        pane,
        file:   '$F',
        frag:   '$P',
        // The hook's log for this pane, named the way everything else here names it: the
        // sessions directory sits beside the pane's HOME. It is the one check that can speak
        // for a paste the CLI folded into `[Pasted text #1]`, which never shows its own text.
        events: `"$(dirname "$HOME")/sessions/${ paneId.value }.events.jsonl"`,
        buffer: 'chat',
      }),
    ].join('\n'), 30000);
    const said = out.trim().split('\n').pop() || '';

    if (said !== 'SENT') {
      throw new Error(SAY_FAILURE[said] || `the pane did not take the message${ out.trim() ? `: ${ out.trim().slice(-160) }` : '' }`);
    }
  }

  /** Start the pane detached, so a conversation opened here first has somewhere to go. */
  async function start(): Promise<void> {
    const list = shellAt.value >= 0 ? [...argv.value.slice(shellAt.value, shellAt.value + 4), 'start'] : null;

    if (!list) {
      throw new Error('this pane cannot be started from here; open the terminal view');
    }
    const pod = await locatePod();

    if (!pod) {
      throw new Error('no running pod');
    }
    await podExecOnce(pod, [...prefix.value, ...list], 30000, from.value.container, from.value.namespace);
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }

  /* ── Reading ──────────────────────────────────────────────────────────────────────────────── */

  /**
   * The page of transcript before the one being held, joined onto the front.
   *
   * A quarter of a megabyte at a time rather than the megabyte the first read takes: this one is
   * asked for by a person who is waiting for it, and four quick steps back read better than one
   * slow one. The seam between the pages - both ends of a byte-cut read land mid-line - is
   * spliceEarlier's, and tested there.
   */
  async function loadEarlier(): Promise<void> {
    if (loadingEarlier.value || atStart.value || !file.value) {
      return;
    }
    loadingEarlier.value = true;
    try {
      const nonce = frameNonce();
      const out = await run([
        `FILE=${ JSON.stringify(file.value) }; START=${ historyStart.value }; CAP=262144; N=${ JSON.stringify(nonce) }`,
        'FROM=$((START - CAP)); [ "$FROM" -lt 0 ] && FROM=0',
        'echo "@@FROM-$N $FROM"',
        'if [ -f "$FILE" ] && [ "$START" -gt "$FROM" ]; then echo "@@BACK-$N"; tail -c +$((FROM+1)) "$FILE" | head -c $((START - FROM)); echo; echo "@@ENDBACK-$N"; fi',
      ].join('\n'));
      const frame = readFrames(out, nonce);

      if (frame.back === null || frame.from === null) {
        return;
      }
      lines.value = spliceEarlier(lines.value, frame.back, frame.from);
      historyStart.value = frame.from;
      const all = lines.value.concat(remainder.value.trim() ? [remainder.value] : []);

      messages.value = parseTranscript(all);
      entries.value = parseEntries(all);
      prepended.value++;
    } catch (e: any) {
      error.value = e.message || String(e);
    } finally {
      loadingEarlier.value = false;
    }
  }

  /** Everything the transcript, the pane, the hook and the subagents say, in one round trip. */
  async function poll(): Promise<void> {
    if (!enabled.value || polling.value || (typeof document !== 'undefined' && document.hidden)) {
      return;
    }
    polling.value = true;
    try {
      const subId = view.value === 'main' ? '' : view.value;
      // The frame's nonce, fresh for this read: every marker below carries it, so nothing the
      // transcript happens to quote can close a block. See chat-frames.mjs.
      const nonce = frameNonce();
      /*
       * The script is chat-read.mjs now, not a hundred lines in the middle of this function.
       *
       * Same script, same markers, same seven values going into it - it was lifted out
       * verbatim. What it buys is a second caller: the pod can run this read over HTTP
       * instead of the browser opening a WebSocket and forking a process for it every 1.5
       * seconds, and two copies of this much shell would have been identical on the day
       * they were written and never again.
       */
      const at = {
        id:      paneId.value,
        off:     offset.value,
        sub:     subId,
        soff:    sub.value.offset,
        nonce,
        projKey: projectKey(workdir.value),
        cli:     cli.value,
        home:    paneHome.value,
      };
      const out = await readChat(at, nonce);

      const before = messages.value.length;

      absorb(out, nonce);
      // After absorb, which is what moves the transcript on: a queued message is retired by the
      // line claude has just written for it, and a picker is over once claude is writing into the
      // conversation again.
      prunePending();
      clearManager(messages.value.length > before);
      error.value = '';
      polledAt.value = new Date().toISOString();
    } catch (e: any) {
      error.value = e.message || String(e);
    } finally {
      polling.value = false;
    }
  }

  /**
   * One read, taken apart and folded in.
   *
   * The taking-apart is chat-frames.mjs; what is left here is what the view does with each piece:
   * which of them means "a different conversation, start again", which of them moves the offset,
   * and which of them is only kept when the read actually carried it.
   */
  function absorb(out: string, nonce: string): void {
    const frame = readFrames(out, nonce);
    const size = frame.size;

    if (frame.file !== file.value || size < offset.value) {
      // A different transcript (the id file appeared, or the conversation restarted): start over.
      file.value = frame.file;
      offset.value = 0;
      historyStart.value = 0;
      lines.value = [];
      remainder.value = '';
      messages.value = [];
      restarted.value++;
      if (size && frame.data !== null) {
        // The data in this answer is from OFF, which was for the old file; ask again from 0.
        return;
      }
    }

    // Where this read began is where the held history begins - but only on the read that began
    // it. Every read after that one is a delta from the end and says nothing about the front.
    if (frame.from !== null && !offset.value) {
      historyStart.value = frame.from;
    }

    if (frame.data !== null) {
      const text = remainder.value + frame.data;
      const parts = text.split('\n');

      remainder.value = parts.pop() || '';
      lines.value.push(...parts.filter((l) => l.trim()));
      const first = !messages.value.length;

      offset.value = size;
      const all = lines.value.concat(remainder.value.trim() ? [remainder.value] : []);

      messages.value = parseTranscript(all);
      entries.value = parseEntries(all);
      // The first load lands at the bottom, where the conversation is; after that, only while
      // the person is already there, so reading back is not interrupted. The host decides;
      // `restarted` is how it knows which of the two this is.
      if (first) {
        restarted.value++;
      }
      grew.value++;
    }

    if (view.value !== 'main' && frame.ssize && frame.ssize < sub.value.offset) {
      sub.value = {
        offset: 0, lines: [], remainder: '', messages: [],
      };
    } else if (view.value !== 'main' && frame.sdata !== null) {
      const text = sub.value.remainder + frame.sdata;
      const parts = text.split('\n');
      const rest = parts.pop() || '';
      const all = sub.value.lines.concat(parts.filter((l) => l.trim()));

      sub.value = {
        offset: frame.ssize, lines: all, remainder: rest, messages: parseTranscript(all.concat(rest.trim() ? [rest] : [])),
      };
      grew.value++;
    }

    if (frame.tails.length) {
      const next: Record<string, { at: number; last: string; name: string }> = {};

      for (const { id, at, name, raw } of frame.tails) {
        let last = '';

        if (cli.value === 'agy') {
          // agy's line has `content` and `tool_calls` at the top level; the reader below
          // looks inside `message.content` and finds nothing in one. See agyTailText.
          last = agyTailText(raw, (call) => toolSummary(call as ChatToolCall));
        } else {
          try {
            const entry = JSON.parse(raw);
            const blocks = Array.isArray(entry?.message?.content) ? entry.message.content : [];
            const text = blocks.filter((b: any) => b.type === 'text').map((b: any) => b.text).join(' ').trim();
            const tool = blocks.find((b: any) => b.type === 'tool_use');

            last = text || (tool ? `${ tool.name }: ${ toolSummary({ id: tool.id, name: tool.name, input: tool.input }) }` : '');
          } catch { /* a partial line; keep what we had */ }
        }
        next[id] = {
          at,
          last: (last || tails.value[id]?.last || '').split('\n')[0].slice(0, 140),
          name: name || tails.value[id]?.name || '',
        };
      }
      tails.value = next;
    }

    // undefined is "this read did not carry one", which is not the same as a state file that is
    // there and empty: the first keeps what the view had, the second clears it.
    if (frame.hook !== undefined) {
      hook.value = frame.hook;
    }

    attached.value = frame.attached;
    alive.value = frame.alive;
    paneText.value = frame.pane;
    /*
     * What the CLI is doing.
     *
     * deriveState reads claude's transcript markers and the hook's state file, and agy writes
     * neither - so every agy turn read as "idle": no busy indicator while it worked, and a
     * queued message with nothing to retire it. agy's own steps say it plainly enough (see
     * agyPhase), and they are overlaid afterwards rather than threaded through deriveState,
     * which stays claude's and untouched. Only the working/idle half is overridden: whether
     * there is a pane at all is the same question for both, and deriveState already answers it.
     */
    state.value = deriveState({
      entries: entries.value, hook: hook.value, attached: attached.value, alive: alive.value, paneText: frame.pane, now: Date.now(),
    });

    if (cli.value === 'agy') {
      const phase = agyPhase(entries.value);

      if (phase && (state.value.phase === 'idle' || state.value.phase === 'working')) {
        state.value = { ...state.value, phase };
      }
    }
    pane.value = paneFromState(state.value, frame.pane);
  }

  /**
   * Retire what a box sent once claude has recorded it anywhere - as a queued item, as a prompt,
   * or as the hook's UserPromptSubmit - and say so when it has not.
   *
   * The rule and the evidence are in chat-state.mjs, which the verifier runs against a real
   * claude; here it is only the four things to reconcile against.
   */
  function prunePending(): void {
    // Cast because chat-state.mjs is JavaScript: its `{ entries = [], … }` default makes TS
    // infer the parameter as `never[]`, so a real transcript line is not assignable to it.
    pending.value = reconcilePending(pending.value, {
      entries: entries.value, hook: hook.value, queue: state.value.queue, gone: pane.value.gone,
    } as any) as any[];
  }

  /**
   * The picker is gone: the conversation moved on, or the pane is showing something readPane
   * understands again.
   *
   * A manager writes nothing to the transcript, so a transcript that has grown is proof that
   * claude is answering in the conversation again. `idle` and `busy` are the same evidence from
   * the pane's side. Any of them is enough, and being too eager to clear this is the safe
   * direction to be wrong in: the cost is a warning that vanishes early, against one that lies.
   */
  function clearManager(moved: boolean): void {
    if (manager.value && (moved || pane.value.idle || pane.value.busy || pane.value.gone)) {
      manager.value = '';
    }
  }

  /** Main, or one subagent: a different transcript, followed from the start. */
  function show(which: string): void {
    if (which === view.value) {
      return;
    }
    view.value = which;
    sub.value = {
      offset: 0, lines: [], remainder: '', messages: [],
    };
    restarted.value++;
    poll();
  }

  /* ── Saying something ─────────────────────────────────────────────────────────────────────── */

  /**
   * Send what is in the draft.
   *
   * The one send path. Everything that puts words into this conversation - the drawer's box, the
   * Focus bar collapsed, the Focus bar open, a card's "ask the agent" button - ends here, which
   * is the point of the whole file: there is one definition of what happens between pressing
   * Enter and the message being accounted for.
   */
  async function send(): Promise<void> {
    if (!canSend.value) {
      return;
    }
    const text = draft.value.trim();

    sending.value = true;
    try {
      // The paths are in the message; the bytes may still be going. Waited for here rather than
      // at the paste, which is the whole point: an upload that finished while the sentence was
      // being typed costs nothing at all.
      if (uploads.value.length) {
        pasting.value = `Finishing ${ uploads.value.length === 1 ? 'an attachment' : `${ uploads.value.length } attachments` }`;
        await Promise.all(uploads.value);
      }
      if (!attached.value) {
        await start();
      }
      const before = paneText.value;

      await say(text);
      if (terminalOnly(text)) {
        echoTerminal(text, before);
      }
      // Typing `/mcp` by hand puts the pane into the same state the Customize menu does, so it is
      // recorded the same way rather than only when the menu was used.
      manager.value = managerIn(text) || manager.value;
      // Recorded before the poll rather than after it: the point of this is that there is never a
      // moment where the box is empty and the log does not have it.
      //
      // Not for a slash command. Those are the CLI's own: some write a local-command line to the
      // transcript (/model), some print to the terminal only (/cost) and some open a picker
      // (/mcp) - none of them is ever recorded as a prompt, so one tracked here would read "not
      // delivered" twenty seconds after doing exactly what it should.
      const isCommand = /^\//.test(text);

      pending.value = isCommand ? pending.value : [...pending.value, {
        key:      `pending-${ Date.now().toString(36) }-${ pending.value.length }`,
        role:     'user',
        text,
        tools:    [],
        thinking: '',
        images:   [],
        at:       new Date().toISOString(),
        queued:   true,
        sentAt:   Date.now(),
      }];
      draft.value = '';
      error.value = '';
    } catch (e: any) {
      error.value = e.message || String(e);
    } finally {
      sending.value = false;
      poll();
    }
  }

  /**
   * Put a prompt into this conversation from somewhere that is not the box.
   *
   * A Focus card's "ask the agent" buttons used to queue their prompt through the agent API and
   * then open a terminal drawer over the card you had asked about. They come through here now, so
   * what a card asks is accounted for exactly like something typed: it appears in the log as
   * yours, it is reconciled against the transcript, and it is in the conversation the bar is
   * already showing. See pages/Focus.vue.
   */
  async function ask(prompt: string): Promise<boolean> {
    const text = String(prompt || '').trim();

    if (!text) {
      return false;
    }
    draft.value = text;
    await send();

    return !error.value;
  }

  /** Send a message the pane never recorded, again. */
  async function resend(p: any): Promise<void> {
    pending.value = pending.value.filter((x) => x.key !== p.key);
    draft.value = p.text;
    await send();
  }

  /** A slash command, sent as typed, with the terminal's answer shown if it only answers there. */
  async function sendCommand(text: string): Promise<void> {
    draft.value = text;
    await send();
  }

  /** Put a command in the box in place of the name being typed, ready for its argument. */
  function pickCommand(command: ChatCommand): number {
    const spot = slashSpot.value || { start: 0, end: draft.value.length };
    const after = draft.value.slice(spot.end);
    const head = `${ draft.value.slice(0, spot.start) }${ command.name }`;
    const gap = after.startsWith(' ') || after.startsWith('\n') ? '' : ' ';

    draft.value = `${ head }${ gap }${ after }`;
    caret.value = head.length + gap.length;

    return caret.value;
  }

  /** Mention a file: `@path`, which claude resolves at submit the way typing it would. */
  function mention(path: string): void {
    draft.value = `${ draft.value }${ draft.value && !draft.value.endsWith(' ') ? ' ' : '' }@${ path } `;
  }

  async function choose(option: { key: string }): Promise<void> {
    try {
      await keys(option.key);
      await new Promise((resolve) => setTimeout(resolve, 250));
      await keys('Enter');
    } catch (e: any) {
      error.value = e.message || String(e);
    }
    setTimeout(() => poll(), 400);
  }

  async function submitCode(): Promise<void> {
    const text = code.value.trim();

    if (!text) {
      return;
    }
    try {
      await say(text);
      code.value = '';
    } catch (e: any) {
      error.value = e.message || String(e);
    }
  }

  /**
   * Interrupt the turn: what the Stop button asks for.
   *
   * Two Escapes and then a poll, rather than the one Escape with no read-back this used to
   * send. Both halves were reasons the button looked broken.
   *
   * One Escape is not reliable. `escapePane` below already sends two, 300ms apart, and it does
   * that because one was not enough to get out of a picker - the same input path, the same
   * pane. A lone `\e` arriving through `tmux send-keys` has to be disambiguated from the start
   * of an escape sequence, and whether it is read as a bare Escape depends on what the terminal
   * is doing when it lands. A second one costs a quarter of a second and removes the question.
   *
   * The poll is the other half. Every other key this sends - `choose`, `escapePane` - asks for
   * a read 400ms later, and this did not, so even a successful interrupt left the shimmer and
   * the Stop button on screen until the 1.5s timer came round, and longer when that tick was
   * skipped because an exec was still in flight. Staying lit after the click is the whole of
   * what "the Stop button doesn't work" looks like from the outside, whether or not the turn
   * actually stopped.
   */
  async function stop(): Promise<void> {
    try {
      await keys('Escape');
      await new Promise((resolve) => setTimeout(resolve, 250));
      await keys('Escape');
    } catch (e: any) {
      error.value = e.message || String(e);
    }
    setTimeout(() => poll(), 400);
  }

  async function login(): Promise<void> {
    try {
      await say('/login');
    } catch (e: any) {
      error.value = e.message || String(e);
    }
  }

  /** Escape, from a pane a chat cannot draw. The one way out that always exists. */
  async function escapePane(): Promise<void> {
    // Cleared optimistically: Escape is what closes a picker, and leaving the warning up until
    // the next poll agrees would be the same "says something untrue" problem in miniature.
    manager.value = '';
    try {
      await keys('Escape');
      await new Promise((resolve) => setTimeout(resolve, 300));
      await keys('Escape');
    } catch (e: any) {
      error.value = e.message || String(e);
    }
    setTimeout(() => poll(), 400);
  }

  /**
   * Read back what the terminal printed for a command that prints only there, and show it.
   *
   * These commands open a panel (Settings · Status · Config · Usage · Stats) that stays until
   * Esc. So: wait for the panel to actually be there - a busy session draws it late, and a
   * capture taken early found nothing and left the Esc hitting the prompt instead, which is how
   * the terminal came to be stuck inside the panel - then take its text, close it, and check it
   * closed. The text goes into a panel of its own rather than the log: it is the terminal's
   * answer to a question, not part of the conversation.
   */
  async function echoTerminal(command: string, before: string): Promise<void> {
    const seen = new Set(before.split('\n').map((l) => l.trim()));
    const capture = async () => {
      const after = await run(`tmux capture-pane -p -t "mc-${ paneId.value }" | tail -n 60`);

      return after.split('\n')
        .map((l) => l.replace(/[│┃]/g, ' ').trimEnd())
        .filter((l) => l.trim() && !seen.has(l.trim()) && !/^\s*❯/.test(l) && !/shift\+tab|esc to interrupt|for shortcuts|bypass permissions/i.test(l) && !/^[\s─╌═┌┐└┘╭╮╰╯▔▁]+$/.test(l));
    };
    let fresh: string[] = [];

    try {
      // Up to six seconds for the panel to draw; a panel is several new lines at once.
      for (let i = 0; i < 12 && fresh.length < 3; i++) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        fresh = await capture();
      }
      // Close it, and make sure it closed: one Esc suffices when the panel is up.
      for (let i = 0; i < 3; i++) {
        await keys('Escape');
        await new Promise((resolve) => setTimeout(resolve, 700));
        const still = await capture();

        if (still.length < 3) {
          break;
        }
      }
    } catch {
      return;
    }
    // Nothing to show, or only the shell complaining (a pod still installing its tools answers
    // "tmux: command not found"): that is an error for the status line, not a panel.
    if (!fresh.length) {
      return;
    }
    if (fresh.length <= 2 && /command not found|No such file|error/i.test(fresh.join('\n'))) {
      error.value = fresh.join(' ');

      return;
    }
    panel.value = { title: command, text: fresh.join('\n') };
  }

  /* ── What it can be set to ────────────────────────────────────────────────────────────────── */

  /**
   * What claude in this pod can be set to, asked of claude itself.
   *
   * One exec for all of it: the help, which carries every value the menus offer; the pane's own
   * argv, the environment and the two settings files, which between them decide which model is
   * actually in force and why (claude's own precedence, see currentModel).
   *
   * Read once at mount and again after a change is applied. Not polled: `claude --help` shells
   * out to the binary, and the poll that keeps the transcript current runs every 1.5 seconds.
   */
  async function readOptions(): Promise<void> {
    const script = [
      'echo @@HELP',
      'claude --help 2>/dev/null',
      'echo @@ARGV',
      "ps -eo args= 2>/dev/null | grep -m1 '^claude' || true",
      'echo @@ENV',
      'printenv ANTHROPIC_MODEL 2>/dev/null || true',
      'echo @@FILES',
      // Three lines, always all three, so a blank first line still means "settings.json sets no
      // model" rather than shifting ~/.claude.json's answer into its place.
      `node -e 'const fs=require("fs");const g=(f,k)=>{try{return String(JSON.parse(fs.readFileSync(f,"utf8"))[k]||"")}catch(e){return ""}};const s=process.env.HOME+"/.claude/settings.json";const c=process.env.HOME+"/.claude.json";console.log(g(s,"model"));console.log(g(c,"model"));console.log(g(s,"effort")||g(s,"effortLevel"))' 2>/dev/null`,
      'echo @@END',
    ].join('\n');
    const out = await run(script, 30000).catch(() => '');

    if (!out.includes('@@HELP') || !out.includes('@@END')) {
      return;
    }

    const between = (a: string, b: string) => (out.split(a)[1] || '').split(b)[0] || '';
    const help = between('@@HELP', '@@ARGV');
    const line = between('@@ARGV', '@@ENV').split('\n').map((l) => l.trim()).find((l) => l.startsWith('claude')) || '';
    const files = between('@@FILES', '@@END').split('\n');
    const found = currentModel({
      argv:     /--model[\s=]+(\S+)/.exec(line)?.[1] || '',
      env:      between('@@ENV', '@@FILES').trim(),
      settings: files[1] || '',
      config:   files[2] || '',
    });

    options.value = {
      read:        true,
      models:      modelAliases(help),
      efforts:     flagChoices(help, '--effort'),
      model:       found.model,
      modelSource: found.source,
      // Only if something recorded it. There is no flag to read the running session's effort back
      // out of, so an unset one is shown as unset rather than guessed at, and the button reads
      // "model" rather than claiming a value.
      effort:      (files[3] || '').trim(),
    };
  }

  /** The MCP servers and whether each answered, read only when the menu is opened. */
  async function readMcp(): Promise<void> {
    mcp.value = { ...mcp.value, loading: true, error: '' };

    try {
      // `mcp list` health-checks every server, which is seconds rather than milliseconds.
      const out = await run('claude mcp list 2>&1', 60000);

      mcp.value = {
        read: true, loading: false, servers: parseMcpList(out), error: '',
      };
    } catch (e: any) {
      mcp.value = {
        read: true, loading: false, servers: [], error: e.message || String(e),
      };
    }
  }

  /**
   * Change one of them, by typing claude's own command into the pane.
   *
   * Through claude rather than by writing its settings file, because claude is running: the
   * command changes the conversation that is open, and claude persists the choice itself where it
   * persists one. A settings file written underneath a live session would be read by the next one
   * and not by this one, which is the opposite of what the menu appears to promise.
   */
  async function applyOption(kind: 'model' | 'effort', value: string): Promise<void> {
    if (!isSafeOptionValue(value)) {
      error.value = `${ value } is not a value this can send`;

      return;
    }

    optionBusy.value = kind;

    try {
      if (!attached.value) {
        await start();
      }
      await say(`/${ kind } ${ value }`);
      error.value = '';
      // Optimistic, then corrected by the re-read below: claude writes the model into its
      // settings, so the answer that comes back is the real one a moment later.
      options.value = { ...options.value, [kind]: value };
      setTimeout(() => readOptions().catch(() => {}), 2500);
    } catch (e: any) {
      error.value = e.message || String(e);
    } finally {
      optionBusy.value = '';
      poll();
    }
  }

  /**
   * Open one of claude's own managers.
   *
   * `/permissions`, `/mcp`, `/memory` and the rest are full-screen pickers - keyboard-driven
   * terminal UIs, not prompts with options in them. No chat can draw one, so the caller's job
   * after this resolves is to put the person where it can be used, which is the terminal.
   */
  async function openManager(command: string): Promise<void> {
    optionBusy.value = command;

    try {
      if (!attached.value) {
        await start();
      }
      await say(`/${ command }`);
      error.value = '';
      manager.value = command;
    } catch (e: any) {
      error.value = e.message || String(e);
    } finally {
      optionBusy.value = '';
      poll();
    }
  }

  /**
   * Whether claude thinks before answering, read from and written to the pane's own
   * settings.json - the same key /config's "Thinking mode" flips. claude reads it at the start of
   * each turn, so the change applies to the next message.
   */
  async function readThinking(): Promise<void> {
    try {
      const out = await run(`node -e "const s=require(process.env.HOME+'/.claude/settings.json');console.log(s.alwaysThinkingEnabled===false?'off':'on')" 2>/dev/null || echo on`);

      thinking.value = !/off/.test(out);
    } catch {
      thinking.value = null;
    }
  }

  async function toggleThinking(): Promise<void> {
    const next = !thinking.value;

    optionBusy.value = 'thinking';
    try {
      await run(`node -e "const f=process.env.HOME+'/.claude/settings.json';const fs=require('fs');const s=JSON.parse(fs.readFileSync(f,'utf8'));s.alwaysThinkingEnabled=${ next ? 'true' : 'false' };fs.writeFileSync(f,JSON.stringify(s,null,2)+'\\n')"`);
      thinking.value = next;
    } catch (e: any) {
      error.value = e.message || String(e);
    } finally {
      optionBusy.value = '';
    }
  }

  /**
   * The commands that are files in this pod: the project's, the user's, and the skills.
   *
   * `.claude/commands/<name>.md` is a command called `/<name>`; a directory under it is a
   * namespace, which claude spells `/<dir>:<name>`. A skill is invoked the same way by its
   * directory name. Read once, at mount, because these change when somebody edits the tree and
   * not while a message is being typed.
   */
  async function readCommands(): Promise<void> {
    /*
     * claude's layout, so claude's panes only.
     *
     * `.claude/commands` and `.claude/skills` are claude's directories and claude's spelling of
     * what is in them. agy has commands of its own that are files too - it has a `/skills` - but
     * where it keeps them has not been established, and offering an Antigravity pane a list of
     * claude's project commands would be offering it things it will refuse by name. So an agy
     * pane gets its built-ins and nothing invented; finding agy's own is the next thing here.
     */
    if (cli.value === 'agy') {
      custom.value = [];

      return;
    }

    const script = [
      'cd "$(dirname "$HOME")" 2>/dev/null || cd /',
      'for root in "$HOME/.claude" ".claude" "$PWD/.claude"; do',
      '  [ -d "$root/commands" ] && find "$root/commands" -name "*.md" -maxdepth 2 2>/dev/null | sed "s|^|CMD |"',
      '  [ -d "$root/skills" ] && find "$root/skills" -maxdepth 2 -name SKILL.md 2>/dev/null | sed "s|^|SKILL |"',
      'done',
    ].join('\n');
    const out = await run(script, 15000).catch(() => '');
    const seen = new Set<string>();
    const found: ChatCommand[] = [];

    for (const line of String(out).split('\n')) {
      const cmd = /^CMD (.*\/commands\/(.*)\.md)\s*$/.exec(line);
      const skill = /^SKILL .*\/skills\/([^/]+)\/SKILL\.md\s*$/.exec(line);
      const name = cmd ? `/${ cmd[2].replace(/\//g, ':') }` : (skill ? `/${ skill[1] }` : '');

      if (!name || seen.has(name)) {
        continue;
      }
      seen.add(name);
      found.push({
        name, help: cmd ? 'this pod’s own command' : 'skill', source: cmd ? 'command' : 'skill', path: (cmd ? cmd[1] : line.replace(/^SKILL /, '')).trim(),
      });
    }

    custom.value = found.sort((a, b) => a.name.localeCompare(b.name));
  }

  /** What a skill or command does, from the first lines of its file. Cached by the caller. */
  async function readAbout(command: ChatCommand): Promise<string> {
    if (!command.path) {
      return '';
    }
    const about = await run(`sed -n '1,40p' ${ JSON.stringify(command.path) } 2>/dev/null`, 10000).catch(() => '');

    return (/^description:\s*(.+)$/m.exec(String(about))?.[1]
      || String(about).split('\n').map((l) => l.trim()).find((l) => l && !/^(---|#|name:|allowed-tools:)/.test(l))
      || 'No description in the file.').trim();
  }

  /** The checkout's files: what git tracks plus what it has not been told to ignore. */
  async function readFiles(): Promise<string[]> {
    const out = await run(`cd ${ JSON.stringify(workdir.value) } && (git ls-files --cached --others --exclude-standard 2>/dev/null || find . -type f -not -path '*/node_modules/*' -not -path '*/.git/*' | sed 's|^./||') | head -n 4000`, 30000);

    return out.split('\n').map((l) => l.trim()).filter(Boolean);
  }

  /* ── Files a message names ────────────────────────────────────────────────────────────────── */

  /**
   * Where the files a message names live: the pod the pane runs in. For a pane in another pod
   * (kubectl prefix) that pod is looked up by the label its Deployment gives it; the viewer and
   * the thumbnails then read it directly, with the same session that reads this one.
   */
  async function mediaTarget(): Promise<PodTarget | null> {
    if (media.value) {
      return media.value;
    }
    const pod = await locatePod();

    if (!pod) {
      return null;
    }
    if (prefix.value.length) {
      // The last `-n` and `-c`: kubectl's own. The wrapper before it is a `sh -c` of its own.
      const ns = prefix.value[prefix.value.lastIndexOf('-n') + 1];
      const container = prefix.value[prefix.value.lastIndexOf('-c') + 1] || 'workspace';
      const k = prefix.value.findIndex((a) => a === 'kubectl');
      const list = [...prefix.value.slice(0, k + 1), 'get', 'pods', '-n', ns, '-l', `app=${ ns }`, '--field-selector=status.phase=Running', '-o', 'jsonpath={.items[0].metadata.name}'];
      const name = (await podExecOnce(pod, list, 15000, from.value.container, from.value.namespace)).trim();

      if (!name) {
        return null;
      }
      media.value = {
        pod: name, container, namespace: ns, home: paneHome.value,
      };
    } else {
      media.value = {
        pod, container: from.value.container, namespace: from.value.namespace, home: paneHome.value,
      };
    }

    return media.value;
  }

  /** A thumbnail for one path: a data URL, 'missing', or 'large'. Cached, so a repeat is free. */
  async function thumbFor(path: string): Promise<string> {
    const cached = thumbs.value[path];

    if (cached) {
      return cached;
    }
    let data = 'missing';

    try {
      const target = await mediaTarget();
      const stat = target ? await statPodPath(target, path) : { kind: 'none', size: 0 };

      if (stat.kind === 'file' && (stat as any).size > 0 && (stat as any).size <= THUMB_MAX) {
        const ext = (path.split('.').pop() || '').toLowerCase();

        data = `data:${ MIME[ext] || 'image/png' };base64,${ await readPodFileBase64(target as PodTarget, path) }`;
      } else if (stat.kind === 'file') {
        data = 'large';
      }
    } catch { /* missing it is */ }
    thumbs.value = { ...thumbs.value, [path]: data };

    return data;
  }

  /** Whether a path a message names is still there, for the host that is about to open it. */
  async function pathExists(path: string): Promise<boolean> {
    const target = await mediaTarget();
    const stat = target ? await statPodPath(target, path) : { kind: 'none' };

    return stat.kind !== 'none';
  }

  /* ── Attachments ──────────────────────────────────────────────────────────────────────────── */

  /**
   * A screenshot as a JPEG when it is big: every chunk of it is an exec, and a 2 MB PNG of a
   * dashboard is two hundred of them. The model reads a JPEG just as well.
   */
  async function shrink(blob: File, converting: boolean): Promise<{ bytes: Uint8Array; extension: string }> {
    const original = new Uint8Array(await blob.arrayBuffer());
    const extension = (blob.type.split('/')[1] || 'png').replace(/[^a-z0-9]/g, '');

    // Whether to convert is the caller's decision now, not this one's: the caller has already
    // named the file, and a function that decided the format after the name was chosen is a
    // function that could rename it underneath somebody's message.
    if (!converting) {
      return { bytes: original, extension };
    }
    try {
      const bitmap = await createImageBitmap(blob);
      const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement('canvas');

      canvas.width = Math.round(bitmap.width * scale);
      canvas.height = Math.round(bitmap.height * scale);
      canvas.getContext('2d')?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const jpeg = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85));

      if (jpeg && jpeg.size < original.length) {
        return { bytes: new Uint8Array(await jpeg.arrayBuffer()), extension: 'jpg' };
      }
    } catch { /* keep the original */ }

    return { bytes: original, extension };
  }

  /**
   * Attach an image: the path goes in the box now, the bytes go to the pod behind it.
   *
   * The path is decided here rather than after the upload, which is what makes this possible -
   * it is a timestamp and an extension, both known the moment the file arrives. So pasting a
   * screenshot puts `/workspace/.images/2026-…png ` in the box immediately and you carry on
   * typing the sentence around it; a 2MB screenshot is two hundred execs and there is no reason
   * to watch them.
   *
   * The upload is registered in `uploads`, and `send()` waits on those and only those - so the
   * wait happens once, at the point it actually matters, and only if the upload has not finished
   * by then. It usually has, because typing the rest of the message takes longer.
   */
  function attachImage(blob: File | null): Promise<void> {
    if (!blob) {
      return Promise.resolve();
    }

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const original = (blob.type.split('/')[1] || 'png').replace(/[^a-z0-9]/g, '');
    // Naming the file before the bytes have been read means predicting what shrink will do with
    // them, so the decision moves here and shrink is told rather than asked. Only the rare
    // failure below can make this wrong, and it repairs itself.
    const converting = blob.size >= 150_000 && typeof createImageBitmap === 'function';
    let path = `${ from.value.imageDir || '/workspace/.images' }/${ stamp }.${ converting ? 'jpg' : original }`;

    // In the box before a byte has moved.
    draft.value = `${ draft.value }${ draft.value && !draft.value.endsWith(' ') ? ' ' : '' }${ path } `;

    const upload: Promise<void> = (async() => {
      try {
        const { bytes, extension } = await shrink(blob, converting);

        // The conversion was meant to happen and could not - a decoder that threw, or a JPEG
        // that came out bigger than the PNG. The name is already in somebody's message, so the
        // name is what moves: the file is written under its true extension and the text is
        // corrected in place.
        if (extension !== path.split('.').pop()) {
          const corrected = path.replace(/\.[^.]+$/, `.${ extension }`);

          draft.value = draft.value.split(path).join(corrected);
          path = corrected;
        }
        let binary = '';

        for (let i = 0; i < bytes.length; i += 8192) {
          binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
        }
        const encoded = btoa(binary);

        await run(`mkdir -p "$(dirname '${ path }')" && : > '${ path }.b64'`);
        for (let i = 0; i < encoded.length; i += CHUNK) {
          pasting.value = `Attaching the image (${ Math.round((i / encoded.length) * 100) }%)`;
          await run(`printf %s '${ encoded.slice(i, i + CHUNK) }' >> '${ path }.b64'`);
        }
        const out = await run(`base64 -d '${ path }.b64' > '${ path }' && rm -f '${ path }.b64' && wc -c < '${ path }'`);

        if (!parseInt(out.trim(), 10)) {
          throw new Error(`the image did not land in ${ from.value.label || 'the agent' }`);
        }
      } catch (e: any) {
        // Said, and not silently: the path is already in the message, so a failure here is a
        // message about to be sent that names a file which is not there.
        error.value = `${ path } could not be attached: ${ e.message || e }`;
      } finally {
        uploads.value = uploads.value.filter((u) => u !== upload);
        if (!uploads.value.length) {
          pasting.value = '';
        }
      }
    })();

    uploads.value = [...uploads.value, upload];

    return upload;
  }

  /* ── Lifecycle ────────────────────────────────────────────────────────────────────────────── */

  // Written on every change rather than at the point of sending: a message is also removed when
  // the transcript catches up with it, and a store that only ever grew would resurrect retired
  // messages on the next visit.
  watch(pending, (list) => writePending(paneId.value, list), { deep: true });

  /**
   * The conversation changed under us: a different pane id is a different transcript, a different
   * queue and a different set of pending messages, and carrying any of them across would show one
   * conversation's words inside another. The Focus bar does exactly this when a card with a
   * workspace is asked about.
   */
  watch(paneId, (now, before) => {
    if (now === before) {
      return;
    }
    messages.value = [];
    lines.value = [];
    remainder.value = '';
    offset.value = 0;
    file.value = '';
    entries.value = [];
    hook.value = null;
    paneText.value = '';
    tails.value = {};
    view.value = 'main';
    sub.value = {
      offset: 0, lines: [], remainder: '', messages: [],
    };
    pending.value = readPending(now);
    options.value = {
      read: false, models: [], efforts: [], model: '', modelSource: '', effort: '',
    };
    media.value = null;
    error.value = '';
    restarted.value++;
    if (enabled.value) {
      poll();
      readCommands();
      readOptions();
      readThinking();
    }
  });

  /**
   * Reading starts when the host says it may, not at mount.
   *
   * The Focus bar is on the page from the moment it loads and the conversation behind it is not
   * made until somebody opens or asks something, so a poll on mount would be an exec every 1.5
   * seconds into a pane that does not exist. `immediate` so a host that is enabled from the start
   * - every chat in the drawer - behaves exactly as it did when this was `mounted()`.
   */
  watch(enabled, (on) => {
    if (!on) {
      return;
    }
    poll();
    readCommands();
    readOptions();
    readThinking();
  }, { immediate: true });

  onMounted(() => {
    timer = setInterval(() => poll(), POLL_MS);
  });

  onBeforeUnmount(() => {
    if (timer) {
      clearInterval(timer);
    }
  });

  return {
    // Where
    argv,
    shellAt,
    paneId,
    workdir,
    paneHome,
    prefix,
    enabled,
    // What it is
    messages,
    entries,
    hook,
    file,
    state,
    pane,
    paneText,
    paneTail,
    attached,
    alive,
    polledAt,
    error,
    turns,
    view,
    agents,
    agentRows,
    workingAgents,
    grew,
    restarted,
    atStart,
    loadingEarlier,
    prepended,
    // What is on its way
    draft,
    draftMarked,
    caret,
    sending,
    canSend,
    working,
    pasting,
    pending,
    code,
    panel,
    manager,
    takenOver,
    uploads,
    // What it can be set to
    options,
    mcp,
    thinking,
    optionBusy,
    commands,
    custom,
    slashSpot,
    slashMatches,
    media,
    thumbs,
    // Doing
    run,
    keys,
    say,
    poll,
    loadEarlier,
    start,
    show,
    send,
    ask,
    resend,
    sendCommand,
    pickCommand,
    mention,
    choose,
    submitCode,
    stop,
    login,
    escapePane,
    applyOption,
    openManager,
    readOptions,
    readMcp,
    readCommands,
    readThinking,
    toggleThinking,
    readAbout,
    readFiles,
    mediaTarget,
    thumbFor,
    pathExists,
    attachImage,
    when,
    firstLine,
  };
}
