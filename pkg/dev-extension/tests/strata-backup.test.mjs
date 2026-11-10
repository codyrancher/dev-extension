// Strata's daily backup: what it writes, and what it asks GitHub to do, against a fake GitHub.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import {
  strataInit, strataCreateNote, strataCreateLabel, strataAddNoteLabel, strataAddLineLabel, strataAddImage, strataDeleteNote,
} from '../dev-api/strata-store.mjs';
import {
  strataHtmlToMarkdown, strataBackupFiles, strataBackupPlan, strataBackupRun, strataNoteFile, STRATA_BACKUP_MARK,
} from '../dev-api/strata-backup.mjs';

const gitSha = (bytes) => createHash('sha1').update(`blob ${ bytes.length }\0`).update(bytes).digest('hex');

function fresh() {
  const db = new DatabaseSync(':memory:');

  strataInit(db);

  return db;
}

let seq = 0;
const ids = () => `id-${ ++seq }`;

test('markdown: Tiptap\'s marks, lists, checklists, quotes, code, rules and pictures', () => {
  const html = [
    '<p>Plain <strong>bold</strong> <em>it</em> <s>gone</s> <code>x()</code> <a target="_blank" href="https://e.com">link</a> a &amp; b</p>',
    '<ul><li><p>one</p><ul><li><p>nested</p></li></ul></li><li><p>two</p></li></ul>',
    '<ol start="3"><li><p>three</p></li><li><p>four</p><ol><li><p>sub</p></li></ol></li></ol>',
    '<ul data-type="taskList"><li data-checked="true" data-type="taskItem"><label><input type="checkbox" checked="checked"><span></span></label><div><p>done</p></div></li>',
    '<li data-checked="false" data-type="taskItem"><label><input type="checkbox"><span></span></label><div><p>todo</p></div></li></ul>',
    '<blockquote><p>quoted</p><p>twice</p></blockquote>',
    '<pre><code class="language-js">const a = 1 &lt; 2;\nreturn a;</code></pre>',
    '<hr>',
    '<p><img src="/api/images/abc/thumbnail" alt="pic"></p>',
    '<p></p>',
  ].join('');

  assert.equal(strataHtmlToMarkdown(html, (src) => src.replace('/api/images/abc/thumbnail', '../images/abc.png')), [
    'Plain **bold** *it* ~~gone~~ `x()` [link](https://e.com) a & b',
    '',
    '- one\n  - nested\n- two',
    '',
    '3. three\n4. four\n   1. sub',
    '',
    '- [x] done\n- [ ] todo',
    '',
    '> quoted\n>\n> twice',
    '',
    '```js\nconst a = 1 < 2;\nreturn a;\n```',
    '',
    '---',
    '',
    '![pic](../images/abc.png)',
    '',
  ].join('\n'));
});

test('markdown: a block under a list item is indented to the item\'s text', () => {
  assert.equal(
    strataHtmlToMarkdown('<ul><li><p>item</p><pre><code>x\ny</code></pre></li></ul>'),
    '- item\n\n  ```\n  x\n  y\n  ```\n',
  );
  assert.equal(strataHtmlToMarkdown(''), '');
});

