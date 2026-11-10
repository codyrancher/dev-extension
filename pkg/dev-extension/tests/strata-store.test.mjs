// Strata's store, against an in-memory SQLite: the answers the ported pages rely on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  strataInit, strataPlainText, strataNotes, strataNote, strataCreateNote, strataUpdateNote, strataDeleteNote,
  strataRestoreNote, strataLabels, strataCreateLabel, strataUpdateLabel, strataDeleteLabel, strataAddNoteLabel,
  strataRemoveNoteLabel, strataLineLabels, strataAddLineLabel, strataLabelLines, strataRemoveLineLabel,
  strataAddImage, strataImage, strataDeleteImage, strataSearch,
} from '../dev-api/strata-store.mjs';

function fresh() {
  const db = new DatabaseSync(':memory:');

  strataInit(db);

  return db;
}

let seq = 0;
const ids = () => `id-${ ++seq }`;

test('a note is created under the page\'s id, and creating it again overwrites it', () => {
  const db = fresh();
  const note = strataCreateNote(db, { id: 'n1', title: 'Groceries', content: '<p>milk</p>' });

  assert.equal(note.id, 'n1');
  assert.deepEqual(note.label_ids, []);
  assert.equal(note.content_text, undefined, 'the search column is not sent');
  strataCreateNote(db, { id: 'n1', title: 'Shopping', content: '<p>eggs</p>' });
  assert.equal(strataNotes(db).length, 1);
  assert.equal(strataNote(db, 'n1').title, 'Shopping');
});

test('updates take only the fields given, and a missing note is a 404', () => {
  const db = fresh();

  strataCreateNote(db, { id: 'n1', title: 'A', content: '<p>x</p>' });
  const pinned = strataUpdateNote(db, 'n1', { pinned: true, pin_order: 3 });

  assert.equal(pinned.pinned, 1);
  assert.equal(pinned.pin_order, 3);
  assert.equal(pinned.title, 'A');
  assert.throws(() => strataUpdateNote(db, 'nope', { title: 'x' }), (e) => e.status === 404);
});

test('deleting hides a note, and restoring brings it back with its labels', () => {
  const db = fresh();

  strataCreateNote(db, { id: 'n1', title: 'A' });
  const label = strataCreateLabel(db, { name: 'work' }, ids);

  strataAddNoteLabel(db, 'n1', label.id);
  strataDeleteNote(db, 'n1');
  assert.equal(strataNotes(db).length, 0);
  assert.deepEqual(strataRestoreNote(db, 'n1').label_ids, [label.id]);
  assert.equal(strataNotes(db).length, 1);
});

test('notes come newest first unless a sort order says otherwise', () => {
  const db = fresh();

  db.exec("INSERT INTO notes (id, title, created_at) VALUES ('old', 'old', '2024-01-01 00:00:00'), ('new', 'new', '2025-01-01 00:00:00')");
  assert.deepEqual(strataNotes(db).map((n) => n.id), ['new', 'old']);
  strataUpdateNote(db, 'old', { sort_order: 5 });
  assert.deepEqual(strataNotes(db).map((n) => n.id), ['old', 'new']);
});

test('labels: a name is required, a parent cannot loop, and deleting cascades', () => {
  const db = fresh();

  assert.throws(() => strataCreateLabel(db, { name: '  ' }), (e) => e.status === 400);
  const parent = strataCreateLabel(db, { name: 'work' }, ids);
  const child = strataCreateLabel(db, { name: 'urgent', parent_id: parent.id }, ids);

  assert.throws(() => strataUpdateLabel(db, parent.id, { parent_id: child.id }), (e) => e.status === 400);
  assert.throws(() => strataUpdateLabel(db, parent.id, { parent_id: parent.id }), (e) => e.status === 400);
  strataCreateNote(db, { id: 'n1', title: 'A', content: '<p>a</p>' });
  strataAddNoteLabel(db, 'n1', parent.id);
  strataAddNoteLabel(db, 'n1', parent.id);
  strataAddLineLabel(db, 'n1', { line_key: 'p:0', label_id: parent.id }, ids);
  assert.deepEqual(strataNote(db, 'n1').label_ids, [parent.id], 'adding twice is once');
  strataDeleteLabel(db, parent.id);
  assert.deepEqual(strataNote(db, 'n1').label_ids, []);
  assert.deepEqual(strataLineLabels(db, 'n1'), []);
  assert.equal(strataLabels(db).find((l) => l.id === child.id).parent_id, null);
});

test('a label on a note that does not exist is a 409', () => {
  const db = fresh();
  const label = strataCreateLabel(db, { name: 'x' }, ids);

  assert.throws(() => strataAddNoteLabel(db, 'nope', label.id), (e) => e.status === 409);
  assert.throws(() => strataAddLineLabel(db, 'nope', { line_key: 'p:0', label_id: label.id }), (e) => e.status === 409);
});

