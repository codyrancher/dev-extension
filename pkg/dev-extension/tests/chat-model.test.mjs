// How a chat names the model and effort it is on. The ids are the ones real transcripts carry.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  configuredEffort, modelEffortsFrom, modelFamily, modelInfo, modelName, pickedChoice, settlePicked,
} from '../chat-model.mjs';
import { foldModel, deriveState } from '../chat-state.mjs';
import { parseOptions } from '../chat-options.ts';

test('modelName: id to name and version', () => {
  const table = [
    ['claude-opus-5-5', 'Opus 5.5'],
    ['claude-opus-5-5[1m]', 'Opus 5.5'],
    ['claude-opus-5', 'Opus 5'],
    ['claude-opus-5[1m]', 'Opus 5'],
    ['claude-opus-4-8', 'Opus 4.8'],
    ['claude-fable-5-1', 'Fable 5.1'],
    ['claude-fable-5', 'Fable 5'],
    ['claude-sonnet-5', 'Sonnet 5'],
    // A date is not a version.
    ['claude-haiku-4-5-20251001', 'Haiku 4.5'],
    ['claude-opus-4-20250514', 'Opus 4'],
    // An alias names no version, so none is invented.
    ['opus', 'opus'],
    ['opus[1m]', 'opus'],
    ['fable', 'fable'],
    // Shapes this does not read come back exactly as they came.
    ['claude-3-5-sonnet-20241022', 'claude-3-5-sonnet-20241022'],
    ['us.anthropic.claude-opus-4-8-v1:0', 'us.anthropic.claude-opus-4-8-v1:0'],
    ['gemini-4-argon', 'gemini-4-argon'],
    ['gpt-5[1m]', 'gpt-5[1m]'],
    ['<synthetic>', ''],
    ['', ''],
  ];

  for (const [id, name] of table) {
    assert.equal(modelName(id), name, id);
  }
  assert.equal(modelName(undefined), '');
});

test('modelFamily: the alias an id belongs under, or nothing', () => {
  const table = [
    ['claude-opus-5-5[1m]', 'opus'],
    ['claude-opus-5', 'opus'],
    ['claude-fable-5-1', 'fable'],
    ['claude-haiku-4-5-20251001', 'haiku'],
    ['claude-3-5-sonnet-20241022', 'sonnet'],
    ['opus[1m]', 'opus'],
    ['sonnet', 'sonnet'],
    ['us.anthropic.claude-opus-4-8-v1:0', ''],
    ['', ''],
  ];

  for (const [id, family] of table) {
    assert.equal(modelFamily(id), family, id);
  }
});

const settings = {
  read: true, model: 'opus[1m]', modelSource: 'settings', effort: 'high', modelEfforts: { 'claude-opus-5-5': 'medium' },
};

test('the running model wins, whatever settings say, and is not marked', () => {
  const info = modelInfo({ state: { model: 'claude-opus-5-5', modelFrom: 'reply', effort: 'xhigh' }, options: settings });

  assert.equal(info.label, 'Opus 5.5 · xhigh');
  assert.equal(info.source, 'running');
  assert.equal(info.family, 'opus');
  assert.equal(info.effort, 'xhigh');
  assert.match(info.title, /claude-opus-5-5/);
  assert.match(info.title, /xhigh/);
  // What settings say is described as the next session's, never as this one's.
  assert.ok(info.notes.some((note) => /New sessions start on opus\[1m\], set by settings/.test(note)));
  assert.equal(info.status, 'Running claude-opus-5-5.');
  // Joined with the next sentence on the menu and in the title.
  assert.match(`${ info.status } ${ info.notes.join(' ') }`, /^Running claude-opus-5-5\. New sessions start on opus\[1m\], set by settings\.$/);
  assert.match(info.title, /^Running claude-opus-5-5\. Effort xhigh, as recorded on the last reply\. /);
});

test('the context window is not reported: a suffix is no evidence of it either way', () => {
  for (const model of ['claude-opus-5-5[1m]', 'claude-opus-5-5']) {
    assert.equal(modelInfo({ state: { model, modelFrom: 'reply', effort: 'high' } }).label, 'Opus 5.5 · high');
  }
  assert.equal(modelInfo({ options: { model: 'opus[1m]', effort: 'high' } }).label, '~opus · ~high');
});

