// A Strata note's HTML, read and written as Markdown, and its lines named the way the editor
// names them.
//
// Notes are kept as the HTML Tiptap writes - a small, well-formed subset - and that is all the
// editor reads back. Markdown is how everything outside the editor wants them: the backup's
// readable copies, and the agents, which read and write notes through dev-api and think in
// Markdown. So both directions live here, beside the one walk that turns a note into its lines
// with the `line_key` a line label is filed under.
//
// No DOM: this runs in dev-api. A tokenizer and a stack read Tiptap's HTML, and the Markdown read
// is line by line. No imports but local ones: gen-dev-api.mjs inlines this into server.mjs.
import { strataDecodeEntities } from './strata-store.mjs';

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

// ── A note's lines ────────────────────────────────────────────────────────────────────────────
//
// A line label names its line by the child-index path ProseMirror gives the text block the caret
// was in (strata/editor/lineKeys.ts): `p:2` is the document's third block, `p:1.0.0` the
// paragraph of the first item of the list that is the second block. The HTML holds the same tree
// with one difference - a checklist item's content sits in a <div> beside the <label> holding its
// box, and ProseMirror sees only what is in the <div>.

const STRATA_TEXTBLOCKS = new Set(['p', 'pre', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
const STRATA_BLOCKS = new Set([...STRATA_TEXTBLOCKS, 'blockquote', 'ul', 'ol', 'li', 'hr']);

function strataPmChildren(node) {
  if (node.tag === 'li' && node.attrs?.['data-type'] === 'taskItem') {
    const div = node.children.find((c) => c.tag === 'div');

    return div ? div.children.filter((c) => STRATA_BLOCKS.has(c.tag)) : [];
  }

  return node.children.filter((c) => STRATA_BLOCKS.has(c.tag));
}

/**
 * Every line of a note that a label can go on: `{ line_key, line_number, text, kind, depth }`,
 * in order. `line_number` is the top-level block's, counted from 1, as the editor stores it.
 */
export function strataNoteLines(html) {
  const lines = [];

  function walk(node, path, inside) {
    strataPmChildren(node).forEach((child, index) => {
      const at = [...path, index];

      if (STRATA_TEXTBLOCKS.has(child.tag)) {
        lines.push({
          line_key:    `p:${ at.join('.') }`,
          line_number: at[0] + 1,
          text:        strataTextOf(child).replace(/\s+/g, ' ').trim(),
          kind:        child.tag === 'pre' ? 'code' : inside,
          depth:       at.length - 1,
        });
      } else if (child.tag !== 'hr') {
        const kind = child.tag === 'blockquote' ? 'quote' : child.tag === 'li' ? (child.attrs['data-type'] === 'taskItem' ? `task-${ child.attrs['data-checked'] === 'true' ? 'done' : 'open' }` : 'item') : inside;

        walk(child, at, kind);
      }
    });
  }
  walk(strataParseHtml(html), [], 'paragraph');

  return lines;
}

// ── Markdown, written into a note ─────────────────────────────────────────────────────────────
//
// What the editor can hold: paragraphs, bold, italic, underline, inline code, links, pictures,
// bullet and numbered lists, checklists, quotes, code blocks and rules. Not headings and not
// strikethrough, which the editor has switched off: a heading becomes a bold paragraph and
// ~~struck~~ text stays as its words. Every non-blank line is a paragraph of its own, as pressing
// Enter makes one in the editor - notes are written a line at a time, and Markdown's joining of
// adjacent lines into one paragraph would turn a list of thoughts into one run-on line.

function strataEscape(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Where a link may point and a picture may come from: never `javascript:` or `data:`. */
const STRATA_SAFE_HREF = /^(https?:\/\/|mailto:|\/(?!\/)|#)/i;
const STRATA_SAFE_SRC = /^(https?:\/\/|\/api\/images\/)/i;

/** Markdown's inline marks as Tiptap's HTML: code first, so nothing inside a code span is read as a mark. */
export function strataInlineHtml(text) {
  const spans = [];
  let out = String(text).replace(/(`+)([\s\S]*?[^`])\1(?!`)/g, (whole, ticks, code) => {
    spans.push(`<code>${ strataEscape(code.trim() ? code.replace(/^ (.*) $/, '$1') : code) }</code>`);

    return `\u0000${ spans.length - 1 }\u0000`;
  });

  out = strataEscape(out)
    .replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (whole, alt, src) => {
      if (!STRATA_SAFE_SRC.test(src)) {
        return whole;
      }
      spans.push(`<img src="${ src }" alt="${ alt }">`);

      return `\u0000${ spans.length - 1 }\u0000`;
    })
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (whole, label, href) => {
      if (!STRATA_SAFE_HREF.test(href)) {
        return whole;
      }
      spans.push(`<a target="_blank" rel="noopener noreferrer nofollow" href="${ href }">${ label }</a>`);

      return `\u0000${ spans.length - 1 }\u0000`;
    })
    .replace(/(^|[\s(])(https?:\/\/[^\s<)]+[^\s<).,;:!?'"])/g, (whole, lead, url) => {
      spans.push(`<a target="_blank" rel="noopener noreferrer nofollow" href="${ url }">${ url }</a>`);

      return `${ lead }\u0000${ spans.length - 1 }\u0000`;
    })
    .replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '<strong>$1</strong>')
    .replace(/__(?=\S)([\s\S]*?\S)__/g, '<strong>$1</strong>')
    .replace(/(^|[^*\w])\*(?=\S)([^*]*?\S)\*(?!\*)/g, '$1<em>$2</em>')
    .replace(/(^|[^_\w])_(?=\S)([^_]*?\S)_(?![_\w])/g, '$1<em>$2</em>')
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, '$1')
    .replace(/&lt;u&gt;([\s\S]*?)&lt;\/u&gt;/g, '<u>$1</u>')
    .replace(/&lt;br\s*\/?&gt;/g, '<br>');

  return out.replace(/\u0000(\d+)\u0000/g, (whole, n) => spans[Number(n)]);
}

const STRATA_LIST_ITEM = /^(\s*)([-*+]|\d+[.)])\s+(?:\[([ xX])\]\s+)?(.*)$/;

function strataIndentOf(line) {
  return line.replace(/\t/g, '    ').match(/^ */)[0].length;
}

function strataParagraph(text) {
  return `<p>${ strataInlineHtml(text) }</p>`;
}

function strataListHtml(items) {
  // items: { indent, ordered, task, checked, text, start, body: [lines] } in order; nesting by indent.
  let html = '';
  let i = 0;

  while (i < items.length) {
    const first = items[i];
    const kind = first.task ? 'task' : first.ordered ? 'ol' : 'ul';
    const run = [];

    while (i < items.length && items[i].indent === first.indent) {
      const item = items[i];
      const itemKind = item.task ? 'task' : item.ordered ? 'ol' : 'ul';

      if (itemKind !== kind) {
        break;
      }
      const children = [];

      i++;
      while (i < items.length && items[i].indent > first.indent) {
        children.push(items[i]);
        i++;
      }
      run.push({ item, children });
    }
    const inner = run.map(({ item, children }) => {
      const content = `${ strataParagraph(item.text) }${ item.body.map((b) => b).join('') }${ children.length ? strataListHtml(children) : '' }`;

      if (kind === 'task') {
        return `<li data-checked="${ item.checked }" data-type="taskItem"><label><input type="checkbox"${ item.checked ? ' checked="checked"' : '' }><span></span></label><div>${ content }</div></li>`;
      }

      return `<li>${ content }</li>`;
    }).join('');

    if (kind === 'task') {
      html += `<ul data-type="taskList">${ inner }</ul>`;
    } else if (kind === 'ol') {
      html += `<ol${ first.start !== 1 ? ` start="${ first.start }"` : '' }>${ inner }</ol>`;
    } else {
      html += `<ul>${ inner }</ul>`;
    }
  }

  return html;
}

/** Markdown as the HTML a Strata note holds. See the note above for what it can and cannot hold. */
export function strataMarkdownToHtml(markdown) {
  const lines = String(markdown || '').replace(/\r\n?/g, '\n').split('\n');
  let html = '';
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const fence = /^\s*(`{3,}|~{3,})\s*([\w+#.-]*)\s*$/.exec(line);

    if (!line.trim()) {
      i++;
    } else if (fence) {
      const body = [];

      i++;
      while (i < lines.length && !lines[i].trim().startsWith(fence[1])) {
        body.push(lines[i]);
        i++;
      }
      i++;
      html += `<pre><code${ fence[2] ? ` class="language-${ fence[2] }"` : '' }>${ strataEscape(body.join('\n')) }</code></pre>`;
    } else if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      html += '<hr>';
      i++;
    } else if (/^\s*>/.test(line)) {
      const quoted = [];

      while (i < lines.length && /^\s*>/.test(lines[i])) {
        quoted.push(lines[i].replace(/^\s*> ?/, ''));
        i++;
      }
      html += `<blockquote>${ strataMarkdownToHtml(quoted.join('\n')) || '<p></p>' }</blockquote>`;
    } else if (STRATA_LIST_ITEM.test(line)) {
      const items = [];

      while (i < lines.length) {
        const m = STRATA_LIST_ITEM.exec(lines[i]);

        if (m) {
          items.push({
            indent:  strataIndentOf(m[1]),
            ordered: /\d/.test(m[2]),
            start:   parseInt(m[2], 10) || 1,
            task:    m[3] !== undefined,
            checked: m[3] !== undefined && m[3] !== ' ',
            text:    m[4],
            body:    [],
          });
          i++;
        } else if (lines[i].trim() && items.length && strataIndentOf(lines[i]) > items[items.length - 1].indent && !/^\s*(`{3,}|~{3,})/.test(lines[i])) {
          // An indented line under an item is another paragraph of that item.
          items[items.length - 1].body.push(strataParagraph(lines[i].trim()));
          i++;
        } else {
          break;
        }
      }
      html += strataListHtml(items);
    } else {
      const heading = /^\s*#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);

      html += heading ? `<p><strong>${ strataInlineHtml(heading[1]) }</strong></p>` : strataParagraph(line.trim());
      i++;
    }
  }

  return html;
}
