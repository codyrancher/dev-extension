/**
 * Reading a second CLI's transcript into the one shape the chat view knows.
 *
 * The agy lines below are the schema of a real transcript written by agy 1.4.2
 * (~/.gemini/antigravity-cli/brain/<uuid>/.system_generated/logs/transcript.jsonl) with made-up
 * content: step_index / source / type / status / created_at on every line, `content` as a plain
 * string, `tool_calls` as `{name, args}` with no id, and `status: RUNNING` for a step still
 * happening.
 *
 * `node --test pkg/dev-extension/tests/*.test.mjs`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  transcriptKind, parseAgyTranscript, CLI_CHOICES, agyPhase, agyTailText
} from '../agent-clis.mjs';

const AGY = [
  '{"step_index":0,"source":"SYSTEM","type":"SYSTEM_MESSAGE","status":"DONE","created_at":"2026-10-19T17:00:00Z","content":"Antigravity CLI"}',
  '{"step_index":1,"source":"USER_EXPLICIT","type":"USER_INPUT","status":"DONE","created_at":"2026-10-19T17:00:05Z","content":"reproduce the drawer bug"}',
  '{"step_index":2,"source":"MODEL","type":"GENERIC","status":"DONE","created_at":"2026-10-19T17:00:09Z","content":"Looking at the drawer component."}',
  '{"step_index":3,"source":"MODEL","type":"PLANNER_RESPONSE","status":"DONE","created_at":"2026-10-19T17:00:12Z","input_tokens":900,"output_tokens":40,"tool_calls":[{"name":"run_command","args":{"command":"yarn test drawer"}}]}',
  // What agy really writes for a tool's answer, taken from a live transcript: a GENERIC step
  // of its own, source MODEL like the call before it, carrying the run's envelope.
  '{"step_index":4,"source":"MODEL","type":"GENERIC","status":"RUNNING","created_at":"2026-10-19T17:00:20Z","content":"Created At: 2026-10-19T17:00:20Z\\nCommand exited with code 0.\\n\\nCommand output:\\n12 passing\\n"}',
];

const CLAUDE = [
  '{"type":"user","uuid":"u1","timestamp":"2026-10-19T17:00:00Z","message":{"content":"hello"}}',
  '{"type":"assistant","uuid":"a1","timestamp":"2026-10-19T17:00:01Z","message":{"content":[{"type":"text","text":"hi"}]}}',
];

test('a transcript says what wrote it', () => {
  assert.equal(transcriptKind(AGY), 'agy');
  assert.equal(transcriptKind(CLAUDE), 'claude');
  assert.equal(transcriptKind([]), '');
  assert.equal(transcriptKind(['not json at all']), '');
  // A read that began mid-file starts with half a line; the answer comes from the next one.
  assert.equal(transcriptKind(['nt":"hi"}]}}', ...CLAUDE]), 'claude');
  assert.equal(transcriptKind(['x_index":2,"source"', ...AGY]), 'agy');
});

test('agy steps become the shape the chat view already reads', () => {
  const messages = parseAgyTranscript(AGY);

  // The banner is the CLI talking to itself, not part of the conversation - and the step
  // carrying a tool's answer is the tool talking, so it is folded into the call rather than
  // being a fourth message of the agent's. See parseAgyTranscript.
  assert.deepEqual(messages.map((m) => m.role), ['user', 'assistant', 'assistant']);
  assert.equal(messages[0].text, 'reproduce the drawer bug');
  assert.equal(messages[0].at, '2026-10-19T17:00:05Z');
  // Every message carries the fields the view indexes, even when empty.
  for (const m of messages) {
    assert.deepEqual([Array.isArray(m.tools), typeof m.thinking, Array.isArray(m.images), typeof m.key], [true, 'string', true, 'string']);
  }
});

test('a tool call survives without the id agy does not give it', () => {
  const call = parseAgyTranscript(AGY).find((m) => m.tools.length).tools[0];

  assert.equal(call.name, 'run_command');
  assert.deepEqual(call.input, { command: 'yarn test drawer' });
  // Made from where the call is, so it is stable across re-reads of the same transcript.
  assert.equal(call.id, '3-0');
  /*
   * And the result, which agy records as the NEXT step rather than against the call.
   *
   * This used to assert `undefined`, on the belief that agy recorded no result at all - which
   * a live transcript disproves: every call is followed by a GENERIC step carrying its
   * envelope. Believing otherwise is what put those envelopes in the conversation as things
   * the agent had said.
   */
  assert.match(call.result, /12 passing/);
});

