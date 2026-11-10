// Which automations an event sets off, and the constraint that stopped the ones it did not.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  evaluateEvent, nameMatches, conditionLines, conditionScope, fillTemplate, cronDueAt, cronFields, shellQuote, envFile, scriptWrapper, actionOf, exitNote,
} from '../dev-api/automation-rules.mjs';

const EVENT = {
  id:        'gh-1',
  source:    'github',
  name:      'pr.commented',
  subject:   'rancher/dashboard#1',
  workspace: 'issue-5',
  payload:   { comment: { author: 'rev', body: 'please fix' }, self: false },
};

/** What dev-api's vm does, near enough for a test: the line as an expression over the scope. */
function checker(event) {
  const scope = conditionScope(event, 'cody');

  // eslint-disable-next-line no-new-func
  return (line) => new Function(...Object.keys(scope), `return (${ line });`)(...Object.values(scope));
}

const def = (over = {}) => ({
  name:     'reply',
  enabled:  true,
  triggers: [{ type: 'manual' }, {
    type: 'event', event: { source: 'github', names: ['pr.*'], condition: '' }
  }],
  ...over,
});

test('names: exact, a wildcard, none', () => {
  assert.equal(nameMatches(['pr.commented'], 'pr.commented'), true);
  assert.equal(nameMatches(['pr.*'], 'pr.reviewed'), true);
  assert.equal(nameMatches(['*.commented'], 'issue.commented'), true);
  assert.equal(nameMatches(['pr.*'], 'issue.commented'), false);
  assert.equal(nameMatches([], 'anything'), true);
  assert.equal(nameMatches(['stage.changed'], 'stageXchanged'), false);
});

test('an automation that does not listen says nothing at all', () => {
  assert.equal(evaluateEvent(def({ triggers: [{ type: 'manual' }] }), EVENT, { check: checker(EVENT) }), null);
  assert.equal(evaluateEvent(def({ triggers: [{ type: 'event', event: { source: 'workspace' } }] }), EVENT, { check: checker(EVENT) }), null);
});

test('every constraint holds: run', () => {
  const d = def();

  d.triggers[1].event.condition = "!p.self\npayload.comment.author !== me\n// a note\n\nevent.workspace === 'issue-5'";
  assert.deepEqual(evaluateEvent(d, EVENT, { check: checker(EVENT) }), { automation: 'reply', outcome: 'run', reason: '' });
});

test('the constraint that stopped it is the one reported', () => {
  const d = def();

  d.triggers[1].event.condition = "!p.self\np.comment.author === 'cody'\ne.name === 'pr.commented'";
  const got = evaluateEvent(d, EVENT, { check: checker(EVENT) });

  assert.equal(got.outcome, 'blocked');
  assert.equal(got.condition, "p.comment.author === 'cody'");
  assert.equal(got.reason, "p.comment.author === 'cody' was false");
});

test('a constraint that throws is an error, not a pass', () => {
  const d = def();

  d.triggers[1].event.condition = 'p.review.state === "approved"';
  const got = evaluateEvent(d, EVENT, { check: checker(EVENT) });

  assert.equal(got.outcome, 'error');
  assert.match(got.reason, /threw/);
});

test('disabled and muted are said before any constraint is run', () => {
  let ran = 0;
  const check = () => {
    ran++;

    return true;
  };

  assert.equal(evaluateEvent(def({ enabled: false }), EVENT, { check }).outcome, 'disabled');
  assert.equal(evaluateEvent(def(), EVENT, { muted: true, check }).outcome, 'muted');
  assert.equal(ran, 0);
});

test('of two listening triggers the first that passes wins; failing both reports the first', () => {
  const two = def({
    triggers: [
      { type: 'event', event: { names: ['pr.*'], condition: 'false' } },
      { type: 'event', event: { names: ['*.commented'], condition: 'true' } },
    ],
  });

  assert.equal(evaluateEvent(two, EVENT, { check: checker(EVENT) }).outcome, 'run');
  two.triggers[1].event.condition = '0';
  assert.equal(evaluateEvent(two, EVENT, { check: checker(EVENT) }).condition, 'false');
});

test('constraint lines skip blanks and comments', () => {
  assert.deepEqual(conditionLines('  a  \n\n// no\nb'), ['a', 'b']);
});

test('the scope is a copy: a constraint cannot change the event', () => {
  const scope = conditionScope(EVENT, 'cody');

  scope.payload.comment.body = 'changed';
  assert.equal(EVENT.payload.comment.body, 'please fix');
});

test('placeholders: dotted paths, objects as JSON, unknown left alone', () => {
  const vars = { event: EVENT, payload: EVENT.payload, name: 'pod-1' };

  assert.equal(fillTemplate('{{event.subject}}: {{ payload.comment.body }} ({{name}})', vars), 'rancher/dashboard#1: please fix (pod-1)');
  assert.equal(fillTemplate('{{payload.comment}}', vars), JSON.stringify(EVENT.payload.comment, null, 2));
  assert.equal(fillTemplate('{{nope.nothing}}', vars), '{{nope.nothing}}');
});

test('cron in the zone it was written in', () => {
  // 14:00 UTC is 09:00 in New York in November (EST, UTC-5), and a Monday.
  const at = new Date('2026-11-09T14:00:00Z');

  assert.equal(cronDueAt('0 9 * * 1-5', at, 'America/New_York'), true);
  assert.equal(cronDueAt('0 9 * * 1-5', at, 'UTC'), false);
  assert.equal(cronDueAt('0 14 * * *', at), true);
  assert.equal(cronDueAt('*/15 * * * *', new Date('2026-11-09T14:30:00Z')), true);
  assert.equal(cronDueAt('bad', at), false);
  assert.equal(cronFields(at, 'Not/AZone').hour, 14);
});

test('shell quoting and the env file', () => {
  assert.equal(shellQuote("it's"), "'it'\\''s'");
  assert.equal(envFile({ EVENT_NAME: 'pr.commented', 'bad name': 'x', EVENT_TITLE: "a'b $(x)" }), "export EVENT_NAME='pr.commented'\nexport EVENT_TITLE='a'\\''b $(x)'\n");
});

test('the wrapper records its status and clamps the timeout', () => {
  const w = scriptWrapper('/workspaces/.automations/runs/r1', 99999);

  assert.match(w, /D='\/workspaces\/\.automations\/runs\/r1'/);
  assert.match(w, /timeout -k 10 3600/);
  assert.match(w, /mv "\$D\/exit.tmp" "\$D\/exit"/);
});

test('action and exit words', () => {
  assert.equal(actionOf({}), 'agent');
  assert.equal(actionOf({ action: 'script' }), 'script');
  assert.equal(exitNote(0), '');
  assert.equal(exitNote(124), 'timed out');
  assert.equal(exitNote(2), 'exited 2');
});
