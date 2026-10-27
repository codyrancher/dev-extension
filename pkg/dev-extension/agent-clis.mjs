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
/**
 * Each provider's own mark, drawn rather than approximated.
 *
 * The paths are the official ones from Simple Icons (CC0 as a set; the marks themselves are the
 * providers' trademarks, used here to say which provider a conversation is with, which is what
 * they are for). 24x24, single path, `currentColor` - so a mark takes the colour of the row it
 * is in and dims with it, the same as the glyph it replaces.
 *
 * Antigravity has no mark of its own in any icon set, and its site renders its logo in script
 * rather than serving an SVG, so it carries Google's Gemini mark: that is the model it runs -
 * its own status line reads "Gemini 4 Argon" - and it is the right family at a glance. If
 * Antigravity publishes its own, this is the one line to change.
 */
const MARKS = {
  claude: { label: 'Claude', path: 'm4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z' },
  gemini: { label: 'Gemini', path: 'M11.04 19.32Q12 21.51 12 24q0-2.49.93-4.68.96-2.19 2.58-3.81t3.81-2.55Q21.51 12 24 12q-2.49 0-4.68-.93a12.3 12.3 0 0 1-3.81-2.58 12.3 12.3 0 0 1-2.58-3.81Q12 2.49 12 0q0 2.49-.96 4.68-.93 2.19-2.55 3.81a12.3 12.3 0 0 1-3.81 2.58Q2.49 12 0 12q2.49 0 4.68.96 2.19.93 3.81 2.55t2.55 3.81' },
};

export const CLI_CHOICES = [
  {
    id: 'claude', label: 'Claude Code', icon: 'icon-ai', mark: MARKS.claude, what: 'The default. Hooks, the queue and the state dot all understand it.',
  },
  {
    id: 'agy', label: 'Antigravity', icon: 'icon-gemini', mark: MARKS.gemini, what: "Google's agy. Its transcript is read and resumed; its pane is not watched for questions yet.",
  },
];

/** A CLI's mark by id, for the places that have the id and not the choice. */
export function cliMark(id) {
  return (CLI_CHOICES.find((choice) => choice.id === id) || {}).mark || null;
}

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

/**
 * What the person actually typed, out of the envelope agy records it in.
 *
 * agy does not store a user turn as the words somebody wrote. It stores the prompt it sent the
 * model, which wraps those words in `<USER_REQUEST>` and appends an `<ADDITIONAL_METADATA>`
 * block of its own - the local time, and whatever else it wants the model to know. Drawn
 * literally, a chat showing "Say hello" in the terminal shows seven lines of XML in the view.
 *
 * It also breaks the matching of a message somebody has just sent: the view holds a sent message
 * as pending until the transcript shows it, and compares the text to do that, so an envelope
 * meant every message stayed marked "no record of this" for ever, with a `send again` beside it.
 *
 * Anything outside the envelope is kept as it is: a transcript written by a version that does
 * not wrap, or a turn agy records some other way, must not come out empty.
 */
export function agyUserText(content) {
  const wrapped = /<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/.exec(content);

  if (wrapped) {
    return wrapped[1];
  }

  // No envelope, but possibly the metadata block on its own, which is agy's and not the
  // person's.
  return content.replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>\s*/g, '').trim();
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
  /** The call still waiting for its answer, so a result step can be folded into it. */
  let pending = null;

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

    /*
     * What a tool said, which is not something the model said.
     *
     * agy writes a turn as a pair of steps: a `PLANNER_RESPONSE` carrying the `tool_calls` and
     * no content, then a `GENERIC` carrying the result and no calls. Both are `source: MODEL`,
     * so the second was being pushed as an assistant message - which is why an Antigravity
     * conversation opened with a wall of
     *
     *     Created At: 2026-10-27T12:55:52Z
     *     Completed At: 2026-10-27T12:55:53Z
     *     Command exited with code 0.
     *     Command output: ...
     *
     * attributed to the agent, one blurb per command it ran before it said anything.
     *
     * Folded into the call it answers instead, where claude's `tool_result` blocks already go,
     * so it reads as a RUN row you can open rather than as the agent talking. Matched on there
     * being a call waiting rather than on the type name alone: `GENERIC` is vague enough that
     * something else may wear it one day, and anything with no call to answer is still shown.
     */
    if (role === 'assistant' && pending && !(entry.tool_calls || []).length && typeof entry.content === 'string' && entry.content) {
      pending.result = entry.content;
      // agy puts the exit status in the envelope; anything but 0 is the tool having failed,
      // which is the one thing a collapsed row should be able to say without being opened.
      pending.resultIsError = /Command exited with code (?!0\b)\d+/.test(entry.content);
      // A tool that is still running means the turn is still going, and the step carrying the
      // answer is the only one that knows: the message holding the call was written before the
      // command started and has said DONE ever since.
      if (entry.status === 'RUNNING' && messages.length) {
        messages[messages.length - 1].running = true;
      }
      pending = null;
      continue;
    }
    const raw = typeof entry.content === 'string' ? entry.content : '';
    const text = role === 'user' ? agyUserText(raw) : raw;
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
    // The last call of this step is what the next step answers.
    pending = tools.length ? tools[tools.length - 1] : null;
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

/**
 * Whether agy is mid-turn, from the transcript alone.
 *
 * claude says what it is doing through a hook that writes a state file on every event; agy has
 * no hook, so a chat watching an agy pane had nothing to go on and sat on "idle" through every
 * turn - no busy indicator, and a queued message with nothing to retire it.
 *
 * Its transcript is enough. agy writes a step when it starts one and marks it `RUNNING` until
 * it is `DONE`, so a trailing RUNNING step is a turn in progress; and a user step with no model
 * step after it is a turn that has been asked for and not yet begun, which is the same thing as
 * far as somebody waiting is concerned. Anything else is idle.
 *
 * Returns '' when there is nothing to say, so a caller can leave whatever it already decided.
 */
export function agyPhase(entries) {
  const steps = (entries || []).filter((entry) => entry && (entry.source || entry.type));

  if (!steps.length) {
    return '';
  }
  const last = steps[steps.length - 1];

  if (String(last.status || '').toUpperCase() === 'RUNNING') {
    return 'working';
  }
  // A question asked and not yet answered: the model's reply is a step of its own, so until one
  // arrives after the person's, the turn is still agy's.
  if (last.source === 'USER_EXPLICIT' || last.type === 'USER_INPUT') {
    return 'working';
  }

  return 'idle';
}
