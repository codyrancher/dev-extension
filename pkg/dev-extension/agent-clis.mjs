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
