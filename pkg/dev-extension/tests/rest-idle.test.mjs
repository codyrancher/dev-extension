// What may close an idle conversation. Every refusal here is somebody's work surviving, so a pass
// over a transcript that cannot be understood has to come out as "keep".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { decide, inProgress, lastStampMs, IDLE_MS } from '../seed/agent/rest-idle.mjs';
import { activityBucket } from '../chat-state.mjs';
import { paneReadyScript } from '../pane-send.mjs';

const NOW = Date.parse('2026-11-02T12:00:00Z');
const IDLE = NOW - IDLE_MS - 60_000;
const at = (ms) => new Date(ms).toISOString();

const line = (o) => JSON.stringify({ timestamp: at(IDLE), ...o });
const prompt = (text = 'do it') => line({ type: 'user', message: { content: text } });
const said = (stop = 'end_turn', content = [{ type: 'text', text: 'done' }]) => line({ type: 'assistant', message: { stop_reason: stop, content } });
const use = (id, name = 'Bash', input = {}) => said('tool_use', [{
  type: 'tool_use', id, name, input
}]);
const result = (id) => line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } });
const ended = line({ type: 'system', subtype: 'turn_duration' });
const finished = [prompt(), said(), ended].join('\n');

const conversation = (over = {}) => ({
  command:      '/bin/bash /seed/claude-session.sh q id',
  windows:      1,
  claudes:      1,
  children:     [],
  conversation: 'abc',
  queued:       false,
  tail:         finished,
  crons:        0,
  activity:     [IDLE],
  ...over,
});

test('a finished conversation idle past the limit may close', () => {
  assert.equal(decide(conversation(), NOW), '');
});

test('idle means thirty minutes since anything at all touched it', () => {
  assert.match(decide(conversation({ activity: [IDLE, NOW - IDLE_MS + 60_000] }), NOW), /active/);
  assert.match(decide(conversation({ activity: [IDLE, NaN] }), NOW), /could not be read/);
  assert.match(decide(conversation({ activity: [] }), NOW), /could not be read/);
});

test('what is not one claude that can be resumed stays', () => {
  assert.notEqual(decide(conversation({ command: '/bin/bash' }), NOW), '');
  assert.notEqual(decide(conversation({ command: 'agy-session.sh' }), NOW), '');
  assert.notEqual(decide(conversation({ claudes: 0 }), NOW), '');
  assert.notEqual(decide(conversation({ windows: 2 }), NOW), '');
  assert.match(decide(conversation({ conversation: '' }), NOW), /resume/);
  assert.match(decide(conversation({ tail: null }), NOW), /transcript/);
  assert.match(decide(conversation({ queued: true }), NOW), /prompt/);
});

test('a process under claude stays, unless it is an MCP server', () => {
  assert.equal(decide(conversation({ children: ['npm exec figma-developer-mcp --stdio'] }), NOW), '');
  assert.match(decide(conversation({ children: ['npm exec figma-developer-mcp', 'yarn test'] }), NOW), /running under claude/);
});

test('a cron not deleted stays, until it would have expired', () => {
  assert.match(decide(conversation({ crons: 1 }), NOW), /cron/);
  assert.equal(decide(conversation({ crons: 1, activity: [NOW - (8 * 24 * 3600_000)] }), NOW), '');
  assert.equal(decide(conversation({ crons: 0 }), NOW), '');
});

test('a turn is over only when the transcript says so', () => {
  const ask = (...lines) => inProgress(lines.join('\n'), NOW, IDLE);

  assert.equal(ask(prompt(), said(), ended), '');
  assert.equal(ask(prompt(), said()), '');
  assert.equal(ask(prompt(), line({ type: 'user', message: { content: '[Request interrupted by user]' } })), '');
  assert.match(ask(prompt()), /not ended/);
  assert.match(ask(prompt(), use('a'), result('a')), /not ended/);
  assert.match(ask('', 'not json at all'), /no finished turn/);
  assert.match(ask(''), /no finished turn/);
});