test('before the first reply it is what is configured, marked, with no version from an alias', () => {
  const info = modelInfo({ state: {}, options: settings });

  assert.equal(info.label, '~opus · ~high');
  assert.equal(info.spelled, 'opus · high (from settings)');
  assert.equal(info.source, 'configured');
  assert.equal(info.effortSource, 'configured');
  assert.equal(info.family, 'opus');
  assert.match(info.title, /set by settings/);
  assert.match(info.status, /Not confirmed by the transcript read so far/);
  assert.doesNotMatch(info.title, /first reply/, 'a reloaded chat with many replies has had its first');
  assert.deepEqual(info.notes, []);
});

test('with claude naming the model and no reply yet, the model is known and the effort is not', () => {
  const info = modelInfo({ state: { model: 'claude-opus-5-5', modelName: 'Opus 5.5', modelFrom: 'identity' }, options: settings });

  assert.equal(info.label, 'Opus 5.5 · ~medium');
  assert.equal(info.status, 'On claude-opus-5-5, no reply read yet.');
  assert.equal(info.spelled, 'Opus 5.5 · medium (effort from settings)');
});

test('effort falls back from the reply to modelSettings to effortLevel to nothing', () => {
  const reply = { model: 'claude-opus-5-5', modelFrom: 'reply' };

  assert.equal(modelInfo({ state: { ...reply, effort: 'low' }, options: settings }).effort, 'low');
  assert.equal(modelInfo({ state: reply, options: settings }).effort, 'medium');
  assert.equal(modelInfo({ state: { model: 'claude-opus-5', modelFrom: 'reply' }, options: settings }).effort, 'high');
  const none = modelInfo({ state: reply, options: { ...settings, effort: '', modelEfforts: {} } });

  assert.equal(none.effort, '');
  assert.equal(none.effortText, '');
  assert.equal(none.label, 'Opus 5.5');
  assert.match(none.title, /Effort not recorded/);
});

test('configuredEffort: a [1m] id finds its base id, an alias finds only the general level', () => {
  assert.equal(configuredEffort(settings, 'claude-opus-5-5[1m]'), 'medium');
  assert.equal(configuredEffort(settings, 'opus[1m]'), 'high');
  assert.equal(configuredEffort({}, 'opus'), '');
});

test('modelEffortsFrom reads the settings shape and survives a bad line', () => {
  assert.deepEqual(modelEffortsFrom('{"claude-opus-5":{"effortLevel":"high"},"x":{"other":1},"y":null}'), { 'claude-opus-5': 'high' });
  assert.deepEqual(modelEffortsFrom(''), {});
  assert.deepEqual(modelEffortsFrom('not json'), {});
});

test('a pending choice shows at once, marked, and takes the tick', () => {
  const state = {
    model: 'claude-fable-5-1', modelFrom: 'reply', effort: 'high', pendingModel: 'claude-opus-5-5[1m]', pendingEffort: 'medium',
  };
  const info = modelInfo({ state, options: settings });

  assert.equal(info.label, '~Opus 5.5 · ~medium');
  assert.equal(info.family, 'opus');
  assert.equal(info.effort, 'medium');
  assert.equal(info.source, 'pending');
  assert.match(info.status, /next reply.*claude-fable-5-1/);
});

test('a choice just made beats the fold until the transcript answers', () => {
  const state = {
    model: 'claude-fable-5-1', modelFrom: 'reply', effort: 'high', modelMark: 'c1', effortMark: 'e1', promptMark: 'p1', answeredMark: 'p1',
  };
  let picked = { model: pickedChoice('model', 'opus', state), effort: pickedChoice('effort', 'low', state) };

  assert.equal(modelInfo({ state, picked }).label, '~opus · ~low');

  // A poll with nothing new, and more replies to the prompt that was already running.
  picked = settlePicked(picked, { ...state });
  assert.equal(modelInfo({ state, picked }).family, 'opus');
  const same = settlePicked(picked, state);

  assert.equal(same, picked, 'nothing changed is not a reactive write');

  // The command answered: the fold is the better source now.
  const answered = {
    ...state, modelMark: 'c2', effortMark: 'e2', pendingModel: 'claude-opus-5-5',
  };

  picked = settlePicked(picked, answered);
  assert.deepEqual(picked, { model: null, effort: null });
  // The level was the old model's, so it is carried and said to be.
  assert.equal(modelInfo({ state: answered, picked }).label, '~Opus 5.5 · ~high');
});

