// Strata's notes, backed up to a private GitHub repository once a day when anything changed.
//
// What is written:
//   strata.json  - everything, as the database holds it: notes with their HTML (deleted ones too,
//                  so an accidental delete can be undone from here), labels, which note has which
//                  label, the labelled lines, and each picture's details. A restore reads this.
//   notes/       - every live note as Markdown, to read on GitHub: front matter with its labels
//                  and dates, the text, and the lines labelled in it.
//   images/      - the pictures, and their thumbnails.
//
// Through GitHub's Git Data API rather than a clone: the blobs that changed, one tree on top of
// the last commit's, a commit, the branch moved. dev-api has no git and no checkout to keep, and
// "only if something changed" falls out of it - each file's blob id is worked out here and
// compared with the tree already there, so an unchanged day uploads nothing and commits nothing.
//
// Pure apart from what it is handed: the database, a `gh(method, path, body) -> { status, body }`
// and a `hash(bytes) -> git blob id`. tests/strata-backup.test.mjs drives it with fakes. No
// imports beyond the store's, because gen-dev-api.mjs inlines this into server.mjs.
import { strataDecodeEntities } from './strata-store.mjs';

/** How often a backup is attempted, and how soon a failed one is tried again. */
export const STRATA_BACKUP_EVERY_MS = 24 * 60 * 60 * 1000;
export const STRATA_BACKUP_RETRY_MS = 60 * 60 * 1000;

/** The README's first lines, and the marker that says the README is ours to rewrite. */
export const STRATA_BACKUP_MARK = '<!-- strata-backup -->';

const STRATA_BACKUP_README = `# Strata backups

${ STRATA_BACKUP_MARK }
Notes from the Strata page of the dev extension, written here by its dev-api once a day when
something has changed.

- \`strata.json\` holds everything: notes (their HTML, deleted ones too), labels, which note has
  which label, the labelled lines, and each picture's details. A restore reads this.
- \`notes/\` holds each live note as Markdown, to read here.
- \`images/\` holds the pictures and their thumbnails.
`;

const STRATA_IMAGE_EXT = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/avif': 'avif', 'image/bmp': 'bmp'
};

// ── A note's HTML, read ───────────────────────────────────────────────────────────────────────
//
// Tiptap writes a small, well-formed subset of HTML, so a tokenizer and a stack are enough; there
// is no browser here to lend a DOM.

const STRATA_VOID_TAGS = new Set(['br', 'hr', 'img', 'input', 'wbr', 'col', 'area', 'base', 'embed', 'source', 'track']);

