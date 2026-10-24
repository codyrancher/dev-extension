// The canonical chat format, against the tool names and argument shapes the two CLIs really
// emit. Everything here was read off a live transcript of each rather than imagined: claude's
// names from chat.ts's own switch, agy's from a 559-line transcript in the agent pod
// (`run_command`, `read_file`, `write_file`, `edit_file`, `manage_task`, `schedule`), including
// the detail that makes the difference - agy encodes every argument as JSON inside a JSON
// string, so `Path` arrives as `"\"/workspace/x\""`.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  toolKind, toolSummary, canonicalTool, canonicalMessages, plain, KIND_LABEL, TOOL_KINDS,
} from '../chat-format.mjs';

test('the same act gets the same kind whichever CLI did it', () => {
  for (const [a, b] of [['Bash', 'run_command'], ['Read', 'read_file'], ['Write', 'write_file'], ['Edit', 'edit_file'], ['TodoWrite', 'manage_task']]) {
    assert.equal(toolKind(a), toolKind(b), `${ a } and ${ b } should be one kind`);
  }
});

test('case is not a difference', () => {
  assert.equal(toolKind('RUN_COMMAND'), 'run');
  assert.equal(toolKind('bash'), 'run');
  assert.equal(toolKind('AskUserQuestion'), 'ask');
});

test('a tool nobody mapped is `other` rather than a crash', () => {
  assert.equal(toolKind('SomeFutureTool'), 'other');
  assert.equal(toolKind(undefined), 'other');
  assert.equal(toolKind(''), 'other');
});

test('every kind has a badge, and every badge belongs to a kind', () => {
  for (const kind of TOOL_KINDS) {
    assert.ok(KIND_LABEL[kind], `${ kind } has no label`);
  }
  for (const kind of Object.keys(KIND_LABEL)) {
    assert.ok(TOOL_KINDS.includes(kind), `${ kind } is labelled but is not a kind`);
  }
});

test("agy's double-encoded arguments come back plain", () => {
  assert.equal(plain('"/workspace/x.png"'), '/workspace/x.png');
  assert.equal(plain('600'), 600);
  // claude's are already plain, and must not be mangled.
  assert.equal(plain('/workspace/x.png'), '/workspace/x.png');
  assert.equal(plain('a "quoted" word inside'), 'a "quoted" word inside');
  assert.equal(plain(undefined), undefined);
});

test('a shell command summarises to its description, from either CLI', () => {
  // claude
  assert.equal(
    toolSummary('run', { command: 'ls -la /tmp', description: 'List the workspace' }),
    'List the workspace',
  );
  // agy: its own one-line summary, and both values double-encoded
  assert.equal(
    toolSummary('run', { CommandLine: '"ls -la /workspace"', WaitMsBeforeAsync: '5000', toolSummary: '"List workspace files"' }),
    'List workspace files',
  );
  // and the command itself when neither CLI wrote a description
  assert.equal(toolSummary('run', { CommandLine: '"git status"' }), 'git status');
});

test('a file path summarises the same from either CLI', () => {
  assert.equal(toolSummary('read', { file_path: '/a/b.ts' }), '/a/b.ts');
  assert.equal(toolSummary('read', { Path: '"/a/b.ts"', StartLine: '1', EndLine: '600' }), '/a/b.ts');
  assert.equal(toolSummary('write', { Path: '"/a/b.mjs"', Content: '"// code"' }), '/a/b.mjs');
});

test('the long shell command no longer lands in the summary as-is', () => {
  // The row in the report: RUN_COMMAND with the whole command beside it.
  const call = {
    name:  'run_command',
    input: { CommandLine: '"cd /workspaces/lte-pr-19380/dashboard && git worktree remove --force /workspaces/x"', toolSummary: '"Remove the stale worktree"' },
  };
  const out = canonicalTool(call);

  assert.equal(out.kind, 'run');
  assert.equal(out.label, 'RUN');
  assert.equal(out.summary, 'Remove the stale worktree');
  assert.ok(!out.summary.includes('git worktree'), 'the command should not be the summary when a description exists');
});

test('the call keeps its own name and arguments', () => {
  const call = { id: '3-0', name: 'run_command', input: { CommandLine: '"ls"' } };
  const out = canonicalTool(call);

  assert.equal(out.name, 'run_command', "the CLI's own name is kept for the detail pane");
  assert.deepEqual(out.input, { CommandLine: '"ls"' }, 'arguments are untouched');
  assert.equal(out.id, '3-0');
});

test('messages without tools pass through untouched', () => {
  const messages = [{ key: 'a', role: 'user', text: 'hello', tools: [] }];

  assert.deepEqual(canonicalMessages(messages), messages);
  assert.deepEqual(canonicalMessages([]), []);
  assert.deepEqual(canonicalMessages(undefined), []);
});

test('messages with tools get canonical ones', () => {
  const out = canonicalMessages([
    { key: 'm1', role: 'assistant', text: '', tools: [{ id: '1', name: 'Bash', input: { description: 'Run the tests' } }] },
    { key: 'm2', role: 'assistant', text: '', tools: [{ id: '2', name: 'run_command', input: { toolSummary: '"Run the tests"' } }] },
  ]);

  assert.equal(out[0].tools[0].label, out[1].tools[0].label, 'one badge for one act');
  assert.equal(out[0].tools[0].summary, out[1].tools[0].summary, 'one summary for one act');
});
