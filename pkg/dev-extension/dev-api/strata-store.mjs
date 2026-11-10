// Strata's notes, labels and labelled lines, kept by dev-api in one SQLite file.
//
// The same tables and the same answers as Strata's own server (server/src/routes.ts), so the
// pages ported from it ask the questions they always asked. Every function takes the open
// database rather than opening one: server.mjs owns the file and its place on disk, and
// tests/strata-store.test.mjs hands these an in-memory one.
//
// What is not Strata's: there is no user column and no per-user file. Every call reaches dev-api
// through the apiserver's proxy, so there is no telling two people apart here, and the extension
// is one person's anyway. Search reads a plain-text copy of each note (`content_text`) instead of
// its HTML, so a word like `strong` or `li` no longer matches every note that has bold or a list.
// No `node:` imports of its own: gen-dev-api.mjs inlines this into server.mjs, whose names
// these would collide with.

/** The tables, Strata's own plus the plain-text search column. */
export const STRATA_SCHEMA = `
  CREATE TABLE IF NOT EXISTS notes (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL DEFAULT '',
    content TEXT NOT NULL DEFAULT '',
    content_text TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    deleted INTEGER NOT NULL DEFAULT 0,
    sort_order REAL NOT NULL DEFAULT 0,
    pinned INTEGER NOT NULL DEFAULT 0,
    pin_order INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS labels (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    color TEXT NOT NULL DEFAULT '#f472b6',
    parent_id TEXT,
    pinned INTEGER NOT NULL DEFAULT 0,
    pin_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (parent_id) REFERENCES labels(id) ON DELETE SET NULL
  );
  CREATE TABLE IF NOT EXISTS note_labels (
    note_id TEXT NOT NULL,
    label_id TEXT NOT NULL,
    PRIMARY KEY (note_id, label_id),
    FOREIGN KEY (note_id) REFERENCES notes(id) ON DELETE CASCADE,
    FOREIGN KEY (label_id) REFERENCES labels(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS line_labels (
    id TEXT PRIMARY KEY,
    note_id TEXT NOT NULL,
    line_key TEXT NOT NULL,
    label_id TEXT NOT NULL,
    line_text TEXT NOT NULL DEFAULT '',
    line_number INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (note_id) REFERENCES notes(id) ON DELETE CASCADE,
    FOREIGN KEY (label_id) REFERENCES labels(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS images (
    id TEXT PRIMARY KEY,
    note_id TEXT NOT NULL,
    filename TEXT NOT NULL,
    mimetype TEXT NOT NULL,
    data BLOB NOT NULL,
    thumbnail BLOB NOT NULL,
    width INTEGER NOT NULL DEFAULT 0,
    height INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (note_id) REFERENCES notes(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_line_labels_label ON line_labels(label_id);
  CREATE INDEX IF NOT EXISTS idx_line_labels_note ON line_labels(note_id);
  CREATE INDEX IF NOT EXISTS idx_notes_deleted ON notes(deleted);
  CREATE INDEX IF NOT EXISTS idx_labels_parent ON labels(parent_id);
  CREATE INDEX IF NOT EXISTS idx_note_labels_label ON note_labels(label_id);
  CREATE INDEX IF NOT EXISTS idx_images_note ON images(note_id);
`;

/** An image larger than this is refused, as Strata's upload limit did. */
export const STRATA_IMAGE_MAX = 20 * 1024 * 1024;

function strataError(status, message) {
  return Object.assign(new Error(message), { status });
}

/** Ready a freshly opened database: the pragmas every connection needs, then the tables. */
export function strataInit(db) {
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  // A rollout runs two dev-api pods on the one file for a few seconds.
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec(STRATA_SCHEMA);
}

const STRATA_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'"
};

/** HTML's character references as the characters they stand for. */
export function strataDecodeEntities(text) {
  return String(text || '').replace(/&(#\d+|#x[\da-f]+|[a-z]+);/gi, (whole, name) => {
    if (STRATA_ENTITIES[name] !== undefined) {
      return STRATA_ENTITIES[name];
    }
    if (/^#x/i.test(name)) {
      return String.fromCodePoint(parseInt(name.slice(2), 16));
    }
    if (name.startsWith('#')) {
      return String.fromCodePoint(Number(name.slice(1)));
    }

    return whole;
  });
}

