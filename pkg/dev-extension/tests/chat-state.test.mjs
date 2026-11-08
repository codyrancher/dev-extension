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
  parseEntries, deriveState, foldQueue, foldModel, promptRecords, isCliText, questionStep, chatAboutKey, isPreviewQuestion, paneAsk
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

/*
 * pr-222, 2026-11-06: a background task's notice was enqueued and let go of with no operation
 * written, so it sat at the front of the fold. The person's message was enqueued behind it,
 * dequeued, and answered - and stayed in the list as "in claude's queue" for the rest of the
 * session, because the dequeue took the phantom.
 */
const promptLine = (text) => ({ type: 'user', timestamp: '2026-11-06T02:46:55Z', message: { role: 'user', content: text } });
const turnEnd = () => ({ type: 'system', subtype: 'turn_duration', timestamp: '2026-11-06T02:48:11Z' });

test('a dequeue takes the item its turn started on, not a phantom in front of it', () => {
  const queue = foldQueue([
    op('enqueue', TASK),
    op('enqueue', 'Reduce every comment to be no more than 2 lines.'),
    op('dequeue'),
    turnEnd(),
    promptLine('Reduce every comment to be no more than 2 lines.'),
  ]);

  assert.deepEqual(queue, [TASK]);
});

test('a dequeue matches what the CLI queued for itself, which it writes down as meta', () => {
  // pr-1225, 2026-11-06: a /loop wakeup, recorded `isMeta: true, promptSource: 'system'`.
  const wakeup = 'Check on the PR 1225 review agents and continue the my-pr-full-review phases.';
  const queue = foldQueue([
    op('enqueue', TASK),
    op('enqueue', wakeup),
    op('dequeue'),
    { type: 'system', subtype: 'scheduled_task_fire', timestamp: '2026-11-06T21:58:00Z' },
    { ...promptLine(wakeup), isMeta: true, promptSource: 'system' },
  ]);

  assert.deepEqual(queue, [TASK]);
});

test('a dequeue whose prompt line has not been read yet still takes the front', () => {
  assert.deepEqual(foldQueue([op('enqueue', 'one'), op('enqueue', 'two'), op('dequeue')]), ['two']);
});

test('a dequeue matches through what the CLI does to a paste', () => {
  const sent = 'line one of a long message\nline two of it';
  const recorded = `<pasted_content id="9a3f">\n${ sent }\n</pasted_content id="9a3f">`;

  assert.deepEqual(foldQueue([op('enqueue', 'other'), op('enqueue', sent), op('dequeue'), promptLine(recorded)]), ['other']);
});

test('an idle conversation has nothing queued, whatever the fold was left holding', () => {
  const entries = [
    promptLine('first'),
    op('enqueue', 'Reduce every comment to be no more than 2 lines.'),
    turnEnd(),
  ];
  const state = deriveState({
    entries, hook: null, attached: true, alive: true, paneText: '', now: Date.parse('2026-11-06T03:00:00Z'),
  });

  assert.equal(state.phase, 'idle');
  assert.deepEqual(state.queue, []);
});

test('a working conversation keeps what is really waiting', () => {
  const entries = [
    promptLine('first'),
    op('enqueue', 'and then this'),
  ];
  const state = deriveState({
    entries, hook: null, attached: true, alive: true, paneText: '', now: Date.parse('2026-11-06T03:00:00Z'),
  });

  assert.equal(state.phase, 'working');
  assert.deepEqual(state.queue, ['and then this']);
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

// ── Which model and effort ran: read off real transcripts, field for field ─────────────────

let uuid = 0;
const stamped = (entry) => ({ uuid: `u${ ++uuid }`, timestamp: `2026-10-01T00:00:${ String(uuid % 60).padStart(2, '0') }Z`, ...entry });
const prompt = (text = 'hello') => stamped({ type: 'user', message: { role: 'user', content: text } });
const reply = (model, more = {}) => stamped({
  type: 'assistant', message: { role: 'assistant', model, content: [{ type: 'text', text: 'ok' }] }, ...more,
});
const synthetic = () => stamped({
  type: 'assistant', isApiErrorMessage: true, error: 'server_error', message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: 'API Error' }] },
});
const stdout = (text) => stamped({ type: 'user', message: { role: 'user', content: `<local-command-stdout>${ text }</local-command-stdout>` } });
const identity = (modelId, marketingName) => stamped({
  type: 'attachment', attachment: { type: 'model', identity: { modelId, marketingName, knowledgeCutoff: 'x' } },
});
const fallback = (originalModel, fallbackModel, direction = 'retry') => stamped({
  type: 'system', subtype: 'model_refusal_fallback', originalModel, fallbackModel, direction, trigger: 'refusal', retractedMessageUuids: [],
});