test('a step still happening says so', () => {
  const messages = parseAgyTranscript(AGY);

  // The RUNNING step is the tool's answer, folded into the call on the message before it - so
  // the turn that owns the call is what reports as running, which is the turn a reader sees.
  assert.equal(messages.at(-1).running, true);
  assert.equal(messages[1].running, false);
});

test('nothing in the file is lost to a bad line, and empty steps are not messages', () => {
  const messages = parseAgyTranscript([
    'half a line',
    '{"step_index":9,"source":"MODEL","type":"GENERIC","status":"DONE","created_at":"","content":""}',
    AGY[1],
  ]);

  assert.deepEqual(messages.map((m) => m.text), ['reproduce the drawer bug']);
  assert.deepEqual(parseAgyTranscript([]), []);
  assert.deepEqual(parseAgyTranscript(null), []);
});

test('every CLI the split button offers has a glyph and a name', () => {
  // The menu is one row of icon-and-name, so a choice with no icon draws an empty box where the
  // glyph goes - and a glyph that is not in Rancher's set draws the same box. Both are the kind
  // of thing nobody notices until the menu is open in front of somebody.
  const ICONS = ['icon-ai', 'icon-gemini', 'icon-terminal', 'icon-code', 'icon-openai', 'icon-ollama'];

  assert.ok(CLI_CHOICES.length >= 2, 'a split button needs something to split');
  assert.equal(CLI_CHOICES[0].id, 'claude', 'the plain press is claude');

  for (const choice of CLI_CHOICES) {
    assert.match(choice.id, /^[a-z][a-z0-9-]*$/, `${ choice.id } is a usable id`);
    assert.ok(choice.label, `${ choice.id } has a name`);
    assert.ok(ICONS.includes(choice.icon), `${ choice.id }'s icon ${ choice.icon } is one Rancher ships`);
    // Still wanted, just not in the menu: Settings draws it, and so does the row's tooltip.
    assert.ok(choice.what && choice.what.length > 20, `${ choice.id } says what it is`);
  }
});

test('a user turn is what the person typed, not the envelope agy sends the model', () => {
  // The real shape, from a transcript agy 1.4.3 wrote: the words are wrapped in USER_REQUEST and
  // agy appends a metadata block of its own. Drawn literally this is seven lines of XML where
  // "Say hello" should be - and it is also why a sent message stayed marked "no record of this",
  // since the view matches the text it sent against the text in the transcript.
  const line = JSON.stringify({
    step_index: 0,
    source:     'USER_EXPLICIT',
    type:       'USER_INPUT',
    status:     'DONE',
    created_at: '2026-10-20T17:26:26Z',
    content:    '<USER_REQUEST>\nSay hello\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nThe current local time is: 2026-10-20T17:26:26Z.\n</ADDITIONAL_METADATA>\n',
  });

  const [message] = parseAgyTranscript([line]);

  assert.equal(message.role, 'user');
  assert.equal(message.text, 'Say hello');
});

test('a turn with no envelope is left exactly as it is', () => {
  const plain = JSON.stringify({
    step_index: 1, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: '2026-10-20T17:30:00Z', content: 'just the words',
  });
  const metaOnly = JSON.stringify({
    step_index: 2, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: '2026-10-20T17:31:00Z', content: 'words\n<ADDITIONAL_METADATA>\ntime\n</ADDITIONAL_METADATA>\n',
  });

  assert.equal(parseAgyTranscript([plain])[0].text, 'just the words');
  assert.equal(parseAgyTranscript([metaOnly])[0].text, 'words');
});

test("an assistant turn is never unwrapped - the model's words are its own", () => {
  const line = JSON.stringify({
    step_index: 3, source: 'MODEL', type: 'GENERIC', status: 'DONE', created_at: '2026-10-20T17:26:30Z', content: 'Hello! How can I help you today?',
  });

  assert.equal(parseAgyTranscript([line])[0].text, 'Hello! How can I help you today?');
});

