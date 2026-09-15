#!/usr/bin/env node
// List every comment this change adds, so each one can be judged.
//
// "The change" is everything the branch adds on top of where it left upstream: committed, staged,
// unstaged, and files not yet tracked. A comment that was only moved (its text removed in one place
// and added in another) is not new and is left out; an existing comment whose text was edited is
// listed, because the edit is ours.
//
// Each comment gets a hint, not a verdict:
//   pragma    does a job - eslint-disable, @ts-expect-error, istanbul ignore, webpackChunkName,
//             a licence header. Never delete these here: they are not documentation.
//   public    sits directly on something another module or an extension can use - an export, a
//             component prop, emit, slot or exposed member, a member of an exported type. Keep it
//             only if it states the contract.
//   internal  everything else. Delete it.
//
// Usage (in the checkout):
//   node /workspace/.claude/skills/my-code-comment-refinement/added-comments.mjs
//   node /workspace/.claude/skills/my-code-comment-refinement/added-comments.mjs --base upstream/master --json
//
// With no merge-base (a shallow checkout), it deepens the history 200 commits at a time until there
// is one; --no-fetch stops it fetching.
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(`--${ name }`);

  return i >= 0 ? (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true) : undefined;
};
const git = (...a) => execFileSync('git', a, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
const tryGit = (...a) => {
  try {
    return git(...a);
  } catch {
    return '';
  }
};

// Where the branch left upstream. Diffing against the tip of upstream instead would list every
// comment upstream changed since as one of ours.
function mergeBase() {
  const asked = flag('base');
  const candidates = typeof asked === 'string' ? [asked] : ['upstream/master', 'upstream/main', 'origin/master', 'origin/main', 'master', 'main'];

  for (const ref of candidates) {
    if (!tryGit('rev-parse', '--verify', '--quiet', `${ ref }^{commit}`)) {
      continue;
    }
    let base = tryGit('merge-base', 'HEAD', ref);

    // Workspace checkouts are shallow, and upstream is usually fetched one commit deep, so the two
    // histories do not meet. Deepen both sides until they do: history only, the tree is untouched.
    const [remote, ...branch] = ref.split('/');
    const tracking = tryGit('rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}');

    for (let round = 0; !base && branch.length && !flag('no-fetch') && round < 10; round++) {
      console.error(`no merge-base with ${ ref } yet; deepening history by 200 (${ round + 1 }/10)`);
      tryGit('fetch', '-q', '--deepen=200', remote, branch.join('/'));
      if (tracking.includes('/') && tryGit('rev-parse', '--is-shallow-repository') === 'true') {
        const [tr, ...tb] = tracking.split('/');

        tryGit('fetch', '-q', '--deepen=200', tr, tb.join('/'));
      }
      base = tryGit('merge-base', 'HEAD', ref);
    }
    if (base) {
      return { ref, base };
    }
    console.error(`No merge-base between HEAD and ${ ref }${ flag('no-fetch') ? '' : ', even 2000 commits deep' }. Pass --base <the commit this branch started from>.`);
    process.exit(2);
  }
  console.error(`None of ${ candidates.join(', ') } exists here. Pass --base <ref>.`);
  process.exit(2);
}

const CODE = /\.(m?[jt]sx?|cjs|vue|s?css|sh|bash|ya?ml)$/i;
// The environment's own files never count, whether or not .git/info/exclude says so: the seeded
// skills in .claude/, editor settings, and recordings under artifacts/.
const SKIP = /(^|\/)(node_modules|dist|dist-pkg|coverage|\.nuxt|storybook-static|\.claude|\.vscode|artifacts)\/|(^|\/)\.mcp\.json$|\.min\.(js|css)$|\.snap$|\.generated\.|(^|\/)(yarn\.lock|package-lock\.json)$/;

// Language of each line of a file, for the comment scanner. A .vue file is three languages.
function languages(file, text) {
  const lines = text.split('\n');
  const base = /\.s?css$/i.test(file) ? (/\.scss$/i.test(file) ? 'scss' : 'css') : /\.(sh|bash|ya?ml)$/i.test(file) ? 'hash' : 'js';

  if (!/\.vue$/i.test(file)) {
    return lines.map(() => base);
  }
  let mode = 'html';

  return lines.map((line) => {
    const here = mode;

    if (/^\s*<script\b/i.test(line)) {
      mode = 'js';

      return 'html';
    }
    if (/^\s*<style\b/i.test(line)) {
      mode = /lang=["'](scss|sass)["']/i.test(line) ? 'scss' : 'css';

      return 'html';
    }
    if (/^\s*<\/(script|style)>/i.test(line)) {
      mode = 'html';

      return 'html';
    }

    return here;
  });
}

// Comment spans: { start, end (1-based, inclusive), text }. A scanner, not a parser: it follows
// strings and template literals so a URL or a "//" in a string is not a comment, and it is wrong
// about regex literals containing "//", which are rare enough in this code to accept.
function comments(file, text) {
  const langs = languages(file, text);
  const lines = text.split('\n');
  const out = [];
  let open = null;

  for (let n = 0; n < lines.length; n++) {
    const line = lines[n];
    const lang = langs[n];
    let i = 0;
    let quote = null;

    while (i <= line.length) {
      if (open) {
        const closer = open.kind === 'html' ? '-->' : '*/';
        const at = line.indexOf(closer, i);

        if (at < 0) {
          open.text.push(line.slice(i));
          break;
        }
        open.text.push(line.slice(i, at));
        out.push({ start: open.start, end: n + 1, text: open.text.join('\n').split('\n').map((t) => t.replace(/^\s*\*\s?/, '')).join('\n').trim(), kind: open.kind });
        open = null;
        i = at + closer.length;
        continue;
      }
      if (i >= line.length) {
        break;
      }
      const c = line[i];
      const two = line.slice(i, i + 2);

      if (quote) {
        if (c === '\\') {
          i += 2;
          continue;
        }
        if (c === quote) {
          quote = null;
        }
        i++;
        continue;
      }
      if (lang === 'html') {
        if (line.startsWith('<!--', i)) {
          open = { start: n + 1, text: [], kind: 'html' };
          i += 4;
          continue;
        }
        i++;
        continue;
      }
      if (lang === 'hash') {
        if (c === '"' || c === "'") {
          quote = c;
        } else if (c === '#' && !(n === 0 && line.startsWith('#!')) && (i === 0 || /\s/.test(line[i - 1]))) {
          out.push({ start: n + 1, end: n + 1, text: line.slice(i + 1).trim(), kind: 'line' });
          break;
        }
        i++;
        continue;
      }
      if (c === '"' || c === "'" || (c === '`' && lang === 'js')) {
        quote = c;
        i++;
        continue;
      }
      if (two === '/*') {
        open = { start: n + 1, text: [], kind: 'block' };
        i += 2;
        continue;
      }
      if (two === '//' && (lang === 'js' || lang === 'scss') && line[i - 1] !== ':') {
        out.push({ start: n + 1, end: n + 1, text: line.slice(i + 2).trim(), kind: 'line' });
        break;
      }
      i++;
    }
  }

  // Consecutive line comments are one comment: that is how people write a paragraph with //.
  const merged = [];

  const pragma = (t) => PRAGMA.test(t);

  for (const c of out) {
    const prev = merged[merged.length - 1];

    if (prev && prev.kind === 'line' && c.kind === 'line' && c.start === prev.end + 1 && !pragma(c.text) && !pragma(prev.text.split('\n').pop()) && lines[c.start - 1].trim().startsWith(lines[prev.start - 1].trim().slice(0, 2))) {
      prev.end = c.end;
      prev.text += `\n${ c.text }`;
    } else {
      merged.push({ ...c });
    }
  }

  return merged;
}

const PRAGMA = /^[\s*]*(eslint-(disable|enable)|eslint\s|global\s|jshint|@ts-(ignore|expect-error|nocheck|check)|istanbul ignore|c8 ignore|v8 ignore|prettier-ignore|stylelint-(disable|enable)|webpack(ChunkName|Ignore|Mode|Prefetch|Preload)|@vite-ignore|@license|@preserve|SPDX-License-Identifier|copyright|shellcheck\s|#region|#endregion|@vue\/|vue-ignore|@__PURE__|#__PURE__|sourceMappingURL)/i;
const EXPORT = /^\s*(export\b|module\.exports\b|exports\.)/;
// Things whose direct members are part of an interface: an exported interface, type literal, enum
// or class; a component's props, emits, expose and model; typed defineProps/defineEmits; and an
// exported object or array literal. A function body is none of these - `export function f() {`
// makes f public, not the statements inside it.
const MEMBERS = [
  /^\s*export\s+(declare\s+)?(default\s+)?(interface|enum|(abstract\s+)?class)\b/,
  /^\s*export\s+(declare\s+)?type\s+\w+(<[^>]*>)?\s*=\s*\{\s*$/,
  /^\s*export\s+(const|let)\s+\w+(\s*:\s*[^=]+)?\s*=\s*(\{|\[)\s*$/,
  /^\s*(props|emits|expose|model)\s*:\s*[\[{]\s*$/,
  /define(Props|Emits|Slots|Expose|Model)\s*<\s*\{\s*$/,
  /define(Props|Emits|Slots|Expose|Model)\s*\(\s*[\[{]\s*$/,
];

// What a comment sits on: the next line of code, and the line that directly encloses it.
function classify(comment, lines, langs) {
  if (PRAGMA.test(comment.text)) {
    return { hint: 'pragma', why: 'does a job; not documentation' };
  }
  const lang = langs[comment.start - 1];
  const next = nextCode(lines, comment.end);

  if (lang === 'html') {
    return /^\s*<slot\b/.test(next.text) || /@slot\b/.test(comment.text) ? { hint: 'public', why: 'documents a slot', next: next.text } : { hint: 'internal', why: 'template comment', next: next.text };
  }
  if (!next.text) {
    return { hint: 'internal', why: 'nothing follows it' };
  }
  let top = true;

  for (let n = comment.start - 2; n >= 0; n--) {
    const t = lines[n].trim();

    if (/^<script\b/i.test(t)) {
      return { hint: 'public', why: 'documents the component', next: next.text };
    }
    if (t && !t.startsWith('#!')) {
      top = false;
      break;
    }
  }
  if (top && langs[comment.start - 1] === 'js' && lines.some((l) => EXPORT.test(l))) {
    return { hint: 'public', why: 'documents the module', next: next.text };
  }
  // A comment trailing code on the same line belongs to that line, not the next one.
  const own = lines[comment.start - 1];
  const trailing = own.trim() && !/^\s*(\/\/|\/\*|#|\*)/.test(own);
  const subject = trailing ? { line: comment.start, text: own } : next;

  if (!trailing && EXPORT.test(subject.text)) {
    return { hint: 'public', why: 'precedes an export', next: subject.text };
  }
  const indent = subject.text.match(/^\s*/)[0].length;

  for (let n = subject.line - 2; n >= 0; n--) {
    const l = lines[n];
    const t = l.trim();

    if (!t || /^(\/\/|\/\*|\*|<!--)/.test(t)) {
      continue;
    }
    if (l.match(/^\s*/)[0].length >= indent) {
      continue;
    }
    // The direct parent. Public only if its members are an interface, and this is not a private one.
    if (MEMBERS.some((re) => re.test(l))) {
      if (/^\s*(private|protected|#)/.test(subject.text)) {
        return { hint: 'internal', why: 'private member', next: subject.text };
      }

      return { hint: 'public', why: `member of: ${ t.slice(0, 60) }`, next: subject.text };
    }
    // A member of the object an exported function returns - a composable's return value - is
    // part of that function's contract.
    if (/^\s*return\s*\{\s*$/.test(l)) {
      const inner = l.match(/^\s*/)[0].length;

      for (let m = n - 1; m >= 0; m--) {
        const u = lines[m];

        if (u.trim() && u.match(/^\s*/)[0].length < inner) {
          if (EXPORT.test(u)) {
            return { hint: 'public', why: `returned by: ${ u.trim().slice(0, 60) }`, next: subject.text };
          }
          break;
        }
      }
    }
    break;
  }

  return { hint: 'internal', why: trailing ? 'trails a line of code' : 'not on an export, prop, emit, slot or exported type', next: subject.text };
}

function nextCode(lines, afterLine) {
  for (let n = afterLine; n < lines.length; n++) {
    const t = lines[n].trim();

    if (t && !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*') && !t.startsWith('<!--')) {
      return { line: n + 1, text: lines[n].replace(/\s+$/, '') };
    }
  }

  return { line: 0, text: '' };
}

const { ref, base } = mergeBase();
const norm = (s) => s.replace(/^[\s/*#<!\->]+|[\s*/\->]+$/g, '').replace(/\s+/g, ' ').trim();

const tracked = tryGit('diff', '--name-only', '--diff-filter=AMR', base).split('\n').filter(Boolean);
const untracked = tryGit('ls-files', '--others', '--exclude-standard').split('\n').filter(Boolean);
const files = [...new Set([...tracked, ...untracked])].filter((f) => CODE.test(f) && !SKIP.test(f) && existsSync(f));

// Text of every removed line in the whole change, to recognise a comment that only moved.
const removed = new Set(tryGit('diff', '-U0', base).split('\n').filter((l) => l.startsWith('-') && !l.startsWith('---')).map((l) => norm(l.slice(1))).filter(Boolean));

const results = [];

for (const file of files) {
  const text = readFileSync(file, 'utf8');
  const lines = text.split('\n');
  const langs = languages(file, text);
  let added;

  if (untracked.includes(file)) {
    added = new Set(lines.map((_, i) => i + 1));
  } else {
    added = new Set();
    for (const h of tryGit('diff', '-U0', base, '--', file).matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)) {
      const start = Number(h[1]);
      const count = h[2] === undefined ? 1 : Number(h[2]);

      for (let k = 0; k < count; k++) {
        added.add(start + k);
      }
    }
  }
  if (!added.size) {
    continue;
  }

  for (const c of comments(file, text)) {
    const span = [];

    for (let l = c.start; l <= c.end; l++) {
      span.push(l);
    }
    const ours = span.filter((l) => added.has(l));

    if (!ours.length) {
      continue;
    }
    const bodyLines = c.text.split('\n').map(norm).filter(Boolean);

    if (bodyLines.length && bodyLines.every((b) => removed.has(b))) {
      continue;
    }
    results.push({
      file, start: c.start, end: c.end, edited: ours.length < span.length, text: c.text, ...classify(c, lines, langs),
    });
  }
}

if (flag('json')) {
  console.log(JSON.stringify({ base: { ref, commit: base }, comments: results }, null, 2));
  process.exit(0);
}

const order = { internal: 0, public: 1, pragma: 2 };

results.sort((a, b) => order[a.hint] - order[b.hint] || a.file.localeCompare(b.file) || a.start - b.start);
console.log(`Comments added since ${ ref } (merge-base ${ base.slice(0, 10) }), in ${ files.length } changed file(s): ${ results.length }`);
for (const hint of ['internal', 'public', 'pragma']) {
  const group = results.filter((r) => r.hint === hint);

  if (!group.length) {
    continue;
  }
  console.log(`\n== ${ hint.toUpperCase() } (${ group.length }) ${ hint === 'internal' ? '- delete' : hint === 'public' ? '- keep only if it states the contract' : '- keep, these do a job' } ==`);
  for (const r of group) {
    const where = r.start === r.end ? `${ r.file }:${ r.start }` : `${ r.file }:${ r.start }-${ r.end }`;

    console.log(`  ${ where }${ r.edited ? '  (edited existing comment)' : '' }  [${ r.why }]`);
    console.log(`    ${ r.text.split('\n').slice(0, 3).join('\n    ').slice(0, 300) }`);
    if (r.next) {
      console.log(`    -> ${ r.next.trim().slice(0, 100) }`);
    }
  }
}
