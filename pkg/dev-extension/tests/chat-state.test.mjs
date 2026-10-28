// What the conversation state is read from, pinned.
//
// This is the first test in the repository, and it is here rather than anywhere else because
// this is the code that "still does not fully work": claude's own transcript is structured and
// reliable, and everything derived from the *pane* is a reading of a terminal UI that changes
// when claude's UI changes. A reading like that cannot be made correct once; it can only be
// pinned, so that the next shape it does not handle arrives as a failing test instead of as a
// conversation that looks idle while it is waiting for an answer.
//
// `node --test` with no runner and no dependency: chat-state.mjs is plain JavaScript, Node 24
// loads it as it is, and a test that needs an install is a test nobody runs.
//
// Each case names the shape it is about. Two of them are regressions from real failures: the
// one-line numbered survey that read as prose, and the `1:30` timestamp that read as a numbered
// answer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  loginFrom, verbFrom, pendingQuestion, splitPasted, unwrapPasted, promptTextOf, duration, tokens, ago, promptKey, reconcilePending,
  parseEntries, deriveState, foldQueue, promptRecords, isCliText
} from '../chat-state.mjs';

// ── The login flow: the one state only the pane shows ──────────────────────────────────────

test('loginFrom finds the oauth url the pane prints', () => {
  const pane = [
    'Browser didn\'t open? Use the url below to sign in:',
    'https://claude.ai/oauth/authorize?code=true&client_id=abc',
    '',
    'Paste code here if prompted >',
  ].join('\n');
  const found = loginFrom(pane);

  assert.ok(found, 'a pane showing the oauth url is a login');
  assert.equal(found.kind, 'code', 'with "Paste code here" it is the code half of the flow');
  assert.match(found.url, /^https:\/\/claude\.ai\/oauth\/authorize/);
});

test('loginFrom reads a url broken across lines by the pane width', () => {
  // The pane wraps, and the wrap lands mid-url. This is why the reader joins lines that do not
  // start with whitespace before matching.
  const pane = 'Use the url below:\nhttps://claude.ai/oauth/authorize?code=true&client\n_id=abc';

  assert.match(loginFrom(pane)?.url || '', /client_id=abc/);
});

test('loginFrom answers null for an ordinary pane', () => {
  assert.equal(loginFrom('> ready\n  esc to interrupt'), null);
  assert.equal(loginFrom(''), null);
});

// ── The spinner's verb ─────────────────────────────────────────────────────────────────────

test('verbFrom reads the spinner verb, and only a real one', () => {
  for (const [pane, want] of [
    ['✻ Herding… (5m 30s · ↓ 25.2k tokens)', 'Herding'],
    ['✽ Thinking… (2s)', 'Thinking'],
    ['  · Pondering… (1s)', 'Pondering'],
    ['> ready', ''],
    ['✻ HERDING… (5s)', ''],
    ['', ''],
  ]) {
    assert.equal(verbFrom(pane), want, `pane: ${ JSON.stringify(pane) }`);
  }
});

// ── A question waiting for an answer ───────────────────────────────────────────────────────

const ask = (id, questions = []) => ({
  type:      'assistant',
  timestamp: '2026-10-19T00:00:00Z',
  message:   { content: [{ type: 'tool_use', id, name: 'AskUserQuestion', input: { questions } }] },
});
const answer = (id) => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id }] } });

test('pendingQuestion finds an unanswered question', () => {
  const pending = pendingQuestion([ask('q1', [{ question: 'Which?' }])]);

  assert.ok(pending);
  assert.equal(pending.id, 'q1');
  assert.equal(pending.tool, 'AskUserQuestion');
  assert.equal(pending.questions.length, 1);
});

test('pendingQuestion answers null once the question has a result', () => {
  assert.equal(pendingQuestion([ask('q1'), answer('q1')]), null);
});

test('pendingQuestion answers null while a non-question tool is still running', () => {
  // Mid-tool is not waiting on a person, and reading it as one is what makes a working
  // conversation look blocked.
  const running = {
    type:    'assistant',
    message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }] },
  };

  assert.equal(pendingQuestion([ask('q1'), answer('q1'), running]), null);
});

test('pendingQuestion is null for an empty transcript', () => {
  assert.equal(pendingQuestion([]), null);
});

// ── Pasted blocks ──────────────────────────────────────────────────────────────────────────

test('splitPasted separates a pasted block from what was typed', () => {
  const parts = splitPasted('look at this\n[Pasted text #1 +12 lines]\nand tell me');

  assert.ok(Array.isArray(parts), 'it answers in parts');
  assert.ok(parts.length >= 1);
});

test('unwrapPasted is a no-op on text with nothing pasted', () => {
  assert.equal(unwrapPasted('just a sentence'), 'just a sentence');
});

