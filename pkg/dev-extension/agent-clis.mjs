/**
 * The agent CLIs a conversation can be held with, and how to read what each one wrote.
 *
 * Everything in the chat view - the turns, the tool calls, the state dot, the deck's cards - is
 * built on one shape: ChatMessage, out of parseTranscript. That shape is not claude's; it is
 * ours. What IS claude's is the file it comes from: JSONL whose lines are `{type: 'user' |
 * 'assistant', message: {content}}`. So supporting a second CLI starts here, with the one place
 * that knows a vendor's file format, rather than in the twenty places that read a conversation.
 *
 * Antigravity (`agy`, Google's replacement for gemini-cli) writes a transcript too, and a
 * different one: one directory per conversation rather than per project, and one *step* per line
 * instead of one message -
 *
 *   ~/.gemini/antigravity-cli/brain/<conversation-uuid>/.system_generated/logs/transcript.jsonl
 *   {"step_index":3,"source":"MODEL","type":"PLANNER_RESPONSE","status":"DONE",
 *    "created_at":"...","content":"...","tool_calls":[{"name":"run_command","args":{...}}]}
 *
 * - which is read here into the same ChatMessage shape, so the view does not learn a second
 * vocabulary. The differences that matter and cannot be papered over:
 *
 *   - a tool call has no id, so a result cannot be matched to its call. agy records the result
 *     as the next MODEL step's text rather than as a block pointing back at the call, so calls
 *     are listed with their arguments and no `result`, and the view draws them that way.
 *   - `status: 'RUNNING'` is a step still happening, which claude's transcript has no equivalent
 *     of: it writes the line when the turn is over.
 *
 * Which reader to use is decided by looking at a line, not by configuration: a conversation knows
 * what wrote it, and a pane that changed CLI mid-life would otherwise be read with the wrong one.
 *
 * Plain JavaScript and no imports, so `node --test` loads it directly - see
 * tests/agent-clis.test.mjs.
 *
 * What is NOT here, deliberately. A registry of CLIs - binaries, labels, where each keeps its
 * record - because nothing starts a pane with a chosen CLI yet: that lives in the seed's
 * shell.sh, which ships from a generated file and is a change of a different kind to this one.
 * A table nothing reads is a table that is wrong by the time something does; the two paths above
 * are the whole of what it would say today, and they are written where they are used.
 */

/**
 * What a new conversation can be held with, in the order the split button offers them: the
 * first is what the plain press does.
 *
 * Here rather than in a component because three places need it - the drawer's tab row, a
 * workspace's conversation list and Settings - and a list of CLIs that differs between them is
 * the same bug as two steppers. It lived in Settings once, as exactly that kind of copy.
 *
 * `icon` is one of Rancher's own glyph names, because the split button's menu is one row per
 * choice: an icon and a name, read at a glance by somebody who already knows which one they
 * want. `what` is the longer sentence for the places that have room for it - Settings, and the
 * row's own tooltip - and is deliberately not drawn in the menu, which was three lines tall per
 * choice and read like documentation at the moment of a one-click decision.
 */
export const CLI_CHOICES = [
  {
    id: 'claude', label: 'Claude Code', icon: 'icon-ai', what: 'The default. Hooks, the queue and the state dot all understand it.',
  },
  {
    // Google's, so Rancher's own Gemini glyph says whose it is in the one row the menu gives it.
    id: 'agy', label: 'Antigravity', icon: 'icon-gemini', what: "Google's agy. Its transcript is read and resumed; its pane is not watched for questions yet.",
  },
];

/**
 * Which CLI wrote these lines: 'claude', 'agy', or '' when nothing says.
 *
 * Decided on the first line that parses and is recognisable, rather than on the first line at
 * all: a transcript read from a byte offset starts with half a line, and a file whose first
 * lines are a summary or a system banner should not be undecidable because of them.
 */
export function transcriptKind(lines) {
  for (const line of lines || []) {
    let entry;

    try {
      entry = JSON.parse(String(line));
    } catch {
      continue;
    }
    if (!entry || typeof entry !== 'object') {
      continue;
    }
    // agy: a step, numbered and sourced. Checked first because its lines also carry a `type`.
    if (typeof entry.step_index === 'number' && typeof entry.source === 'string') {
      return 'agy';
    }
    if ((entry.type === 'user' || entry.type === 'assistant') && entry.message) {
      return 'claude';
    }
  }

  return '';
}

/** agy's step sources, as roles. SYSTEM is the CLI's own banner and is not part of the talk. */
function roleOfStep(entry) {
  if (entry.source === 'USER_EXPLICIT' || entry.type === 'USER_INPUT') {
    return 'user';
  }

  return entry.source === 'MODEL' ? 'assistant' : '';
}

/**
 * agy's transcript as ChatMessages.
 *
 * One message per step rather than per turn: a step is already the unit agy writes and the unit
 * it numbers, and merging them would mean guessing where its turns begin - which is exactly the
 * kind of guess that reads fine until the day it does not.
 */