test('a reply says the model and effort, and a `perTurnEffort` of null does not hide its effort', () => {
  const state = foldModel([prompt(), reply('claude-opus-5-5', { effort: 'xhigh', perTurnEffort: null })]);

  assert.equal(state.model, 'claude-opus-5-5');
  assert.equal(state.effort, 'xhigh');
  assert.equal(state.modelFrom, 'reply');
});

test('deriveState carries the fold, whatever the phase', () => {
  const state = deriveState({ entries: [prompt(), reply('claude-fable-5-1', { effort: 'high' })] });

  assert.equal(state.phase, 'absent');
  assert.equal(state.model, 'claude-fable-5-1');
  assert.equal(state.effort, 'high');
});

test('a <synthetic> reply is not a model, even as the last line of the file', () => {
  const state = foldModel([prompt(), reply('claude-opus-5-5', { effort: 'high' }), synthetic()]);

  assert.equal(state.model, 'claude-opus-5-5');
  assert.equal(state.effort, 'high');
  assert.equal(foldModel([prompt(), synthetic()]).model, '');
});

test('an API error line is not a model, whatever it is stamped with', () => {
  const state = foldModel([reply('claude-opus-5', { effort: 'high' }), reply('claude-opus-4-8', { isApiErrorMessage: true })]);

  assert.equal(state.model, 'claude-opus-5');
});

test('a sidechain never speaks for the conversation', () => {
  const state = foldModel([
    prompt(),
    reply('claude-opus-5-5', { effort: 'high' }),
    reply('claude-sonnet-5', { effort: 'low', isSidechain: true }),
    identity('claude-sonnet-5', 'Sonnet 5'),
  ].map((entry, i) => (i === 3 ? { ...entry, isSidechain: true } : entry)));

  assert.equal(state.model, 'claude-opus-5-5');
  assert.equal(state.effort, 'high');
  assert.equal(state.modelName, '');
});

test('advisorModel is a different model and is not read', () => {
  assert.equal(foldModel([reply('claude-opus-5', { advisorModel: 'claude-opus-5-5' })]).model, 'claude-opus-5');
});

test('a real reply with no effort clears the last one, rather than keeping another model\'s', () => {
  const state = foldModel([reply('claude-opus-5', { effort: 'xhigh' }), reply('claude-fable-5')]);

  assert.equal(state.model, 'claude-fable-5');
  assert.equal(state.effort, '');
});

test('the fold says which model, and the same whatever the [1m] on any line says', () => {
  const on = foldModel([reply('claude-opus-5-5', { requestedModel: 'claude-opus-5-5[1m]' })]);
  const off = foldModel([reply('claude-opus-5-5', { requestedModel: 'claude-opus-5-5' })]);

  assert.equal(on.model, 'claude-opus-5-5');
  assert.equal(on.fallbackFrom, '', 'a suffix is not a different model');
  assert.equal(off.model, 'claude-opus-5-5');
  // So whether the 1 MiB first read reached the identity line cannot change the answer.
  const whole = foldModel([identity('claude-opus-5[1m]', 'Opus 5 (1M context)'), reply('claude-opus-5')]);

  assert.equal(whole.model, foldModel([reply('claude-opus-5')]).model);
});

test('the identity attachment covers the wait for the first reply', () => {
  const state = foldModel([prompt(), identity('claude-opus-5-5[1m]', 'Opus 5.5 (1M context)')]);

  assert.equal(state.model, 'claude-opus-5-5');
  assert.equal(state.modelName, 'Opus 5.5');
  assert.equal(state.modelFrom, 'identity');
  assert.equal(state.effort, '');
});

test('an identity naming the model already replying changes nothing', () => {
  const state = foldModel([
    reply('claude-opus-5', { requestedModel: 'claude-opus-5', effort: 'high' }),
    identity('claude-opus-5[1m]', 'Opus 5 (1M context)'),
  ]);

  assert.equal(state.model, 'claude-opus-5');
  assert.equal(state.modelFrom, 'reply');
  assert.equal(state.effort, 'high');
});