/** A note's HTML as the words in it: what search reads. */
export function strataPlainText(html) {
  return strataDecodeEntities(String(html || '').replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function strataStr(value, fallback = '') {
  return typeof value === 'string' ? value : fallback;
}

function strataNum(value, fallback = 0) {
  const n = Number(value);

  return Number.isFinite(n) ? n : fallback;
}

function strataFlag(value) {
  return value ? 1 : 0;
}

/** A note row as the pages want it: label ids as a list, and no search column. */
function strataNoteOut(row) {
  if (!row) {
    return row;
  }
  const { content_text: _text, label_ids: ids, ...note } = row;

  return { ...note, label_ids: ids ? String(ids).split(',') : [] };
}

const STRATA_NOTE_WITH_LABELS = `
  SELECT n.*, GROUP_CONCAT(nl.label_id) AS label_ids
  FROM notes n LEFT JOIN note_labels nl ON n.id = nl.note_id
`;

export function strataNotes(db) {
  return db.prepare(`${ STRATA_NOTE_WITH_LABELS } WHERE n.deleted = 0 GROUP BY n.id ORDER BY n.sort_order DESC, n.created_at DESC`)
    .all().map(strataNoteOut);
}

export function strataNote(db, id) {
  const note = strataNoteOut(db.prepare(`${ STRATA_NOTE_WITH_LABELS } WHERE n.id = ? GROUP BY n.id`).get(id));

  if (!note) {
    throw strataError(404, 'No such note.');
  }

  return note;
}

/** Create a note under the page's own id, or overwrite it if that id is already there. */
export function strataCreateNote(db, body = {}, newId = () => crypto.randomUUID()) {
  const id = strataStr(body.id) || newId();
  const title = strataStr(body.title);
  const content = strataStr(body.content);
  const sortOrder = strataNum(body.sort_order);

  db.prepare(`
    INSERT INTO notes (id, title, content, content_text, sort_order) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET title = excluded.title, content = excluded.content,
      content_text = excluded.content_text, sort_order = excluded.sort_order, deleted = 0,
      updated_at = datetime('now')
  `).run(id, title, content, strataPlainText(content), sortOrder);

  return strataNote(db, id);
}

export function strataUpdateNote(db, id, body = {}) {
  const sets = [];
  const params = [];

  if (body.title !== undefined) {
    sets.push('title = ?');
    params.push(strataStr(body.title));
  }
  if (body.content !== undefined) {
    sets.push('content = ?', 'content_text = ?');
    params.push(strataStr(body.content), strataPlainText(body.content));
  }
  if (body.sort_order !== undefined) {
    sets.push('sort_order = ?');
    params.push(strataNum(body.sort_order));
  }
  if (body.pinned !== undefined) {
    sets.push('pinned = ?');
    params.push(strataFlag(body.pinned));
  }
  if (body.pin_order !== undefined) {
    sets.push('pin_order = ?');
    params.push(strataNum(body.pin_order));
  }
  sets.push("updated_at = datetime('now')");

  const changed = db.prepare(`UPDATE notes SET ${ sets.join(', ') } WHERE id = ?`).run(...params, id).changes;

  if (!changed) {
    throw strataError(404, 'No such note.');
  }

  return strataNote(db, id);
}

/** Deleting is a flag, so Undo can bring the note back with its labels and lines. */
export function strataDeleteNote(db, id) {
  db.prepare("UPDATE notes SET deleted = 1, updated_at = datetime('now') WHERE id = ?").run(id);

  return { id, deleted: true };
}

export function strataRestoreNote(db, id) {
  db.prepare("UPDATE notes SET deleted = 0, updated_at = datetime('now') WHERE id = ?").run(id);

  return strataNote(db, id);
}

export function strataLabels(db) {
  return db.prepare('SELECT * FROM labels ORDER BY name COLLATE NOCASE').all().map((row) => ({ ...row }));
}

function strataLabelRow(db, id) {
  const label = db.prepare('SELECT * FROM labels WHERE id = ?').get(id);

  if (!label) {
    throw strataError(404, 'No such label.');
  }

  return { ...label };
}

export function strataCreateLabel(db, body = {}, newId = () => crypto.randomUUID()) {
  const name = strataStr(body.name).trim();

  if (!name) {
    throw strataError(400, 'A label needs a name.');
  }
  const id = strataStr(body.id) || newId();

  db.prepare('INSERT INTO labels (id, name, color, parent_id) VALUES (?, ?, ?, ?)')
    .run(id, name, strataStr(body.color) || '#f472b6', strataStr(body.parent_id) || null);

  return strataLabelRow(db, id);
}

/** A parent that is the label itself, or one of its own descendants, would make a loop. */
function strataWouldLoop(db, id, parentId) {
  let at = parentId;

  for (let hops = 0; at && hops < 1000; hops += 1) {
    if (at === id) {
      return true;
    }
    at = db.prepare('SELECT parent_id FROM labels WHERE id = ?').get(at)?.parent_id || null;
  }

  return false;
}

export function strataUpdateLabel(db, id, body = {}) {
  strataLabelRow(db, id);
  const sets = [];
  const params = [];

  if (body.name !== undefined) {
    const name = strataStr(body.name).trim();

    if (!name) {
      throw strataError(400, 'A label needs a name.');
    }
    sets.push('name = ?');
    params.push(name);
  }
  if (body.color !== undefined) {
    sets.push('color = ?');
    params.push(strataStr(body.color) || '#f472b6');
  }
  if (body.parent_id !== undefined) {
    const parent = strataStr(body.parent_id) || null;

    if (parent && strataWouldLoop(db, id, parent)) {
      throw strataError(400, 'A label cannot sit under itself.');
    }
    sets.push('parent_id = ?');
    params.push(parent);
  }
  if (body.pinned !== undefined) {
    sets.push('pinned = ?');
    params.push(strataFlag(body.pinned));
  }
  if (body.pin_order !== undefined) {
    sets.push('pin_order = ?');
    params.push(strataNum(body.pin_order));
  }
  if (sets.length) {
    db.prepare(`UPDATE labels SET ${ sets.join(', ') } WHERE id = ?`).run(...params, id);
  }

  return strataLabelRow(db, id);
}

/** The label goes, and with it every note's and line's use of it; its children lose their parent. */
export function strataDeleteLabel(db, id) {
  db.prepare('DELETE FROM labels WHERE id = ?').run(id);

  return { id, deleted: true };
}

export function strataAddNoteLabel(db, noteId, labelId) {
  try {
    db.prepare('INSERT OR IGNORE INTO note_labels (note_id, label_id) VALUES (?, ?)').run(noteId, strataStr(labelId));
  } catch {
    throw strataError(409, 'No such note or label.');
  }

  return { note_id: noteId, label_id: labelId };
}

export function strataRemoveNoteLabel(db, noteId, labelId) {
  db.prepare('DELETE FROM note_labels WHERE note_id = ? AND label_id = ?').run(noteId, labelId);

  return { note_id: noteId, label_id: labelId, removed: true };
}

export function strataLineLabels(db, noteId) {
  return db.prepare('SELECT * FROM line_labels WHERE note_id = ?').all(noteId).map((row) => ({ ...row }));
}

export function strataAddLineLabel(db, noteId, body = {}, newId = () => crypto.randomUUID()) {
  const lineKey = strataStr(body.line_key);

  if (!lineKey) {
    throw strataError(400, 'A line label needs the line.');
  }
  const record = {
    id:          newId(),
    note_id:     noteId,
    line_key:    lineKey,
    label_id:    strataStr(body.label_id),
    line_text:   strataStr(body.line_text).slice(0, 500),
    line_number: Math.trunc(strataNum(body.line_number)),
  };

  try {
    db.prepare('INSERT INTO line_labels (id, note_id, line_key, label_id, line_text, line_number) VALUES (?, ?, ?, ?, ?, ?)')
      .run(record.id, record.note_id, record.line_key, record.label_id, record.line_text, record.line_number);
  } catch {
    throw strataError(409, 'No such note or label.');
  }

  return record;
}

/** Every line given one label, on notes that are not deleted, with the note's title. */
export function strataLabelLines(db, labelId) {
  return db.prepare(`
    SELECT ll.*, n.title AS note_title FROM line_labels ll JOIN notes n ON ll.note_id = n.id
    WHERE ll.label_id = ? AND n.deleted = 0
  `).all(labelId).map((row) => ({ ...row }));
}

export function strataRemoveLineLabel(db, id) {
  db.prepare('DELETE FROM line_labels WHERE id = ?').run(id);

  return { id, removed: true };
}

/**
 * Keep an uploaded image. The page sends the bytes and a 200px thumbnail it drew itself, both as
 * base64: Strata made the thumbnail with sharp on its server, and dev-api has no packages.
 */
export function strataAddImage(db, noteId, body = {}, newId = () => crypto.randomUUID()) {
  const data = Buffer.from(strataStr(body.data), 'base64');
  const thumbnail = Buffer.from(strataStr(body.thumbnail), 'base64');
  const mimetype = strataStr(body.mimetype);

  if (!data.length) {
    throw strataError(400, 'No image was sent.');
  }
  if (data.length > STRATA_IMAGE_MAX) {
    throw strataError(413, 'The image is larger than 20 MB.');
  }
  // Pictures only. An SVG is a document that can run script, and these are served from the
  // dashboard's own origin through the apiserver's proxy.
  if (!/^image\/[\w.+-]+$/.test(mimetype) || /svg/i.test(mimetype)) {
    throw strataError(400, 'That is not a picture: PNG, JPEG, GIF, WebP and the like.');
  }
  const id = newId();
  const width = Math.trunc(strataNum(body.width));
  const height = Math.trunc(strataNum(body.height));

  try {
    db.prepare(`
      INSERT INTO images (id, note_id, filename, mimetype, data, thumbnail, width, height)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, noteId, strataStr(body.filename, 'image') || 'image', mimetype, data, thumbnail.length ? thumbnail : data, width, height);
  } catch {
    throw strataError(409, 'No such note.');
  }

  return {
    id, filename: strataStr(body.filename, 'image'), width, height
  };
}

/** An image's bytes and type, the full one or its thumbnail; null when there is no such image. */
export function strataImage(db, id, thumbnail = false) {
  const row = db.prepare('SELECT mimetype, data, thumbnail FROM images WHERE id = ?').get(id);

  if (!row) {
    return null;
  }
  if (thumbnail) {
    // A thumbnail the page could not draw is the image itself, stored under the image's own type.
    const same = Buffer.compare(Buffer.from(row.thumbnail), Buffer.from(row.data)) === 0;

    return { type: same ? row.mimetype : 'image/jpeg', bytes: Buffer.from(row.thumbnail) };
  }

  return { type: row.mimetype, bytes: Buffer.from(row.data) };
}

export function strataDeleteImage(db, id) {
  const changed = db.prepare('DELETE FROM images WHERE id = ?').run(id).changes;

  if (!changed) {
    throw strataError(404, 'No such image.');
  }

  return { id, deleted: true };
}

/** A LIKE pattern that matches the text as typed: `%` and `_` in a query are not wildcards. */
function strataLikeTerm(word) {
  return `%${ word.replace(/[\\%_]/g, (c) => `\\${ c }`) }%`;
}

/**
 * Strata's search. Every word must be in the title, the text, or the name of a label on the
 * note. `labels` is Strata's filter language: `,` between alternatives, `+` between labels
 * that must all hold, `-Name` for a label the note must not have, `*none` for no labels at all.
 */
export function strataSearch(db, q = '', labelQuery = '') {
  const conditions = ['n.deleted = 0'];
  const params = [];

  for (const word of String(q || '').trim().split(/\s+/).filter(Boolean)) {
    conditions.push(`(n.title LIKE ? ESCAPE '\\' OR n.content_text LIKE ? ESCAPE '\\' OR n.id IN (
      SELECT nl2.note_id FROM note_labels nl2 JOIN labels l2 ON nl2.label_id = l2.id WHERE l2.name LIKE ? ESCAPE '\\'
    ))`);
    const term = strataLikeTerm(word);

    params.push(term, term, term);
  }

  const groups = [];

  for (const part of String(labelQuery || '').split(',')) {
    const all = [];

    for (const term of part.split('+').map((t) => t.trim()).filter(Boolean)) {
      if (term === '*none') {
        all.push('n.id NOT IN (SELECT nl2.note_id FROM note_labels nl2)');
      } else if (term.startsWith('-')) {
        all.push(`n.id NOT IN (SELECT nl2.note_id FROM note_labels nl2 JOIN labels l2 ON nl2.label_id = l2.id WHERE l2.name = ?)`);
        params.push(term.slice(1));
      } else {
        all.push(`n.id IN (SELECT nl2.note_id FROM note_labels nl2 JOIN labels l2 ON nl2.label_id = l2.id WHERE l2.name = ?)`);
        params.push(term);
      }
    }
    if (all.length) {
      groups.push(`(${ all.join(' AND ') })`);
    }
  }
  if (groups.length) {
    conditions.push(`(${ groups.join(' OR ') })`);
  }

  return db.prepare(`${ STRATA_NOTE_WITH_LABELS } WHERE ${ conditions.join(' AND ') } GROUP BY n.id ORDER BY n.updated_at DESC`)
    .all(...params).map(strataNoteOut);
}