test('a choice claude never answered ends at the next reply to a newer prompt', () => {
  const state = {
    model: 'claude-fable-5-1', modelFrom: 'reply', effort: 'high', promptMark: 'p1', answeredMark: 'p1',
  };
  const picked = { model: pickedChoice('model', 'opus', state), effort: null };
  const next = { ...state, promptMark: 'p2', answeredMark: 'p2' };

  assert.deepEqual(settlePicked(picked, next), { model: null, effort: null });
  assert.equal(settlePicked(null, next), null);
});

test('a fallback is on the title, with the model that served it on the label', () => {
  const info = modelInfo({ state: { model: 'claude-opus-4-8', modelFrom: 'reply', effort: 'high', fallbackFrom: 'claude-opus-5[1m]' } });

  assert.equal(info.label, 'Opus 4.8 · high');
  assert.match(info.title, /Fell back from claude-opus-5\[1m\]/);
});

test('nothing known draws nothing, and no input at all is an answer rather than a throw', () => {
  const info = modelInfo();

  assert.equal(info.known, false);
  assert.equal(info.label, '');
  assert.equal(info.title, '');
  assert.equal(info.family, '');
});

test('a choice made between a prompt and its first reply survives that reply', () => {
  const before = { model: 'claude-opus-5-5', modelFrom: 'reply', effort: 'high', promptMark: 'p2', answeredMark: 'p1' };
  const picked = { model: pickedChoice('model', 'sonnet', before), effort: null };
  // The old model's first reply to the prompt already running.
  const during = { ...before, answeredMark: 'p2' };

  assert.equal(settlePicked(picked, during), picked);
  assert.equal(modelInfo({ state: during, picked: settlePicked(picked, during) }).source, 'pending');
  // A reply to the prompt after it is the truth.
  assert.deepEqual(settlePicked(picked, { ...during, promptMark: 'p3', answeredMark: 'p3' }), { model: null, effort: null });
});

test('one command answering does not retire the other command\'s choice', () => {
  const state = { modelMark: 'm1', effortMark: 'e1', promptMark: 'p1', answeredMark: 'p1' };
  const picked = { model: pickedChoice('model', 'sonnet', state), effort: pickedChoice('effort', 'low', state) };
  const settled = settlePicked(picked, { ...state, modelMark: 'm2' });

  assert.equal(settled.model, null);
  assert.equal(settled.effort.value, 'low');
});

test('an unrelated command printing something retires nothing, read off real line shapes', () => {
  const line = (uuid, content) => ({ uuid, type: 'user', message: { role: 'user', content } });
  const opening = [
    { uuid: 'p', type: 'user', message: { role: 'user', content: 'go' } },
    { uuid: 'r', type: 'assistant', effort: 'high', message: { role: 'assistant', model: 'claude-opus-5-5', content: [] } },
  ];
  const state = foldModel(opening);
  const picked = { model: pickedChoice('model', 'sonnet', state), effort: pickedChoice('effort', 'low', state) };
  const cost = foldModel([
    ...opening,
    line('c', '<command-name>/cost</command-name><command-message>cost</command-message>'),
    line('o', '<local-command-stdout>Total cost: $1</local-command-stdout>'),
  ]);

  assert.equal(settlePicked(picked, cost), picked);

  // A /model that failed still answers /model, and only /model.
  const failed = foldModel([
    ...opening,
    line('c', '<command-name>/model</command-name>'),
    line('o', '<local-command-stderr>Model not found</local-command-stderr>'),
  ]);
  const settled = settlePicked(picked, failed);

  assert.equal(settled.model, null);
  assert.equal(settled.effort, picked.effort);
});