test('a marketing name for another model is dropped when a different one replies', () => {
  assert.equal(foldModel([identity('claude-opus-5', 'Opus 5'), reply('claude-fable-5-1')]).modelName, '');
});

test('/model is pending at once, in both printed forms, without touching what ran', () => {
  for (const text of ['Set model to `claude-opus-5[1m]`', 'Set model to claude-opus-5[1m]', 'Set model to \u001b[1mclaude-opus-5[1m]\u001b[22m', 'Set model to `claude-opus-5[1m]` and saved as your default for new sessions']) {
    const state = foldModel([prompt(), reply('claude-fable-5-1', { effort: 'high' }), stdout(text)]);

    assert.equal(state.pendingModel, 'claude-opus-5', text);
    assert.equal(state.model, 'claude-fable-5-1');
    assert.ok(state.modelMark);
    assert.equal(state.effortMark, '');
  }
});

test('the next real reply supersedes /model, and an unmatched one after a new prompt does too', () => {
  const said = [prompt(), reply('claude-fable-5-1'), stdout('Set model to `claude-opus-5-5`')];
  const matched = foldModel([...said, prompt('next'), reply('claude-opus-5-5', { effort: 'high' })]);
  const other = foldModel([...said, prompt('next'), reply('claude-opus-4-8', { effort: 'high' })]);

  assert.equal(matched.pendingModel, '');
  assert.equal(matched.model, 'claude-opus-5-5');
  assert.equal(other.pendingModel, '');
  assert.equal(other.model, 'claude-opus-4-8');
});

test('/model mid-turn stays pending through the old model\'s remaining replies', () => {
  const state = foldModel([
    prompt(), reply('claude-fable-5-1'), stdout('Set model to `claude-opus-5-5`'), reply('claude-fable-5-1'),
  ]);

  assert.equal(state.pendingModel, 'claude-opus-5-5');
  assert.equal(state.model, 'claude-fable-5-1');
});

test('prose, a quote of the command and other commands are not a /model answer', () => {
  assert.equal(foldModel([stdout('Set model to Sonnet')]).pendingModel, '');
  assert.equal(foldModel([stdout('Current model: `claude-opus-5`')]).pendingModel, '');
  assert.equal(foldModel([prompt('why did it say <local-command-stdout>Set model to `claude-opus-5`</local-command-stdout>?')]).pendingModel, '');
});

test('choosing the model already running leaves nothing pending', () => {
  const state = foldModel([reply('claude-opus-5-5'), stdout('Kept model as `claude-opus-5-5`')]);

  assert.equal(state.pendingModel, '');
});

test('/effort is pending at once, and the next reply settles it', () => {
  const said = [prompt(), reply('claude-opus-5', { effort: 'high' }), stdout('Set effort level to medium (this session only): moderate reasoning')];

  assert.equal(foldModel(said).pendingEffort, 'medium');
  assert.equal(foldModel(said).effort, 'high');
  const settled = foldModel([...said, prompt('next'), reply('claude-opus-5', { effort: 'medium' })]);

  assert.equal(settled.pendingEffort, '');
  assert.equal(settled.effort, 'medium');
  // Refused by a cap or an env var, claude's own next reply is the truth either way.
  assert.equal(foldModel([...said, prompt('next'), reply('claude-opus-5', { effort: 'high' })]).pendingEffort, '');
});

test('/effort auto takes over from whatever was showing or pending', () => {
  const opening = [prompt(), reply('claude-opus-5', { effort: 'high' })];

  assert.equal(foldModel([...opening, stdout('Set effort level to auto')]).pendingEffort, 'auto');
  const after = foldModel([...opening, stdout('Set effort level to xhigh'), stdout('Set effort level to auto')]);

  assert.equal(after.pendingEffort, 'auto');
  assert.equal(foldModel([...opening, stdout('Set effort level to auto'), prompt('next'), reply('claude-opus-5', { effort: 'medium' })]).pendingEffort, '');
});

test('an older /model naming an effort sets that as well', () => {
  const state = foldModel([prompt(), reply('claude-opus-5', { effort: 'high' }), stdout('Set model to `claude-opus-5-5` with `max` effort')]);

  assert.equal(state.pendingModel, 'claude-opus-5-5');
  assert.equal(state.pendingEffort, 'max');
  assert.equal(foldModel([prompt(), reply('claude-opus-5', { effort: 'high' }), stdout('Set model to claude-opus-5-5 with max effort')]).pendingEffort, 'max');
});

