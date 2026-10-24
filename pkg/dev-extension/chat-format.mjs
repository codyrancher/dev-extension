// The one shape the chat view knows, and the layer each CLI's transcript is translated into.
//
// Two CLIs hold conversations here now and a third is a matter of time. Each writes its own
// transcript in its own vocabulary, and until this existed the view read those vocabularies
// directly: `chat.ts` understood claude's tool names, `agent-clis.mjs` produced something
// structurally similar for agy, and the parts of the view that switched on a name - the badge, the
// one-line summary - only ever knew claude's. What that looked like is a row reading `RUN_COMMAND`
// with the whole shell command spilled beside it, next to claude's `BASH` with a sentence, in the
// same transcript.
//
// So the vocabulary is here, once, and every adapter ends by passing through it. A CLI that names
// its tools differently is a line in TOOL_KINDS; it is not a second switch statement in the view.
//
// WHAT IS CANONICAL. A tool call's `kind` - what it DID, in a dozen words the product owns - and
// a `summary`, the one line a person reads without opening it. Not its name, which is the CLI's
// business, and not its arguments, which are kept exactly as they arrived so the detail pane can
// show what was really sent.
//
// Plain JavaScript and no imports, so `node --test` loads it directly - see
// tests/chat-format.test.mjs, which checks the mapping against the tool names and argument keys
// both CLIs actually emit (read off a real transcript of each rather than imagined).

/**
 * What a tool call did. The whole vocabulary: a kind that is not here is `other`, which draws a
 * plain badge and the first string it can find, which is what every unknown tool got before.
 */
export const TOOL_KINDS = ['run', 'read', 'write', 'edit', 'search', 'find', 'agent', 'skill', 'ask', 'plan', 'wait', 'other'];

/**
 * Each CLI's name for each kind, lowercased because the two disagree about case and nothing
 * should turn on that: claude writes `Bash` and `AskUserQuestion`, agy writes `run_command` and
 * `read_file`.
 */
const KIND_BY_NAME = {
  // claude
  bash: 'run',
  read: 'read',
  write: 'write',
  edit: 'edit',
  multiedit: 'edit',
  grep: 'search',
  glob: 'find',
  agent: 'agent',
  task: 'agent',
  skill: 'skill',
  askuserquestion: 'ask',
  exitplanmode: 'ask',
  todowrite: 'plan',
  // agy (antigravity)
  run_command: 'run',
  read_file: 'read',
  write_file: 'write',
  edit_file: 'edit',
  manage_task: 'plan',
  schedule: 'wait',
};

/** The badge, one word per kind, so the same act reads the same whichever CLI did it. */
export const KIND_LABEL = {
  run:    'RUN',
  read:   'READ',
  write:  'WRITE',
  edit:   'EDIT',
  search: 'SEARCH',
  find:   'FIND',
  agent:  'AGENT',
  skill:  'SKILL',
  ask:    'ASK',
  plan:   'PLAN',
  wait:   'WAIT',
  other:  'TOOL',
};

/** What a tool name means here. */
export function toolKind(name) {
  return KIND_BY_NAME[String(name || '').trim().toLowerCase()] || 'other';
}

/**
 * One argument, as a plain value.
 *
 * agy encodes every argument as JSON *inside* a JSON string - `{"Path": "\"/workspace/x\""}`, and
 * `{"EndLine": "600"}` for a number - so reading `args.Path` straight gives a path wrapped in
 * quotation marks, which is what a summary then prints. claude's are already plain. Unwrapping
 * what parses and leaving alone what does not handles both without either adapter having to say
 * which it is.
 */
export function plain(value) {
  if (typeof value !== 'string') {
    return value;
  }
  const trimmed = value.trim();

  if (!(trimmed.startsWith('"') && trimmed.endsWith('"')) && !/^-?\d+(\.\d+)?$/.test(trimmed)) {
    return value;
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

/** The first of these keys the input actually has, as a plain value. */
function first(input, keys) {
  for (const key of keys) {
    if (input[key] !== undefined && input[key] !== null && input[key] !== '') {
      return plain(input[key]);
    }
  }

  return '';
}

/**
 * The line beside the badge: what this call was about, in one glance.
 *
 * Read by KIND and not by name, which is the point of the kind - `run` asks for the description
 * the CLI wrote and falls back to the command, whether that description arrived as claude's
 * `description` or agy's `toolSummary`, and whether the command is `command` or `CommandLine`.
 */
export function toolSummary(kind, input = {}) {
  const at = (input && typeof input === 'object') ? input : {};

  switch (kind) {
  case 'run':
    return String(first(at, ['description', 'toolSummary', 'command', 'CommandLine'])).slice(0, 140);
  case 'read':
  case 'write':
    return String(first(at, ['file_path', 'Path', 'path']));
  case 'edit': {
    const path = String(first(at, ['file_path', 'Path', 'path']));
    const target = String(first(at, ['Target', 'old_string']));

    return target ? `${ path } · ${ target.replace(/\s+/g, ' ').slice(0, 60) }` : path;
  }
  case 'search': {
    const pattern = String(first(at, ['pattern', 'Query', 'query']));
    const where = String(first(at, ['path', 'Path']));

    return `${ pattern }${ where ? ` in ${ where }` : '' }`;
  }
  case 'find':
    return String(first(at, ['pattern', 'Pattern', 'glob']));
  case 'agent':
    return String(first(at, ['description', 'prompt', 'Prompt'])).slice(0, 140);
  case 'skill':
    return String(first(at, ['skill', 'Skill']));
  case 'ask':
    return 'asked a question';
  case 'plan': {
    const action = String(first(at, ['Action', 'action']));

    return action ? `the plan · ${ action }` : 'updated the plan';
  }
  case 'wait': {
    const seconds = first(at, ['DurationSeconds', 'delaySeconds']);
    const why = String(first(at, ['Prompt', 'reason'])).slice(0, 100);

    return `${ seconds ? `${ seconds }s` : 'waiting' }${ why ? ` · ${ why }` : '' }`;
  }
  default: {
    const anything = Object.values(at).map(plain).find((v) => typeof v === 'string' && v);

    return String(anything || '').slice(0, 140);
  }
  }
}

/**
 * One tool call in the canonical shape: what it did, what to call it, what to say about it.
 *
 * `name` is kept as the CLI wrote it - the detail pane shows it, and a bug report wants the real
 * name - and `label` is what the badge draws.
 */
export function canonicalTool(call) {
  const kind = toolKind(call?.name);

  return {
    ...call,
    kind,
    label:   KIND_LABEL[kind] || KIND_LABEL.other,
    summary: toolSummary(kind, call?.input),
  };
}

/** Every tool call of every message, canonical. The last thing an adapter does. */
export function canonicalMessages(messages) {
  return (messages || []).map((m) => (
    m?.tools?.length ? { ...m, tools: m.tools.map(canonicalTool) } : m
  ));
}