test('a prompt recorded as content blocks reads as the sentence, not as its parts', () => {
  // The symptom: `[object Object],[object Object]` under YOU in the chat. A message with a
  // screenshot attached is recorded as the blocks claude was handed rather than as a string,
  // and `String()` of those names the parts instead of saying what the person said. promptKey
  // compared that against a sentence too, so the copy waiting for it never retired.
  const blocks = [
    { type: 'text', text: '[Image #3]Make it easy to copy the tokens' },
    {
      type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0' },
    },
  ];

  assert.equal(promptTextOf(blocks), '[Image #3]Make it easy to copy the tokens');
  assert.equal(unwrapPasted(blocks), '[Image #3]Make it easy to copy the tokens');
  assert.equal(promptKey(blocks), promptKey('Make it easy to copy the tokens'), 'the marker is the CLI\'s, not the person\'s');
  assert.equal(promptTextOf('typed, nothing attached'), 'typed, nothing attached');
});

// ── The small formatters, which are easy to get subtly wrong ───────────────────────────────

test('duration reads as a person would say it', () => {
  assert.equal(duration(0), '0s');
  assert.match(duration(1000), /^1s$/);
  assert.match(duration(90_000), /1m/);
});

test('tokens abbreviates without lying about the magnitude', () => {
  assert.equal(tokens(0), '0');
  assert.match(String(tokens(25_200)), /25/);
});

test('promptKey is stable for the same text and differs for different text', () => {
  assert.equal(promptKey('do the thing'), promptKey('do the thing'));
  assert.notEqual(promptKey('do the thing'), promptKey('do the other thing'));
});

test('a message sent to an Antigravity pane is retired by agy\'s own record of it', () => {
  // The symptom this is for: every message sat as "queued / SENDING" under the answer agy had
  // already given it, then flipped to "no record of this" twenty seconds later. promptRecords
  // walked claude's entry shapes only, so an agy transcript claimed nothing - and the words are
  // inside the envelope agy sends the model, so even a shape-blind text match would have missed.
  const sentAt = Date.parse('2026-10-20T18:00:00Z');
  const pending = [{ text: 'Say hello', sentAt }];
  const entries = [{
    step_index: 0,
    source:     'USER_EXPLICIT',
    type:       'USER_INPUT',
    status:     'DONE',
    created_at: '2026-10-20T18:00:01Z',
    content:    '<USER_REQUEST>\nSay hello\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nThe current local time is: 2026-10-20T18:00:01Z.\n</ADDITIONAL_METADATA>\n',
  }];

  assert.deepEqual(reconcilePending(pending, { entries, now: sentAt + 1000 }), []);
});

test('and one agy never recorded at all is still reported', () => {
  // Only a model step, which is not a prompt record of any kind - so nothing claims the message
  // and, once the grace is up, the view says so rather than leaving it "sending" for ever.
  //
  // Note what this does NOT assert: a message is retired by a record of SOMETHING arriving
  // after it was sent, even under a different key, which is deliberate - claude rewrites what
  // it records (a slash command, an image, a paste) often enough that demanding an exact match
  // would strand messages that did land. See reconcilePending's second pass.
  const sentAt = Date.parse('2026-10-20T18:00:00Z');
  const pending = [{ text: 'the one that never landed', sentAt }];
  const entries = [{
    step_index: 0, source: 'MODEL', type: 'GENERIC', status: 'DONE', created_at: '2026-10-20T18:00:01Z', content: 'thinking out loud',
  }];
  const [left] = reconcilePending(pending, { entries, now: sentAt + 30000 });

  assert.equal(left.failed, true);
});

test('ago says how long ago in the unit worth reading, and nothing for no date', () => {
  // One format for the whole product: the rail and My Work each had their own, saying the same
  // thing in two vocabularies on two halves of one page. Both delegate here now.
  const now = Date.now();

  assert.equal(ago(new Date(now - 30_000).toISOString()), 'just now');
  assert.equal(ago(new Date(now - 5 * 60_000).toISOString()), '5m ago');
  assert.equal(ago(new Date(now - 3 * 3600_000).toISOString()), '3h ago');
  assert.equal(ago(new Date(now - 2 * 86400_000).toISOString()), '2d ago');
  assert.equal(ago(new Date(now - 90 * 86400_000).toISOString()), '3mo ago');
  assert.equal(ago(''), '', 'no date is no words, not "NaN ago"');
  assert.equal(ago('not a date'), '');
});

// ── A compact is not a turn ─────────────────────────────────────────────────────────────────
//
// The symptom: a conversation that finished days ago reading "Working for 104h 45m". A compact
// writes the folded conversation back as a plain `user` line, so every test isPromptEntry makes
// says somebody is speaking - and it lands AFTER the turn that triggered it has ended, so it
// became the newest turn start with no end after it. Measured on six live transcripts: the
// summary sits after the last `turn_duration` in every one.