test('/effort answers that name no level in force set nothing', () => {
  assert.equal(foldModel([stdout('Not applied: CLAUDE_CODE_EFFORT_LEVEL=high overrides this session')]).pendingEffort, '');
  assert.equal(foldModel([stdout('Effort \'max\' exceeds the cap for this model; set to \'xhigh\' instead')]).pendingEffort, 'xhigh');
});

test('a fallback model is what ran, and says what it fell back from', () => {
  const state = foldModel([
    prompt(), reply('claude-opus-5', { requestedModel: 'claude-opus-5[1m]' }),
    fallback('claude-opus-5[1m]', 'claude-opus-4-8'),
  ]);

  assert.equal(state.model, 'claude-opus-4-8');
  assert.equal(state.fallbackFrom, 'claude-opus-5');
  const after = foldModel([fallback('claude-opus-5[1m]', 'claude-opus-4-8'), reply('claude-opus-4-8', { effort: 'high' })]);

  assert.equal(after.model, 'claude-opus-4-8');
  assert.equal(after.fallbackFrom, 'claude-opus-5');
});

test('a reply served by something other than requested shows what served it', () => {
  const state = foldModel([reply('claude-opus-4-8', { requestedModel: 'claude-opus-5[1m]' })]);

  assert.equal(state.model, 'claude-opus-4-8');
  assert.equal(state.fallbackFrom, 'claude-opus-5');
});

test('going back to the original model, or choosing another, ends the fallback note', () => {
  const fell = [fallback('claude-opus-5', 'claude-opus-4-8'), reply('claude-opus-4-8')];

  assert.equal(foldModel([...fell, reply('claude-opus-5')]).fallbackFrom, '');
  assert.equal(foldModel([...fell, stdout('Set model to `claude-fable-5-1`')]).fallbackFrom, '');
});

test('a fallback note ends as soon as the model moves on, however it moved', () => {
  const fell = [reply('claude-fable-5'), fallback('claude-fable-5', 'claude-opus-5')];

  // A resume on a new default: an identity, then a reply, with no /model answer anywhere.
  assert.equal(foldModel([...fell, identity('claude-opus-5-5', 'Opus 5.5')]).fallbackFrom, '');
  assert.equal(foldModel([...fell, prompt(), reply('claude-opus-5-5', { requestedModel: 'claude-opus-5-5' })]).fallbackFrom, '');
  // An older CLI's prose, which names no id, then a reply from what it chose.
  assert.equal(foldModel([...fell, stdout('Set model to Sonnet'), prompt(), reply('claude-sonnet-5')]).fallbackFrom, '');
  // Still on the model it fell back to: still true.
  assert.equal(foldModel([...fell, reply('claude-opus-5')]).fallbackFrom, 'claude-fable-5');
  assert.equal(foldModel([...fell, identity('claude-opus-5', 'Opus 5')]).fallbackFrom, 'claude-fable-5');
  // And the CLI saying that is now what is requested ends it too.
  assert.equal(foldModel([...fell, reply('claude-opus-5', { requestedModel: 'claude-opus-5' })]).fallbackFrom, '');
});

test('the prompt running is exported, ahead of the one last answered', () => {
  const first = prompt();
  const second = prompt('next');
  const state = foldModel([first, reply('claude-opus-5'), second]);

  assert.equal(state.promptMark, second.uuid);
  assert.equal(state.answeredMark, first.uuid);
});

test('stdout is credited to the command named above it', () => {
  const name = (command) => stamped({ type: 'user', message: { role: 'user', content: `<command-name>/${ command }</command-name>` } });
  const opening = [prompt(), reply('claude-opus-5', { effort: 'high' })];

  const failed = foldModel([...opening, name('effort'), stdout('Not applied: env overrides this session')]);

  assert.ok(failed.effortMark);
  assert.equal(failed.modelMark, '');
  const cost = foldModel([...opening, name('cost'), stdout('Total cost: $1')]);

  assert.equal(cost.modelMark, '');
  assert.equal(cost.effortMark, '');
  // A command's name is one line before its answer, not an answer of its own.
  assert.equal(foldModel([...opening, name('model')]).modelMark, '');
});

test('a tail with no reply in it has no running model, rather than a wrong one', () => {
  const state = foldModel([prompt()]);

  assert.equal(state.model, '');
  assert.equal(state.effort, '');
});

