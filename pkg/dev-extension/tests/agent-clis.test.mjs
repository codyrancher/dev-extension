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

import { transcriptKind, parseAgyTranscript, CLI_CHOICES } from '../agent-clis.mjs';

const AGY = [
  '{"step_index":0,"source":"SYSTEM","type":"SYSTEM_MESSAGE","status":"DONE","created_at":"2026-10-19T17:00:00Z","content":"Antigravity CLI"}',
  '{"step_index":1,"source":"USER_EXPLICIT","type":"USER_INPUT","status":"DONE","created_at":"2026-10-19T17:00:05Z","content":"reproduce the drawer bug"}',
  '{"step_index":2,"source":"MODEL","type":"GENERIC","status":"DONE","created_at":"2026-10-19T17:00:09Z","content":"Looking at the drawer component."}',
  '{"step_index":3,"source":"MODEL","type":"PLANNER_RESPONSE","status":"DONE","created_at":"2026-10-19T17:00:12Z","input_tokens":900,"output_tokens":40,"tool_calls":[{"name":"run_command","args":{"command":"yarn test drawer"}}]}',
  '{"step_index":4,"source":"MODEL","type":"GENERIC","status":"RUNNING","created_at":"2026-10-19T17:00:20Z","content":"Running the suite."}',
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

  // The banner is the CLI talking to itself, not part of the conversation.
  assert.deepEqual(messages.map((m) => m.role), ['user', 'assistant', 'assistant', 'assistant']);
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
  // And no result, because agy records none against the call - the view must not invent one.
  assert.equal(call.result, undefined);
});

test('a step still happening says so', () => {
  const messages = parseAgyTranscript(AGY);

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