test('a pending model does not wear the running model\'s effort as if confirmed', () => {
  const state = { model: 'claude-opus-5-5', modelFrom: 'reply', effort: 'xhigh', pendingModel: 'claude-sonnet-5' };
  const given = modelInfo({ state, options: { modelEfforts: { 'claude-sonnet-5': 'low' } } });

  assert.equal(given.label, '~Sonnet 5 · ~low');
  assert.equal(given.effort, 'low');
  assert.equal(given.effortSource, 'configured');
  const carried = modelInfo({ state });

  assert.equal(carried.label, '~Sonnet 5 · ~xhigh');
  assert.equal(carried.effortSource, 'carried');
  assert.match(carried.title, /carried over from the last reply, not confirmed/);
  // A pick of the same model keeps the level it has.
  assert.equal(modelInfo({ state: { ...state, pendingModel: 'claude-opus-5-5' } }).effortSource, 'running');
});

test('with no process, the last model is said to be the last, not running', () => {
  const entries = [
    { uuid: 'p', type: 'user', message: { role: 'user', content: 'go' } },
    { uuid: 'r', type: 'assistant', effort: 'high', message: { role: 'assistant', model: 'claude-opus-5-5', content: [] } },
  ];

  for (const input of [{ attached: false, alive: false }, { attached: true, alive: false }]) {
    const state = deriveState({ entries, ...input });

    assert.ok(['absent', 'gone'].includes(state.phase));
    const info = modelInfo({ state });

    assert.equal(info.source, 'last');
    assert.equal(info.label, '~Opus 5.5 · ~high');
    assert.equal(info.spelled, 'Opus 5.5 · high (last run)');
    assert.equal(info.status, 'Last ran claude-opus-5-5. Nothing is running now.');
    assert.doesNotMatch(info.title, /Running/);
  }
  assert.equal(modelInfo({ state: deriveState({ entries, attached: true, alive: true }) }).source, 'running');
});

test('"Last reply used" is only said of a reply', () => {
  const named = modelInfo({
    state: { model: 'claude-opus-5-5', modelFrom: 'identity' }, picked: { model: pickedChoice('model', 'fable', {}), effort: null },
  });

  assert.equal(named.status, 'fable from the next reply. On claude-opus-5-5 until then.');
  const replied = modelInfo({ state: { model: 'claude-opus-5-5', modelFrom: 'reply', pendingModel: 'claude-fable-5-1' } });

  assert.equal(replied.status, 'claude-fable-5-1 from the next reply. Last reply used claude-opus-5-5.');
});

test('a model that records no effort, in a file where others did, gets none from settings', () => {
  const haiku = { model: 'claude-haiku-4-5-20251001', modelFrom: 'reply', effort: '' };

  // A CLI too old to stamp one: settings are all there is, and marked.
  assert.equal(modelInfo({ state: haiku, options: { effort: 'high' } }).label, 'Haiku 4.5 · ~high');
  // Replies here did carry one, so this one has none.
  const none = modelInfo({ state: { ...haiku, effortSeen: true }, options: { effort: 'high' } });

  assert.equal(none.label, 'Haiku 4.5');
  assert.equal(none.effort, '');
  assert.equal(none.effortSource, '');
  assert.equal(foldModel([
    { type: 'assistant', effort: 'high', message: { model: 'claude-opus-5-5', content: [] } },
    { type: 'assistant', message: { model: 'claude-haiku-4-5-20251001', content: [] } },
  ]).effortSeen, true);
});

test('claude\'s own name wins for an id parsing cannot read', () => {
  const state = { model: 'claude-new-shape', modelName: 'Grand 7', modelFrom: 'identity', effort: 'high', phase: 'idle' };

  assert.equal(modelInfo({ state }).modelText, 'Grand 7');
  // And is not borrowed for a model that is only pending.
  assert.equal(modelInfo({ state: { ...state, pendingModel: 'claude-sonnet-5' } }).modelText, '~Sonnet 5');
});

test('the accessible name starts with the control and the visible text', () => {
  const info = modelInfo({ state: { model: 'claude-opus-5-5', modelFrom: 'reply', effort: 'high' } });

  assert.match(info.spoken, /^Model: Opus 5\.5 · high\. Running claude-opus-5-5\./);
  assert.equal(modelInfo().spoken, '');
});