test('the marks a held choice is judged against only move for a command or an answered prompt', () => {
  const first = prompt();
  const before = foldModel([first, reply('claude-opus-5')]);
  const during = foldModel([first, reply('claude-opus-5'), reply('claude-opus-5')]);
  const answered = foldModel([first, reply('claude-opus-5'), prompt('next'), reply('claude-opus-5')]);

  assert.equal(during.answeredMark, before.answeredMark);
  assert.notEqual(answered.answeredMark, before.answeredMark);
});

test('toolGroup folds two or more calls and says what is running and what failed', async() => {
  const { toolGroup } = await import('../chat-state.mjs');

  assert.equal(toolGroup([]).grouped, false);
  assert.equal(toolGroup([{ id: 'a', result: 'ok' }]).grouped, false);

  const g = toolGroup([
    { id: 'a', result: 'ok', images: ['data:image/png;base64,x'] },
    { id: 'b', result: 'boom', resultIsError: true },
    { id: 'c' },
  ]);

  assert.equal(g.grouped, true);
  assert.equal(g.label, '3 commands');
  assert.equal(g.failed, 1);
  assert.equal(g.running.id, 'c');
  assert.deepEqual(g.images, ['data:image/png;base64,x']);
  assert.equal(toolGroup([{ id: 'a', result: '' }, { id: 'b', result: 'x' }]).running, null);
  assert.equal(toolGroup(null).count, 0);
});


// ── Where the CLI's question dialog is ──────────────────────────────────────────────────────

/*
 * The shape of 588788ec, 2026-11-04: two questions, both answered with option 1 - the second by
 * the Enter the chat pressed after the first one's digit, because the dialog had already moved.
 */
const TWO = {
  id: 'toolu_1',
  questions: [
    {
      question: 'The 19 issues moved to Next Up today each have a codyrancher comment with a reproduction video. For the Next Up check, how should those count?',
      header: 'Steps',
      options: [{ label: 'Add steps to our comments (Recommended)' }, { label: 'Video is enough' }, { label: 'Strict: move them back' }],
    },
    {
      question: 'Which Next Up issues should the check cover?',
      header: 'Scope',
      options: [{ label: 'Only small-scope (mixin)' }, { label: 'All of Next Up' }],
    },
  ],
};

const paneOn = (q) => [
  '● Here is what I found.',
  '───────────────────────────────────────────',
  '←  ☒ Steps  ☐ Scope  ✔ Submit  →',
  '',
  q.question,
  '',
  ...q.options.map((o, i) => `${ i === 0 ? '❯' : ' ' } ${ i + 1 }. ${ o.label }`),
  `  ${ q.options.length + 1 }. Type something.`,
  '───────────────────────────────────────────',
  `  ${ q.options.length + 2 }. Chat about this`,
  '',
  'Enter to select · Tab/Arrow keys to navigate · Esc to cancel',
].join('\n');

test('questionStep follows the dialog to the question it is on', () => {
  assert.deepEqual(questionStep(TWO, paneOn(TWO.questions[0])), { index: 0, review: false, seen: true });
  assert.deepEqual(questionStep(TWO, paneOn(TWO.questions[1])), { index: 1, review: false, seen: true });
});

test('questionStep reads a question the pane has wrapped across lines', () => {
  const wrapped = paneOn(TWO.questions[0]).replace('reproduction video. For', 'reproduction\nvideo. For');

  assert.equal(questionStep(TWO, wrapped).index, 0);
});

test('questionStep knows the review screen after the last question', () => {
  const pane = [
    '←  ☒ Steps  ☒ Scope  ✔ Submit  →',
    'Review your answers',
    ' ● Which Next Up issues should the check cover?',
    '   → All of Next Up',
    'Ready to submit your answers?',
    '❯ 1. Submit answers',
    '  2. Cancel',
  ].join('\n');

  assert.deepEqual(questionStep(TWO, pane), { index: 2, review: true, seen: true });
});

test('questionStep says when the pane shows none of it', () => {
  assert.deepEqual(questionStep(TWO, '❯ \n? for shortcuts'), { index: 0, review: false, seen: false });
  assert.deepEqual(questionStep(null, ''), { index: 0, review: false, seen: false });
});