function strataAttrs(text) {
  const attrs = {};
  const re = /([^\s"'=<>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let m;

  while ((m = re.exec(text || ''))) {
    attrs[m[1].toLowerCase()] = strataDecodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
  }

  return attrs;
}

/** HTML as a tree of `{ tag, attrs, children }` and `{ text }`. */
export function strataParseHtml(html) {
  const root = { tag: '#root', attrs: {}, children: [] };
  const stack = [root];
  const re = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][\w-]*)((?:\s+[^\s"'=<>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*(\/?)>|([^<]+)|</g;
  let m;

  while ((m = re.exec(String(html || '')))) {
    const top = stack[stack.length - 1];

    if (m[5] !== undefined) {
      top.children.push({ text: strataDecodeEntities(m[5]) });
      continue;
    }
    if (!m[2]) {
      if (m[0] === '<') {
        top.children.push({ text: '<' });
      }
      continue;
    }
    const tag = m[2].toLowerCase();

    if (m[1]) {
      for (let k = stack.length - 1; k > 0; k--) {
        if (stack[k].tag === tag) {
          stack.length = k;
          break;
        }
      }
      continue;
    }
    const node = { tag, attrs: strataAttrs(m[3]), children: [] };

    top.children.push(node);
    if (!m[4] && !STRATA_VOID_TAGS.has(tag)) {
      stack.push(node);
    }
  }

  return root;
}

function strataTextOf(node) {
  return node.text !== undefined ? node.text : node.children.map(strataTextOf).join('');
}

function strataWrap(marker, inner) {
  if (!inner.trim()) {
    return inner;
  }
  const lead = /^\s*/.exec(inner)[0];
  const trail = /\s*$/.exec(inner)[0];

  return `${ lead }${ marker }${ inner.trim() }${ marker }${ trail }`;
}

function strataInline(nodes, ctx) {
  return nodes.map((n) => {
    if (n.text !== undefined) {
      return n.text.replace(/\n/g, ' ');
    }
    switch (n.tag) {
    case 'strong': case 'b':
      return strataWrap('**', strataInline(n.children, ctx));
    case 'em': case 'i':
      return strataWrap('*', strataInline(n.children, ctx));
    case 's': case 'del': case 'strike':
      return strataWrap('~~', strataInline(n.children, ctx));
    case 'code': {
      const code = strataTextOf(n);
      const tick = code.includes('`') ? '``' : '`';

      return `${ tick }${ code }${ tick }`;
    }
    case 'a':
      return `[${ strataInline(n.children, ctx) }](${ n.attrs.href || '' })`;
    case 'br':
      return '<br>';
    case 'img':
      return `![${ n.attrs.alt || '' }](${ ctx.image(n.attrs.src || '') })`;
    case 'label': case 'input':
      return '';
    default:
      return strataInline(n.children, ctx);
    }
  }).join('');
}

function strataIndent(text, pad) {
  return text.split('\n').map((line) => (line ? pad + line : line)).join('\n');
}

function strataList(n, ctx) {
  const task = n.attrs['data-type'] === 'taskList';
  const ordered = n.tag === 'ol';
  let number = Number(n.attrs.start) || 1;
  const items = [];

  for (const li of n.children.filter((c) => c.tag === 'li')) {
    const bullet = ordered ? `${ number++ }.` : '-';
    const checked = li.attrs['data-checked'];
    const marker = task || checked !== undefined ? `${ bullet } [${ checked === 'true' ? 'x' : ' ' }]` : bullet;
    const pad = ' '.repeat(bullet.length + 1);
    // A checklist item's text is in a <div> beside the <label> holding its box.
    const content = li.children.filter((c) => c.tag !== 'label').flatMap((c) => (c.tag === 'div' ? c.children : [c]));
    const parts = strataBlocks(content, ctx);
    const first = (parts.shift() || '').split('\n');
    let item = `${ marker } ${ first[0] }${ first.slice(1).map((line) => `\n${ line ? pad + line : line }`).join('') }`;

    for (const part of parts) {
      const nested = /^([-*]|\d+\.) /.test(part);

      item += `${ nested ? '\n' : '\n\n' }${ strataIndent(part, pad) }`;
    }
    items.push(item);
  }

  return items.join('\n');
}

function strataBlocks(nodes, ctx) {
  const out = [];

  for (const n of nodes) {
    if (n.text !== undefined) {
      if (n.text.trim()) {
        out.push(n.text.trim());
      }
      continue;
    }
    switch (n.tag) {
    case 'p': {
      const text = strataInline(n.children, ctx);

      if (text.trim()) {
        out.push(text);
      }
      break;
    }
    case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6':
      out.push(`${ '#'.repeat(Number(n.tag[1])) } ${ strataInline(n.children, ctx) }`);
      break;
    case 'blockquote':
      out.push(strataBlocks(n.children, ctx).join('\n\n').split('\n').map((line) => (line ? `> ${ line }` : '>')).join('\n'));
      break;
    case 'pre': {
      const code = n.children.find((c) => c.tag === 'code') || n;
      const lang = /language-([\w+#.-]+)/.exec(code.attrs?.class || '')?.[1] || '';
      const body = strataTextOf(code).replace(/\n$/, '');
      const fence = body.includes('```') ? '~~~~' : '```';

      out.push(`${ fence }${ lang }\n${ body }\n${ fence }`);
      break;
    }
    case 'hr':
      out.push('---');
      break;
    case 'ul': case 'ol':
      out.push(strataList(n, ctx));
      break;
    case 'div': case 'section': case 'article':
      out.push(...strataBlocks(n.children, ctx));
      break;
    default: {
      const text = strataInline([n], ctx);

      if (text.trim()) {
        out.push(text);
      }
    }
    }
  }

  return out;
}

/**
 * A note's HTML as GitHub-flavoured Markdown. `image(src)` says where a picture is from the note's
 * file; GFM's `- [ ]` for checklist items, so GitHub draws the boxes.
 */
export function strataHtmlToMarkdown(html, image = (src) => src) {
  const text = strataBlocks(strataParseHtml(html).children, { image }).join('\n\n');

  return text ? `${ text }\n` : '';
}

// ── What a backup holds ───────────────────────────────────────────────────────────────────────

function strataById(a, b) {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** A note's file name: its title as words, then its id, so two notes of one title stay two files. */
export function strataNoteFile(note) {
  const slug = String(note.title || '').toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/[\s_-]+/g, '-')
    .slice(0, 60)
    .replace(/-+$/, '') || 'untitled';

  return `notes/${ slug }--${ String(note.id).slice(0, 8) }.md`;
}

function strataYaml(value) {
  return JSON.stringify(value);
}

/**
 * Every file the backup is made of, in a fixed order with fixed contents: the same notes always
 * make the same bytes, so a day with no changes is a day with nothing to commit. `live` counts the
 * notes and labels there are; with none, there is nothing worth a repository.
 */
export function strataBackupFiles(db) {
  const notes = db.prepare('SELECT * FROM notes').all().map((row) => ({ ...row })).sort(strataById);
  const labels = db.prepare('SELECT * FROM labels').all().map((row) => ({ ...row })).sort(strataById);
  const noteLabels = db.prepare('SELECT note_id, label_id FROM note_labels').all().map((row) => ({ ...row }))
    .sort((a, b) => `${ a.note_id }\0${ a.label_id }`.localeCompare(`${ b.note_id }\0${ b.label_id }`));
  const lineLabels = db.prepare('SELECT * FROM line_labels').all().map((row) => ({ ...row })).sort(strataById);
  const images = db.prepare('SELECT id, note_id, filename, mimetype, width, height, created_at FROM images').all()
    .map((row) => ({ ...row })).sort(strataById);

  const labelName = new Map(labels.map((l) => [l.id, l.name]));
  const labelsOf = new Map();

  for (const { note_id: noteId, label_id: labelId } of noteLabels) {
    labelsOf.set(noteId, [...(labelsOf.get(noteId) || []), labelId]);
  }
  const files = [];
  const imageFiles = new Map();

  for (const image of images) {
    const ext = STRATA_IMAGE_EXT[image.mimetype] || 'bin';
    const row = db.prepare('SELECT data, thumbnail FROM images WHERE id = ?').get(image.id);
    const data = Buffer.from(row.data);
    const thumb = Buffer.from(row.thumbnail);

    image.file = `images/${ image.id }.${ ext }`;
    files.push({ path: image.file, bytes: data });
    if (Buffer.compare(data, thumb) !== 0) {
      image.thumbnail = `images/${ image.id }.thumb.jpg`;
      files.push({ path: image.thumbnail, bytes: thumb });
    }
    imageFiles.set(image.id, image.file);
  }

  const imageHref = (src) => {
    const id = /\/(?:api|strata)\/images\/([^/?"]+)/.exec(src)?.[1];

    return id && imageFiles.has(id) ? `../${ imageFiles.get(id) }` : src;
  };

  for (const note of notes.filter((n) => !n.deleted)) {
    const names = (labelsOf.get(note.id) || []).map((id) => labelName.get(id)).filter(Boolean).sort();
    const lines = lineLabels.filter((ll) => ll.note_id === note.id)
      .map((ll) => `- **${ labelName.get(ll.label_id) || 'label' }**: ${ ll.line_text || ll.line_key }`);
    const body = [
      '---',
      `title: ${ strataYaml(note.title || '') }`,
      `labels: ${ strataYaml(names) }`,
      `created: ${ strataYaml(note.created_at) }`,
      `updated: ${ strataYaml(note.updated_at) }`,
      ...(note.pinned ? ['pinned: true'] : []),
      `id: ${ strataYaml(note.id) }`,
      '---',
      '',
      `# ${ note.title || 'Untitled' }`,
      '',
      strataHtmlToMarkdown(note.content, imageHref).trimEnd(),
      ...(lines.length ? ['', '## Labelled lines', '', ...lines] : []),
      '',
    ].join('\n');

    files.push({ path: strataNoteFile(note), bytes: Buffer.from(body) });
  }

  const dump = {
    format:      'strata-backup/1',
    notes:       notes.map(({ content_text: _text, ...note }) => ({ ...note, label_ids: (labelsOf.get(note.id) || []).sort() })),
    labels,
    line_labels: lineLabels,
    images,
  };

  files.push({ path: 'strata.json', bytes: Buffer.from(`${ JSON.stringify(dump, null, 2) }\n`) });
  files.push({ path: 'README.md', bytes: Buffer.from(STRATA_BACKUP_README) });
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  return {
    files,
    notes:  notes.filter((n) => !n.deleted).length,
    labels: labels.length,
    images: images.length,
    live:   notes.some((n) => !n.deleted) || labels.length > 0,
  };
}

/** The paths a backup owns: anything else in the repository is left exactly as it is. */
export function strataOwnsPath(path) {
  return path === 'strata.json' || path === 'README.md' || path.startsWith('notes/') || path.startsWith('images/');
}

/**
 * What has to change in the repository: files whose blob differs from the one there, and files the
 * backup owns that it no longer has. `keepReadme` when the README there is somebody else's.
 */
export function strataBackupPlan(files, existing, hash, { keepReadme = false } = {}) {
  const wanted = new Set(files.map((f) => f.path));
  const upload = [];

  for (const file of files) {
    if (file.path === 'README.md' && keepReadme) {
      continue;
    }
    const sha = hash(file.bytes);

    if (existing.get(file.path) !== sha) {
      upload.push({ ...file, sha });
    }
  }
  const remove = [...existing.keys()].filter((p) => strataOwnsPath(p) && p !== 'README.md' && !wanted.has(p)).sort();

  return { upload, remove };
}

function strataGhFailure(what, answer) {
  const detail = answer?.body?.message || (typeof answer?.body === 'string' ? answer.body : '');

  return Object.assign(new Error(`GitHub: ${ what } answered ${ answer?.status }${ detail ? `: ${ detail }` : '' }`), { status: 502 });
}

/**
 * Write a backup to `repo`, making the repository - private - if it is not there and is the
 * token's own to make. Never writes to a public repository. Commits only when a file changed.
 */
export async function strataBackupRun({
  files, gh, hash, repo, login, message, wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
}) {
  const [owner, name] = String(repo).split('/');

  if (!owner || !name) {
    throw Object.assign(new Error(`"${ repo }" is not an owner/name repository.`), { status: 400 });
  }
  let created = false;
  let info = await gh('GET', `/repos/${ owner }/${ name }`);

  if (info.status === 404) {
    if (owner.toLowerCase() !== String(login || '').toLowerCase()) {
      throw Object.assign(new Error(`${ repo } does not exist, and only a repository of ${ login || 'the token\'s own' } can be made here.`), { status: 404 });
    }
    info = await gh('POST', '/user/repos', {
      name, private: true, auto_init: true, description: 'Strata notes, backed up daily by the dev extension.'
    });
    if (info.status >= 300) {
      throw strataGhFailure('making the repository', info);
    }
    created = true;
  } else if (info.status >= 300) {
    throw strataGhFailure('reading the repository', info);
  }
  if (!info.body?.private) {
    throw Object.assign(new Error(`${ repo } is public. Notes are only ever backed up to a private repository.`), { status: 409 });
  }
  const branch = info.body.default_branch || 'main';
  let ref = null;

  // A repository made a moment ago can take a few seconds to have its first commit.
  for (let k = 0; k < 6; k++) {
    ref = await gh('GET', `/repos/${ owner }/${ name }/git/ref/heads/${ encodeURIComponent(branch) }`);
    if (ref.status < 300 || !created) {
      break;
    }
    await wait(2000);
  }
  if (ref.status >= 300) {
    throw strataGhFailure(`reading ${ branch }`, ref);
  }
  const head = ref.body.object.sha;
  const commit = await gh('GET', `/repos/${ owner }/${ name }/git/commits/${ head }`);

  if (commit.status >= 300) {
    throw strataGhFailure('reading the last commit', commit);
  }
  const baseTree = commit.body.tree.sha;
  const tree = await gh('GET', `/repos/${ owner }/${ name }/git/trees/${ baseTree }?recursive=1`);

  if (tree.status >= 300) {
    throw strataGhFailure('reading the tree', tree);
  }
  // A truncated listing only means more is uploaded than needed: GitHub keeps one copy of a blob.
  const existing = new Map((tree.body.tree || []).filter((e) => e.type === 'blob').map((e) => [e.path, e.sha]));
  let keepReadme = false;

  if (existing.has('README.md')) {
    const readme = await gh('GET', `/repos/${ owner }/${ name }/git/blobs/${ existing.get('README.md') }`);
    const text = readme.status < 300 ? Buffer.from(readme.body.content || '', 'base64').toString('utf8') : '';

    // Ours (it carries the mark), or GitHub's placeholder in a repository made just now, is
    // rewritten; a README somebody else wrote is left alone.
    keepReadme = !created && !text.includes(STRATA_BACKUP_MARK);
  }
  const plan = strataBackupPlan(files, existing, hash, { keepReadme });

  if (!plan.upload.length && !plan.remove.length) {
    return {
      changed: false, commit: head, repo, branch, created
    };
  }
  const entries = [];

  for (const file of plan.upload) {
    const blob = await gh('POST', `/repos/${ owner }/${ name }/git/blobs`, { content: file.bytes.toString('base64'), encoding: 'base64' });

    if (blob.status >= 300) {
      throw strataGhFailure(`uploading ${ file.path }`, blob);
    }
    entries.push({
      path: file.path, mode: '100644', type: 'blob', sha: blob.body.sha
    });
  }
  for (const path of plan.remove) {
    entries.push({
      path, mode: '100644', type: 'blob', sha: null
    });
  }
  const newTree = await gh('POST', `/repos/${ owner }/${ name }/git/trees`, { base_tree: baseTree, tree: entries });

  if (newTree.status >= 300) {
    throw strataGhFailure('writing the tree', newTree);
  }
  const newCommit = await gh('POST', `/repos/${ owner }/${ name }/git/commits`, { message, tree: newTree.body.sha, parents: [head] });

  if (newCommit.status >= 300) {
    throw strataGhFailure('writing the commit', newCommit);
  }
  const moved = await gh('PATCH', `/repos/${ owner }/${ name }/git/refs/heads/${ encodeURIComponent(branch) }`, { sha: newCommit.body.sha });

  if (moved.status >= 300) {
    throw strataGhFailure(`moving ${ branch }`, moved);
  }

  return {
    changed: true, commit: newCommit.body.sha, repo, branch, created, uploaded: plan.upload.map((f) => f.path), removed: plan.remove
  };
}
