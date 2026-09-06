// What a diff is made of, for the two panels that draw one: the pull request's and the review of
// what an agent changed. Parsing unified diff into rows, highlighting each side of it as one
// text so a construct that spans lines is styled on every line, and rendering the markdown of
// a comment with its HTML escaped.
// @ts-ignore - marked ships its own module without a declaration this build can see
import { marked } from 'marked';
import hljs from 'highlight.js/lib/core';
import hlTypescript from 'highlight.js/lib/languages/typescript';
import hlJavascript from 'highlight.js/lib/languages/javascript';
import hlXml from 'highlight.js/lib/languages/xml';
import hlJson from 'highlight.js/lib/languages/json';
import hlYaml from 'highlight.js/lib/languages/yaml';
import hlBash from 'highlight.js/lib/languages/bash';
import hlCss from 'highlight.js/lib/languages/css';
import hlScss from 'highlight.js/lib/languages/scss';
import hlMarkdown from 'highlight.js/lib/languages/markdown';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

// ── Syntax highlighting for diff code lines ──
hljs.registerLanguage('typescript', hlTypescript);
hljs.registerLanguage('javascript', hlJavascript);
hljs.registerLanguage('xml', hlXml);
hljs.registerLanguage('json', hlJson);
hljs.registerLanguage('yaml', hlYaml);
hljs.registerLanguage('bash', hlBash);
hljs.registerLanguage('css', hlCss);
hljs.registerLanguage('scss', hlScss);
hljs.registerLanguage('markdown', hlMarkdown);

const EXT_LANG: Record<string, string> = {
  ts:   'typescript', tsx: 'typescript',
  js:   'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  vue:  'xml', html: 'xml', svg: 'xml',
  json: 'json',
  yml:  'yaml', yaml: 'yaml',
  sh:   'bash', bash: 'bash',
  css:  'css', scss: 'scss',
  md:   'markdown',
};

export function langFromPath(path: string): string | null {
  const ext = path.split('.').pop()?.toLowerCase() || '';

  return EXT_LANG[ext] || null;
}

// ── Highlighting a diff ──
//
// Each SIDE of the diff is highlighted as one continuous text - the old side (context +
// deletions) and the new side (context + additions) - and the resulting HTML is split back into
// lines, so a line inside a block comment or a template literal knows what it is inside.
export function splitHighlighted(html: string): string[] {
  const lines: string[] = [];
  const open: string[] = [];
  let cur = '';
  const token = /<span [^>]*>|<\/span>|\n|[^<\n]+|</g;
  let m: RegExpExecArray | null;

  while ((m = token.exec(html)) !== null) {
    const t = m[0];

    if (t === '\n') {
      lines.push(cur + '</span>'.repeat(open.length));
      cur = open.join('');
    } else if (t === '</span>') {
      open.pop();
      cur += t;
    } else if (t.startsWith('<span')) {
      open.push(t);
      cur += t;
    } else {
      cur += t;
    }
  }
  lines.push(cur + '</span>'.repeat(open.length));

  return lines;
}

export function highlightLines(path: string, lines: string[]): string[] {
  const lang = langFromPath(path);

  if (!lang) {
    return lines.map(escapeHtml);
  }
  try {
    const html = hljs.highlight(lines.join('\n'), { language: lang, ignoreIllegals: true }).value;
    const out = splitHighlighted(html);

    return out.length === lines.length ? out : lines.map(escapeHtml);
  } catch {
    return lines.map(escapeHtml);
  }
}

const hlByRow = new WeakMap<DiffRow, string>();
export const EXT_LANGS = EXT_LANG;

export function highlightRows(path: string, rows: DiffRow[]): void {
  const sides: { rows: DiffRow[]; texts: string[] }[] = [
    { rows: [], texts: [] },
    { rows: [], texts: [] },
  ];

  for (const row of rows) {
    if (row.type === 'hunk' || row.type === 'expand') {
      continue;
    }
    if (row.type !== 'add') {
      sides[0].rows.push(row); sides[0].texts.push(row.text);
    }
    if (row.type !== 'del') {
      sides[1].rows.push(row); sides[1].texts.push(row.text);
    }
  }
  for (const side of sides) {
    if (!side.rows.length) {
      continue;
    }
    const html = highlightLines(path, side.texts);

    side.rows.forEach((row, i) => {
      hlByRow.set(row, html[i]);
    });
  }
}

export function hl(row: DiffRow): string {
  return hlByRow.get(row) ?? escapeHtml(row.text);
}

// ── Markdown rendering (comments + conversation) ──
// Raw HTML in bodies is escaped, not rendered - comment authors are arbitrary GitHub users.
export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

marked.use({ renderer: { html(token: Json) { return escapeHtml(token?.raw ?? ''); } } as Json });

export function renderMd(text: string): string {
  const cleaned = (text || '').replace(/<!--[\s\S]*?-->/g, '');

  try {
    const html = marked.parse(cleaned, { async: false, breaks: true, gfm: true }) as string;

    return html.replace(/<a href/g, '<a target="_blank" rel="noopener" href');
  } catch {
    return escapeHtml(cleaned);
  }
}


// ── Diff parsing ──

export interface DiffRow {
  type: 'hunk' | 'add' | 'del' | 'ctx' | 'expand';
  oldN: number | null;
  newN: number | null;
  text: string;
  gapId?: string;
  count?: number | null;
  deltaOld?: number;
}

export interface Hunk {
  oldStart: number;
  newStart: number;
  oldNext: number;
  newNext: number;
  rows: DiffRow[];
}

export function parseHunks(patch: string): Hunk[] {
  const hunks: Hunk[] = [];

  if (!patch) {
    return hunks;
  }
  let cur: Hunk | null = null;
  let oldN = 0;
  let newN = 0;

  for (const line of patch.split('\n')) {
    if (line.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);

      if (m) {
        oldN = parseInt(m[1], 10);
        newN = parseInt(m[2], 10);
        cur = {
          oldStart: oldN, newStart: newN, oldNext: oldN, newNext: newN,
          rows:     [{ type: 'hunk', oldN: null, newN: null, text: line }],
        };
        hunks.push(cur);
      }
    } else if (!cur) {
      continue;
    } else if (line.startsWith('+')) {
      cur.rows.push({ type: 'add', oldN: null, newN: newN++, text: line.slice(1) });
      cur.newNext = newN;
    } else if (line.startsWith('-')) {
      cur.rows.push({ type: 'del', oldN: oldN++, newN: null, text: line.slice(1) });
      cur.oldNext = oldN;
    } else if (line.startsWith('\\')) {
      cur.rows.push({ type: 'ctx', oldN: null, newN: null, text: line });
    } else {
      cur.rows.push({ type: 'ctx', oldN: oldN++, newN: newN++, text: line.slice(1) });
      cur.oldNext = oldN;
      cur.newNext = newN;
    }
  }

  return hunks;
}