test('agy is working while a step is RUNNING, and idle once it is done', () => {
  const step = (over) => ({
    step_index: 0, source: 'MODEL', type: 'GENERIC', status: 'DONE', created_at: '2026-10-20T18:00:00Z', content: 'x', ...over,
  });

  assert.equal(agyPhase([step({ status: 'RUNNING' })]), 'working');
  assert.equal(agyPhase([step({})]), 'idle');
  // A question asked and not yet answered is the person waiting, whatever the step says.
  assert.equal(agyPhase([step({ source: 'USER_EXPLICIT', type: 'USER_INPUT' })]), 'working');
  // And the last step is the one that decides.
  assert.equal(agyPhase([step({ source: 'USER_EXPLICIT', type: 'USER_INPUT' }), step({})]), 'idle');
});

test('agyPhase says nothing about an empty transcript, so nothing is overridden', () => {
  assert.equal(agyPhase([]), '');
  assert.equal(agyPhase(null), '');
});

// ── agy writes a tool's answer as a step of its own ─────────────────────────────────────────
//
// Taken from a real transcript (brain/203a349c…/logs/transcript.jsonl): the turn is a pair,
// a PLANNER_RESPONSE carrying the call and a GENERIC carrying what came back, both
// `source: MODEL`. Pushed as a message, the second one opened every Antigravity conversation
// with a wall of "Created At: … Command exited with code 0. Command output: …" attributed to
// the agent.

test('a result step is folded into the call it answers, not shown as the agent talking', () => {
  const lines = [
    {
      step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-10-27T12:55:52Z', content: null,
      tool_calls: [{ name: 'run_command', args: { command: 'which gh' } }],
    },
    {
      step_index: 2, source: 'MODEL', type: 'GENERIC', status: 'DONE', created_at: '2026-10-27T12:55:53Z',
      content: 'Created At: 2026-10-27T12:55:52Z\nCompleted At: 2026-10-27T12:55:53Z\nCommand exited with code 0.\n\nCommand output:\n/workspace/.home/.local/bin/gh\n',
    },
  ].map((o) => JSON.stringify(o));
  const messages = parseAgyTranscript(lines);

  assert.equal(messages.length, 1, 'one turn, not a turn and a blurb');
  assert.equal(messages[0].tools.length, 1);
  assert.match(messages[0].tools[0].result, /\/workspace\/\.home\/\.local\/bin\/gh/, 'the output is under the call');
  assert.equal(messages[0].tools[0].resultIsError, false, 'exit 0 is not a failure');
});

test('a non-zero exit marks the call failed, so the collapsed row can say so', () => {
  const lines = [
    {
      step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-10-27T12:55:52Z', content: null,
      tool_calls: [{ name: 'run_command', args: { command: 'false' } }],
    },
    {
      step_index: 2, source: 'MODEL', type: 'GENERIC', status: 'DONE', created_at: '2026-10-27T12:55:53Z',
      content: 'Created At: 2026-10-27T12:55:52Z\nCommand exited with code 1.\n\nCommand output:\n',
    },
  ].map((o) => JSON.stringify(o));

  assert.equal(parseAgyTranscript(lines)[0].tools[0].resultIsError, true);
});

test('and a model step with no call waiting is still a message', () => {
  // The last step of a turn is the answer itself, and nothing is pending by then.
  const lines = [JSON.stringify({
    step_index: 9, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-10-27T12:56:30Z', content: 'I found 20 candidates.',
  })];

  assert.equal(parseAgyTranscript(lines)[0].text, 'I found 20 candidates.');
});

// ── What a subagent last said, in agy's shape ───────────────────────────────────────────────

test('a subagent tail reads agy\'s own line, not claude\'s', () => {
  const summarise = (call) => `ran ${ call.input.command }`;

  assert.equal(
    agyTailText(JSON.stringify({ step_index: 4, source: 'MODEL', content: 'Recorded the first three.' }), summarise),
    'Recorded the first three.',
  );
  assert.equal(
    agyTailText(JSON.stringify({ step_index: 5, source: 'MODEL', tool_calls: [{ name: 'run_command', args: { command: 'yarn test' } }] }), summarise),
    'run_command: ran yarn test',
  );
  // A line cut in half by the 6000-byte tail, which is the usual case for the newest one.
  assert.equal(agyTailText('{"step_index":6,"sou', summarise), '');
  assert.equal(agyTailText('', summarise), '');
});