test('read-only surfaces say in words what a ~ would mean', () => {
  const opus = { model: 'claude-opus-5-5', modelFrom: 'reply', effort: 'high' };

  assert.equal(modelInfo({ state: opus }).spelled, 'Opus 5.5 · high');
  assert.equal(modelInfo({ state: { ...opus, pendingEffort: 'low' } }).spelled, 'Opus 5.5 · low (effort from the next reply)');
  assert.equal(modelInfo({ state: { ...opus, pendingModel: 'claude-sonnet-5' } }).spelled, 'Sonnet 5 · high (from the next reply)');
  assert.equal(modelInfo().spelled, '');

  for (const file of ['components/focus/FocusChatBar.vue', 'components/focus/InlineChat.vue']) {
    const source = readFileSync(new URL(`../${ file }`, import.meta.url), 'utf8');

    assert.match(source, /\{\{ modelInfo\.spelled \}\}/, file);
    assert.doesNotMatch(source, /\{\{ modelInfo\.label \}\}/, file);
  }
});

test('the pill draws modelInfo, not settings, which is the bug this exists for', () => {
  const source = readFileSync(new URL('../components/ChatPane.vue', import.meta.url), 'utf8');
  const pill = source.slice(source.indexOf('mc-chat__pill mc-chat__pill--model'), source.indexOf('class="mc-chat__chev"'));

  assert.match(pill, /modelInfo\.modelText/);
  assert.match(pill, /modelInfo\.effortText/);
  assert.match(pill, /modelInfo\.spoken/);
  assert.doesNotMatch(pill, /options\.(model|effort)\b/);
  assert.match(source, /value === modelInfo\.family/);
  assert.match(source, /value === modelInfo\.effort\b/);
  // The menu says why it has no choices rather than being empty.
  assert.match(source, /options\.failed \?/);
});

test('parseOptions reads the exec\'s sections, and says when it did not finish', () => {
  const help = [
    '  --model <model>   Model for the current session. Alias (e.g. "opus" or "sonnet").',
    '  --effort <level>  Effort level (low, medium, high)',
  ].join('\n');
  const out = [
    '@@HELP', help, '@@ARGV', 'claude --model sonnet --resume x', '@@ENV', '', '@@FILES',
    'opus[1m]', '', 'high', '{"claude-opus-5-5":{"effortLevel":"medium"}}', '@@END',
  ].join('\n');
  const parsed = parseOptions(out);

  assert.equal(parsed.read, true);
  assert.equal(parsed.model, 'sonnet');
  assert.equal(parsed.modelSource, 'argv');
  assert.equal(parsed.effort, 'high');
  assert.deepEqual(parsed.modelEfforts, { 'claude-opus-5-5': 'medium' });
  assert.deepEqual(parsed.efforts, ['low', 'medium', 'high']);
  const fromSettings = parseOptions(out.replace('claude --model sonnet --resume x', ''));

  assert.equal(fromSettings.model, 'opus[1m]');
  assert.equal(parseOptions(''), null);
  assert.equal(parseOptions('@@HELP\nhalf a read'), null);
});

// The composable needs a pod and Vue, so these pin the wiring by its source. They catch it being
// removed, not it misbehaving.
test('the composable\'s wiring: guards, retry and the walk back for a reply', () => {
  const source = readFileSync(new URL('../chat-conversation.ts', import.meta.url), 'utf8');
  const body = (from, to) => source.slice(source.indexOf(from), source.indexOf(to, source.indexOf(from)));
  const read = body('async function readOptions()', 'async function readMcp()');
  const apply = body('async function applyOption(', 'async function openManager(');
  const seek = body('async function seekModel()', '\n  }\n');
  const pane = readFileSync(new URL('../components/ChatPane.vue', import.meta.url), 'utf8');

  assert.match(read, /const conversation = paneId\.value;[\s\S]*await run[\s\S]*paneId\.value !== conversation[\s\S]*parseOptions\(out\)/);
  assert.match(read, /failed: true/);
  assert.match(apply, /await start\(\);\s*[\s\S]{0,200}paneId\.value !== conversation[\s\S]*await say\(/);
  assert.match(apply, /catch[\s\S]*paneId\.value === conversation[\s\S]*\[kind\]: null/);
  assert.doesNotMatch(apply, /picked\.value = before/);
  assert.match(seek, /seekingModelIn === at/);
  assert.match(seek, /page < MODEL_SEEK_PAGES/);
  assert.match(source, /settlePicked\(picked\.value, state\.value\);\s*seekModel\(\);/);
  assert.match(pane, /this\.options\.failed && !this\.options\.read[\s\S]{0,60}this\.readOptions\(\)/);
});