const turnLines = (...extra) => [
  { type: 'user', timestamp: '2026-10-20T10:00:00Z', message: { content: 'do the thing' } },
  { type: 'assistant', timestamp: '2026-10-20T10:00:05Z', message: { content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn' } },
  { type: 'system', subtype: 'turn_duration', timestamp: '2026-10-20T10:00:06Z' },
  ...extra,
].map((o) => JSON.stringify(o));

test('a compact summary does not leave a finished conversation working', () => {
  const lines = turnLines({
    type: 'user', timestamp: '2026-10-20T10:00:09Z', isCompactSummary: true,
    message: { content: 'This session is being continued from a previous conversation that ran out of context.' },
  });
  const state = deriveState({
    entries: parseEntries(lines), paneText: '', hook: null, alive: true, attached: true,
  });

  assert.equal(state.phase, 'idle');
  assert.equal(state.status, 'Ready');
});

test('and neither does one the CLI did not flag, which is how it reads in the file', () => {
  // `isCompactSummary` is not always set; the sentence is the other half of the test.
  const lines = turnLines({
    type:    'user',
    timestamp: '2026-10-20T10:00:09Z',
    message: { content: [{ type: 'text', text: 'This session is being continued from a previous conversation that ran out of context. The summary below covers...' }] },
  });

  assert.equal(deriveState({
    entries: parseEntries(lines), paneText: '', hook: null, alive: true, attached: true,
  }).phase, 'idle');
});

test('a background task finishing DOES start a turn - claude picks it up and works', () => {
  // The narrowing is to the summary alone. A task-notification and a system-reminder are the
  // other two lines isCliPrompt covers, and both really do start a turn.
  const lines = turnLines({
    type: 'user', timestamp: '2026-10-20T10:00:09Z', message: { content: '<task-notification><summary>Background command "yarn test" completed</summary><status>completed</status></task-notification>' },
  });

  assert.equal(deriveState({
    entries: parseEntries(lines), paneText: '', hook: null, alive: true, attached: true,
  }).phase, 'working');
});

test('a real prompt after a compact still starts a turn', () => {
  const lines = turnLines(
    {
      type: 'user', timestamp: '2026-10-20T10:00:09Z', isCompactSummary: true, message: { content: 'This session is being continued from a previous conversation that ran out of context.' },
    },
    { type: 'user', timestamp: '2026-10-20T10:01:00Z', message: { content: 'carry on then' } },
  );

  assert.equal(deriveState({
    entries: parseEntries(lines), paneText: '', hook: null, alive: true, attached: true,
  }).phase, 'working');
});


// ── The CLI's input queue, and what the record of it does not say ───────────────────────────

const op = (operation, content) => ({
  type: 'queue-operation', operation, timestamp: '2026-10-28T19:00:00Z', ...(content === undefined ? {} : { content }),
});

const TASK = '<task-notification>\n<task-id>b00b4fa1u</task-id>\n</task-notification>';

test('the queue is what was put in and not taken out again', () => {
  assert.deepEqual(foldQueue([op('enqueue', 'one'), op('enqueue', 'two'), op('remove', 'one')]), ['two']);
});

test('a dequeue takes the front, which is what a turn starts on', () => {
  assert.deepEqual(foldQueue([op('enqueue', 'one'), op('enqueue', 'two'), op('dequeue')]), ['two']);
});

test('popAll empties it', () => {
  assert.deepEqual(foldQueue([op('enqueue', 'one'), op('enqueue', 'two'), op('popAll')]), []);
});

test('a remove naming something the queue does not hold takes nothing', () => {
  /*
   * Measured on pr-19720: the CLI wrote one `remove` for content it had never written an
   * `enqueue` for. Taking the front instead put the head permanently off by one, and from then
   * on every dequeue took a phantom and left the real item waiting for ever.
   */
  assert.deepEqual(foldQueue([op('enqueue', 'mine'), op('remove', 'never queued here')]), ['mine']);
});

test('an unplaceable remove does not go on to eat the next dequeue\'s answer', () => {
  const queue = foldQueue([
    op('enqueue', 'mine'), op('remove', 'never queued here'), op('enqueue', 'theirs'), op('dequeue'),
  ]);

  // 'mine' was started on. Before, the stray remove dropped it and the dequeue dropped 'theirs',
  // leaving 'mine' - the one thing claude had already read - showing as queued.
  assert.deepEqual(queue, ['theirs']);
});

// ── Whose line is it ────────────────────────────────────────────────────────────────────────

test('a task notification and a system reminder are the CLI talking to itself', () => {
  assert.equal(isCliText(TASK), true);
  assert.equal(isCliText('<system-reminder>\nsomething\n</system-reminder>'), true);
  assert.equal(isCliText('submit the review'), false);
  assert.equal(isCliText(''), false);
});

test('a queued task notification is not a record of the person\'s prompt landing', () => {
  // It would otherwise be claimed by order against a message that genuinely never arrived, and
  // the view would stop saying the message had not arrived.
  assert.deepEqual(promptRecords([], null, [TASK], 1000), []);
  assert.deepEqual(promptRecords([], null, ['go on'], 1000), [{ key: promptKey('go on'), at: 1000 }]);
});

test('a message still in the queue is still unsent, whatever else the CLI queued beside it', () => {
  const pending = [{ text: 'submit the review', sentAt: 900 }];
  const left = reconcilePending(pending, {
    entries: [], hook: null, queue: [TASK], now: 1000,
  });

  assert.equal(left.length, 1);
});