test('files: a note per live note, the dump, pictures, and the same bytes every time', () => {
  const db = fresh();
  const work = strataCreateLabel(db, { name: 'work' }, ids);

  strataCreateNote(db, { id: 'n-aaaaaaaaa', title: 'Deploy plan!', content: '<p>ship <img src="/api/images/img-1/thumbnail"></p>' });
  strataCreateNote(db, { id: 'n-gone', title: 'Old' });
  strataDeleteNote(db, 'n-gone');
  strataAddNoteLabel(db, 'n-aaaaaaaaa', work.id);
  strataAddLineLabel(db, 'n-aaaaaaaaa', { line_key: 'p:0', label_id: work.id, line_text: 'ship' }, ids);
  strataAddImage(db, 'n-aaaaaaaaa', {
    mimetype: 'image/png', data: Buffer.from('png').toString('base64'), thumbnail: Buffer.from('jpg').toString('base64')
  }, () => 'img-1');

  const backup = strataBackupFiles(db);
  const paths = backup.files.map((f) => f.path);

  assert.deepEqual(paths, ['README.md', 'images/img-1.png', 'images/img-1.thumb.jpg', 'notes/deploy-plan--n-aaaaaa.md', 'strata.json']);
  assert.equal(backup.notes, 1);
  assert.ok(backup.live);
  const note = backup.files.find((f) => f.path.startsWith('notes/')).bytes.toString();

  assert.match(note, /^---\ntitle: "Deploy plan!"\nlabels: \["work"\]/);
  assert.match(note, /# Deploy plan!\n\nship !\[\]\(\.\.\/images\/img-1\.png\)/);
  assert.match(note, /## Labelled lines\n\n- \*\*work\*\*: ship/);
  const dump = JSON.parse(backup.files.find((f) => f.path === 'strata.json').bytes);

  assert.deepEqual(dump.notes.map((n) => [n.id, n.deleted]), [['n-aaaaaaaaa', 0], ['n-gone', 1]], 'deleted notes are kept in the dump');
  assert.equal(dump.notes[0].content_text, undefined);
  assert.deepEqual(dump.notes[0].label_ids, [work.id]);
  assert.equal(dump.images[0].file, 'images/img-1.png');
  assert.match(backup.files.find((f) => f.path === 'README.md').bytes.toString(), new RegExp(STRATA_BACKUP_MARK));
  assert.deepEqual(strataBackupFiles(db).files.map((f) => gitSha(f.bytes)), backup.files.map((f) => gitSha(f.bytes)), 'deterministic');
});

test('files: nothing live is nothing to back up', () => {
  const db = fresh();

  strataCreateNote(db, { id: 'n1' });
  strataDeleteNote(db, 'n1');
  assert.equal(strataBackupFiles(db).live, false);
});

test('a note\'s file name: its title, then its id', () => {
  assert.equal(strataNoteFile({ id: '1234567890', title: '  Ünïcode & spaces / slashes ' }), 'notes/unicode-spaces-slashes--12345678.md');
  assert.equal(strataNoteFile({ id: 'abc', title: '' }), 'notes/untitled--abc.md');
});

test('plan: only what changed is uploaded, only what the backup owns is removed', () => {
  const files = [{ path: 'strata.json', bytes: Buffer.from('{}') }, { path: 'notes/a.md', bytes: Buffer.from('a') }, { path: 'README.md', bytes: Buffer.from('r') }];
  const existing = new Map([
    ['strata.json', gitSha(Buffer.from('{}'))],
    ['notes/old.md', 'x'],
    ['other/keep.txt', 'y'],
    ['README.md', 'someone-elses'],
  ]);
  const plan = strataBackupPlan(files, existing, gitSha, { keepReadme: true });

  assert.deepEqual(plan.upload.map((f) => f.path), ['notes/a.md']);
  assert.deepEqual(plan.remove, ['notes/old.md']);
});

/** A GitHub with one repository in it, as far as the backup can tell. */
function fakeGitHub({ exists = true, isPrivate = true, files = {}, readme = '# strata\n' } = {}) {
  const calls = [];
  const blobs = new Map();
  let head = 'c1';
  const repo = {
    exists, private: isPrivate, tree: new Map(Object.entries({ 'README.md': gitSha(Buffer.from(readme)), ...files }))
  };

  blobs.set(gitSha(Buffer.from(readme)), readme);
  const gh = async(method, path, body) => {
    calls.push(`${ method } ${ path }`);
    if (method === 'GET' && path === '/repos/me/strata') {
      return repo.exists ? { status: 200, body: { private: repo.private, default_branch: 'main' } } : { status: 404, body: { message: 'Not Found' } };
    }
    if (method === 'POST' && path === '/user/repos') {
      repo.exists = true;

      return { status: 201, body: { private: body.private, default_branch: 'main' } };
    }
    if (path === '/repos/me/strata/git/ref/heads/main') {
      return { status: 200, body: { object: { sha: head } } };
    }
    if (path.startsWith('/repos/me/strata/git/commits/')) {
      return { status: 200, body: { tree: { sha: 't1' } } };
    }
    if (path.startsWith('/repos/me/strata/git/trees/')) {
      return { status: 200, body: { tree: [...repo.tree].map(([p, sha]) => ({ path: p, sha, type: 'blob' })) } };
    }
    if (path.startsWith('/repos/me/strata/git/blobs/')) {
      return { status: 200, body: { content: Buffer.from(blobs.get(path.split('/').pop()) || '').toString('base64') } };
    }
    if (method === 'POST' && path === '/repos/me/strata/git/blobs') {
      const bytes = Buffer.from(body.content, 'base64');

      return { status: 201, body: { sha: gitSha(bytes) } };
    }
    if (method === 'POST' && path === '/repos/me/strata/git/trees') {
      for (const e of body.tree) {
        if (e.sha === null) {
          repo.tree.delete(e.path);
        } else {
          repo.tree.set(e.path, e.sha);
        }
      }

      return { status: 201, body: { sha: 't2' } };
    }
    if (method === 'POST' && path === '/repos/me/strata/git/commits') {
      return { status: 201, body: { sha: 'c2' } };
    }
    if (method === 'PATCH' && path === '/repos/me/strata/git/refs/heads/main') {
      head = body.sha;

      return { status: 200, body: {} };
    }

    return { status: 500, body: { message: `unexpected ${ method } ${ path }` } };
  };

  return { gh, calls, repo };
}

const files = [
  { path: 'README.md', bytes: Buffer.from(`# Strata backups\n${ STRATA_BACKUP_MARK }\n`) },
  { path: 'notes/a.md', bytes: Buffer.from('a') },
  { path: 'strata.json', bytes: Buffer.from('{}') },
];
const run = (gh, extra = {}) => strataBackupRun({
  files, gh, hash: gitSha, repo: 'me/strata', login: 'me', message: 'Back up', wait: async() => {}, ...extra
});

test('run: makes the repository private when it is missing, then commits everything', async() => {
  const fake = fakeGitHub({ exists: false });
  const result = await run(fake.gh);

  assert.ok(fake.calls.includes('POST /user/repos'));
  assert.equal(result.changed, true);
  assert.equal(result.created, true);
  assert.deepEqual(result.uploaded, ['README.md', 'notes/a.md', 'strata.json'], 'GitHub\'s placeholder README is replaced');
  assert.ok(fake.calls.includes('PATCH /repos/me/strata/git/refs/heads/main'));
});

test('run: nothing changed is nothing committed', async() => {
  const fake = fakeGitHub({ files: Object.fromEntries(files.map((f) => [f.path, gitSha(f.bytes)])), readme: files[0].bytes.toString() });
  const result = await run(fake.gh);

  assert.equal(result.changed, false);
  assert.ok(!fake.calls.some((c) => c.startsWith('POST') || c.startsWith('PATCH')), 'no writes at all');
});

test('run: a note gone since the last backup is removed; someone else\'s README is kept', async() => {
  const fake = fakeGitHub({ files: { 'notes/old.md': 'x', 'docs/mine.md': 'y' }, readme: 'My own notes about this repo\n' });
  const result = await run(fake.gh);

  assert.deepEqual(result.removed, ['notes/old.md']);
  assert.ok(!result.uploaded.includes('README.md'));
  assert.ok(fake.repo.tree.has('docs/mine.md'));
});

test('run: never writes to a public repository, nor makes one under somebody else\'s name', async() => {
  await assert.rejects(run(fakeGitHub({ isPrivate: false }).gh), /public/);
  await assert.rejects(run(fakeGitHub({ exists: false }).gh, { login: 'someone-else' }), /only a repository of someone-else/);
});