export function parseAgyTranscript(lines) {
  const messages = [];

  for (const line of lines || []) {
    let entry;

    try {
      entry = JSON.parse(String(line));
    } catch {
      continue;
    }
    const role = entry && roleOfStep(entry);

    if (!role) {
      continue;
    }
    const text = typeof entry.content === 'string' ? entry.content : '';
    const tools = (Array.isArray(entry.tool_calls) ? entry.tool_calls : []).map((call, i) => ({
      // agy gives a call no id of its own, so one is made from where it is: stable for as long
      // as the step is, which is what a key has to be.
      id:    `${ entry.step_index }-${ i }`,
      name:  String(call?.name || ''),
      input: call?.args ?? {},
    }));

    if (!text && !tools.length) {
      continue;
    }
    messages.push({
      key:      `agy-${ entry.step_index }`,
      role,
      text,
      tools,
      thinking: '',
      images:   [],
      at:       entry.created_at || '',
      // Nothing in claude's transcript means this, and the view can use it to say so: the step
      // is happening as you read it.
      running:  entry.status === 'RUNNING',
    });
  }

  return messages;
}

/**
 * Antigravity's slash commands, as agy 1.4.3 itself lists them.
 *
 * Read out of the CLI rather than written from documentation: `agy` was started in a scratch
 * directory, `/` typed, and its own picker paged through - which is also why the help text is
 * agy's wording and not a paraphrase of it. `agy --help` does not list them, and the binary's
 * strings are mostly noise, so the picker is the only authority there is.
 *
 * The chat offers these for exactly the reason it offers claude's: a command menu that shows the
 * wrong CLI's commands is worse than no menu, because every one of them is a message the pane
 * will answer with "unknown command". Aliases are kept in the name the way agy prints them -
 * `/clear (new)` - because that is what somebody reading the menu is matching against.
 *
 * Stale is a hint going wrong, never a message blocked: an unrecognised command is reported as
 * "not one I know of" and still sent, the same rule BUILTIN_COMMANDS lives under.
 */
export const AGY_COMMANDS = [
  ['/add-dir', 'Add a directory to the workspace'],
  ['/agents', 'List available custom agents'],
  ['/agy-customizations', 'Guide and reference for customising Antigravity'],
  ['/antigravity-guide', 'Comprehensive guide and quick reference'],
  ['/artifact', 'View and review artifacts'],
  ['/boost', 'Invoke the Boost multi-agent orchestrator for complex work'],
  ['/browser', 'Invoke a browser agent for web tasks'],
  ['/btw', 'Ask a side question without interrupting the current turn'],
  ['/changelog', 'Show release notes and changes'],
  ['/clear (new)', 'Clear conversation and start a new one'],
  ['/codesearch (cs)', 'Search code in the workspace'],
  ['/compact', 'Compact the conversation now'],
  ['/config (settings)', 'Open settings panel'],
  ['/context', 'Visualize current context usage'],
  ['/copy', 'Copy the last planner response'],
  ['/credits', 'Show remaining G1 credits and purchase link'],
  ['/diff', 'View uncommitted changes and per-turn diffs'],
  ['/effort', 'Set the reasoning effort'],
  ['/exit (quit)', 'Exit the CLI'],
  ['/feedback', 'Submit qualitative feedback to improve the agent'],
  ['/fork (branch)', 'Create a branch of the current conversation at this point'],
  ['/goal', 'Run until the specified goal is completely finished'],
  ['/grill-me', 'Interview me to align on a plan'],
  ['/help', 'Show available commands and keybindings'],
  ['/hooks', 'Manage hook configurations for tool events'],
  ['/keybindings', 'Set custom keybindings'],
  ['/learn', 'Reflect on recent successes or corrections'],
  ['/logout', 'Log out'],
  ['/mcp', 'Manage MCP servers'],
  ['/model', 'Set a model, or run a single prompt on another model'],
  ['/open', 'Open a file or view opened/edited files'],
  ['/permissions', 'Manage tool permissions'],
  ['/plan', 'Plan carefully before executing a task'],
  ['/plugin', 'Manage, discover and install plugins'],
  ['/remote-control', 'Turn on remote control for this session'],
  ['/rename', 'Rename the current conversation'],
  ['/resume (switch)', 'Browse and resume past conversations'],
  ['/rewind (undo)', 'Rewind conversation to a previous message'],
  ['/schedule', 'Run an instruction on a schedule'],
  ['/skills', 'List available skills'],
  ['/statusline', 'Toggle the statusline'],
  ['/tasks', 'View background tasks'],
  ['/teamwork', 'Invoke a team of agents for large work'],
  ['/title', 'Toggle custom terminal window title'],
  ['/usage (quota)', 'View model quota usage'],
  ['/voice (record)', 'Dictate a prompt using your microphone'],
];

/**
 * The pickers a chat can open for one CLI: a slash command whose dialog the pane draws and the
 * chat hands over to the terminal for. claude's are its own (`/mcp`, `/permissions`, ...); agy's
 * are the ones with a panel behind them rather than an answer.
 */
export const AGY_CUSTOMIZE = [
  { command: 'config', help: 'settings' },
  { command: 'permissions', help: 'tool permissions' },
  { command: 'hooks', help: 'hooks for tool events' },
  { command: 'mcp', help: 'MCP servers' },
  { command: 'plugin', help: 'plugins' },
  { command: 'keybindings', help: 'keybindings' },
];