test('a single question has no review screen to find', () => {
  const one = { id: 't', questions: [TWO.questions[1]] };

  assert.equal(questionStep(one, 'Review your answers').review, false);
});

test('a single multi-select question does end on one', () => {
  const one = { id: 't', questions: [{ ...TWO.questions[1], multiSelect: true }] };

  assert.deepEqual(questionStep(one, 'Review your answers\nReady to submit your answers?'), { index: 1, review: true, seen: true });
});

test('Chat about this is the row after Other, and a preview question is its own view', () => {
  assert.equal(chatAboutKey(TWO.questions[0]), '5');
  assert.equal(chatAboutKey(TWO.questions[1]), '4');
  assert.equal(isPreviewQuestion(TWO.questions[0]), false);
  assert.equal(isPreviewQuestion({ options: [{ label: 'a', preview: 'x' }, { label: 'b' }] }), true);
  assert.equal(isPreviewQuestion({ multiSelect: true, options: [{ label: 'a', preview: 'x' }, { label: 'b' }] }), false);
});


// ── The question dialog read off the pane ───────────────────────────────────────────────────

/*
 * As the live run of 2026-11-08 drew it, with the transcript not yet holding the call: the end
 * of claude's message, the dialog's rule, its tab strip, the question, the rows.
 */
const TWO_ON_PANE = [
  '● I will ask you now. When you have answered I will reply with the two answers,',
  '  separated by a comma.',
  '────────────────────────────────────────────────────────',
  '←  ☐ Color  ☐ Size  ✔ Submit  →',
  '',
  'Which color do you want?',
  '',
  '❯ 1. Red',
  '  2. Green',
  '  3. Blue',
  '  4. Type something.',
  '────────────────────────────────────────────────────────',
  '  5. Chat about this',
  '',
  'Enter to select · Tab/Arrow keys to navigate · Esc to cancel',
].join('\n');

test('paneAsk knows the question dialog by its own rows, and leaves those rows out', () => {
  const ask = paneAsk(TWO_ON_PANE);

  assert.ok(ask);
  assert.equal(ask.review, false);
  assert.equal(ask.prompt, 'Which color do you want?');
  assert.deepEqual(ask.options.map((o) => `${ o.key } ${ o.label }`), ['1 Red', '2 Green', '3 Blue']);
  assert.equal(ask.chatKey, '5');
  assert.equal(ask.otherKey, '4');
  assert.equal(ask.multi, false);
  assert.deepEqual([ask.at, ask.of], [1, 2]);
});

test('paneAsk counts an answered tab', () => {
  const second = TWO_ON_PANE.replace('☐ Color', '☒ Color').replace('Which color do you want?', 'Which size do you want?')
    .replace('1. Red', '1. Small').replace('2. Green', '2. Large').replace('  3. Blue\n', '')
    .replace('4. Type something.', '3. Type something.').replace('5. Chat about this', '4. Chat about this');
  const ask = paneAsk(second);

  assert.deepEqual(ask.options.map((o) => o.label), ['Small', 'Large']);
  assert.equal(ask.chatKey, '4');
  assert.deepEqual([ask.at, ask.of], [2, 2]);
});

test('paneAsk knows the review screen', () => {
  const review = [
    '←  ☒ Color  ☒ Size  ✔ Submit  →',
    'Review your answers',
    ' ● Which color do you want?',
    '   → Green',
    ' ● Which size do you want?',
    '   → Small',
    'Ready to submit your answers?',
    '❯ 1. Submit answers',
    '  2. Cancel',
  ].join('\n');

  assert.equal(paneAsk(review).review, true);
});

test('paneAsk reads a multi-select by its boxes', () => {
  const pane = [
    'Which toppings? (Select all that apply)',
    '❯ 1. ☒ Cheese',
    '  2. ☐ Ham',
    '  3. ☐ Olives',
    '  4. Type something',
    '  5. Chat about this',
  ].join('\n');
  const ask = paneAsk(pane);

  assert.equal(ask.multi, true);
  assert.deepEqual(ask.options.map((o) => [o.label, o.selected]), [['Cheese', true], ['Ham', false], ['Olives', false]]);
});

test('paneAsk leaves every other numbered list alone', () => {
  assert.equal(paneAsk('Do you want to proceed?\n❯ 1. Yes\n  2. No'), null);
  assert.equal(paneAsk('1: Bad    2: Fine   3: Good   0: Dismiss'), null);
  assert.equal(paneAsk(''), null);
});