test('a tool with no result stays, which is also a question waiting for its answer', () => {
  const ask = (...lines) => inProgress(lines.join('\n'), NOW, IDLE);

  assert.match(ask(prompt(), use('a', 'Bash')), /no result/);
  assert.match(ask(prompt(), use('q', 'AskUserQuestion')), /no result/);
  assert.equal(ask(prompt(), use('q', 'AskUserQuestion'), result('q'), said(), ended), '');
});

test('something in the background stays until it has reported back', () => {
  const started = [prompt(), use('b', 'Agent', { run_in_background: true }), result('b'), said(), ended];
  const reported = line({ type: 'attachment', content: '<task-notification><tool-use-id>b</tool-use-id></task-notification>' });

  assert.match(inProgress(started.join('\n'), NOW, IDLE), /background/);
  assert.equal(inProgress([...started, reported, said(), ended].join('\n'), NOW, IDLE), '');
  assert.match(inProgress([prompt(), use('w', 'Workflow'), result('w'), said(), ended].join('\n'), NOW, IDLE), /background/);
  assert.equal(inProgress(started.join('\n'), NOW, NOW - (25 * 3600_000)), '', 'one that never came back in a day is not coming');
});

test('a wake-up stays until it is overdue, and a stopped one does not count', () => {
  const wake = (input) => [prompt(), use('z', 'ScheduleWakeup', input), result('z'), said(), ended].join('\n');

  assert.match(inProgress(wake({ delaySeconds: 3600 }), NOW, IDLE), /wake-up/);
  assert.equal(inProgress(wake({ stop: true }), NOW, IDLE), '');
  assert.equal(inProgress(wake({ delaySeconds: 60 }), IDLE + 3_000_000, IDLE), '');
});

test('the last thing that happened ignores lines with no stamp, which the CLI rewrites while idle', () => {
  assert.equal(lastStampMs(`${ finished }\n{"type":"ai-title","title":"x"}\n`), IDLE);
  assert.ok(Number.isNaN(lastStampMs('{"type":"ai-title"}')));
  assert.ok(Number.isNaN(lastStampMs(null)));
});

test('closed for being idle reads as idle and never as finished', () => {
  assert.equal(activityBucket({
    alive: false, resting: true, event: 'Stop', at: at(NOW), wroteAgo: 5000
  }, NOW - 3600_000, NOW), 'idle');
});

test('the wiring: the pod closes on a timer, a send wakes, the hook stays quiet', () => {
  const read = (file) => fs.readFileSync(new URL(`../${ file }`, import.meta.url), 'utf8');

  assert.match(read('dev-api/server.mjs'), /'rest-idle'\]/);
  assert.match(read('dev-api/server.mjs'), /setInterval\(\(\) => restIdle\(\)/);
  assert.match(read('seed/agent/sessions.sh'), /exec node \/seed\/rest-idle\.mjs/);
  assert.match(read('seed/shell.sh'), /sessions\/\$SESSION\.resting/);
  assert.match(read('seed/chat-hook.mjs'), /\.resting`\)\)\) \{\s+process\.exit\(0\)/);
  assert.match(read('chat-conversation.ts'), /if \(!attached\.value\) \{\s+await wake\(\);/);
  assert.match(read('conversations.ts'), /said === 'NOPANE' && !woken && workspace/);
  assert.ok(paneReadyScript({ pane: 'p' }).some((l) => l.includes('bypass permissions')));
});

test('a tab: rename and close are in its menu on every strip, and the middle button closes it', () => {
  const tab = fs.readFileSync(new URL('../components/tabbed/ConversationTab.vue', import.meta.url), 'utf8');

  assert.match(tab, /\['rename', \.\.\.\(Array\.isArray\(this\.actions\) \? this\.actions : \[\]\), 'close'\]/);
  assert.match(tab, /if \(id === 'rename'\) \{\s+this\.startRename\(\);/);
  assert.match(tab, /@mousedown\.middle\.prevent\s+@auxclick\.middle\.stop\.prevent="onMiddle"/);
  assert.doesNotMatch(tab, /control--rename|control--close/, 'only the caret is drawn on the tab');
});