test('line labels: by note, by label on live notes only with the note title, and removed', () => {
  const db = fresh();
  const label = strataCreateLabel(db, { name: 'todo' }, ids);

  strataCreateNote(db, { id: 'n1', title: 'Plan' });
  strataCreateNote(db, { id: 'n2', title: 'Gone' });
  const line = strataAddLineLabel(db, 'n1', {
    line_key: 'p:1.0', label_id: label.id, line_text: 'call Sam', line_number: 2
  }, ids);

  strataAddLineLabel(db, 'n2', { line_key: 'p:0', label_id: label.id }, ids);
  strataDeleteNote(db, 'n2');
  assert.equal(strataLineLabels(db, 'n1')[0].line_text, 'call Sam');
  assert.deepEqual(strataLabelLines(db, label.id).map((l) => [l.note_id, l.note_title]), [['n1', 'Plan']]);
  strataRemoveLineLabel(db, line.id);
  assert.deepEqual(strataLineLabels(db, 'n1'), []);
});

test('images: kept with their thumbnail, served by type, refused when not images', () => {
  const db = fresh();

  strataCreateNote(db, { id: 'n1' });
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  const jpg = Buffer.from([0xff, 0xd8, 0xff]);
  const image = strataAddImage(db, 'n1', {
    filename: 'a.png', mimetype: 'image/png', data: png.toString('base64'), thumbnail: jpg.toString('base64'), width: 10, height: 20
  }, ids);

  assert.deepEqual(strataImage(db, image.id), { type: 'image/png', bytes: png });
  assert.deepEqual(strataImage(db, image.id, true), { type: 'image/jpeg', bytes: jpg });
  const bare = strataAddImage(db, 'n1', { mimetype: 'image/png', data: png.toString('base64') }, ids);

  assert.equal(strataImage(db, bare.id, true).type, 'image/png', 'no thumbnail: the image, under its own type');
  assert.throws(() => strataAddImage(db, 'n1', { mimetype: 'text/html', data: 'eA==' }), (e) => e.status === 400);
  assert.throws(() => strataAddImage(db, 'n1', { mimetype: 'image/svg+xml', data: 'eA==' }), (e) => e.status === 400, 'an SVG can carry script');
  strataDeleteImage(db, image.id);
  assert.equal(strataImage(db, image.id), null);
  assert.throws(() => strataDeleteImage(db, image.id), (e) => e.status === 404);
});

test('search: every word, in the title, the text or a label name, never the markup', () => {
  const db = fresh();
  const work = strataCreateLabel(db, { name: 'work' }, ids);

  strataCreateNote(db, { id: 'a', title: 'Deploy plan', content: '<ul><li><p><strong>staging</strong> first</p></li></ul>' });
  strataCreateNote(db, { id: 'b', title: 'Shopping', content: '<p>milk &amp; eggs</p>' });
  strataAddNoteLabel(db, 'b', work.id);
  assert.deepEqual(strataSearch(db, 'staging first').map((n) => n.id), ['a']);
  assert.deepEqual(strataSearch(db, 'strong').map((n) => n.id), [], 'tags are not words');
  assert.deepEqual(strataSearch(db, 'milk & eggs').map((n) => n.id), ['b'], 'entities are read as text');
  assert.deepEqual(strataSearch(db, 'WORK').map((n) => n.id), ['b'], 'a label name matches, in any case');
  assert.deepEqual(strataSearch(db, '%').map((n) => n.id), [], '% is a character, not a wildcard');
});

test('search: the label language', () => {
  const db = fresh();
  const work = strataCreateLabel(db, { name: 'work' }, ids);
  const urgent = strataCreateLabel(db, { name: 'urgent' }, ids);

  for (const id of ['w', 'wu', 'u', 'none']) {
    strataCreateNote(db, { id, title: id });
  }
  strataAddNoteLabel(db, 'w', work.id);
  strataAddNoteLabel(db, 'wu', work.id);
  strataAddNoteLabel(db, 'wu', urgent.id);
  strataAddNoteLabel(db, 'u', urgent.id);
  const found = (labels) => strataSearch(db, '', labels).map((n) => n.id).sort();

  assert.deepEqual(found('work'), ['w', 'wu']);
  assert.deepEqual(found('work+urgent'), ['wu']);
  assert.deepEqual(found('work+-urgent'), ['w']);
  assert.deepEqual(found('work,urgent'), ['u', 'w', 'wu']);
  assert.deepEqual(found('*none'), ['none']);
  assert.deepEqual(found('*none+-work'), ['none']);
});

test('plain text: tags become spaces and entities become characters', () => {
  assert.equal(strataPlainText('<p>a<br>b</p><p>c&nbsp;&lt;d&gt; &#39;e&#39; &#x41;</p>'), "a b c <d> 'e' A");
});
