// Strata notes in Markdown, both ways, and a note's lines named as the editor names them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { strataHtmlToMarkdown, strataMarkdownToHtml, strataNoteLines } from '../dev-api/strata-markdown.mjs';

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

test('markdown in: a line is a paragraph, and lists, checklists, quotes, code and rules', () => {
  assert.equal(strataMarkdownToHtml([
    'First thought',
    'Second **bold** and *it* and `a < b`',
    '',
    '- one',
    '  - nested',
    '- two',
    '1. first',
    '2. second',
    '- [ ] todo',
    '- [x] done',
    '> quoted',
    '```js',
    'const a = "<x>";',
    '```',
    '---',
    '## Heading',
    'see https://example.com/a?b=1&c=2.',
  ].join('\n')), [
    '<p>First thought</p>',
    '<p>Second <strong>bold</strong> and <em>it</em> and <code>a &lt; b</code></p>',
    '<ul><li><p>one</p><ul><li><p>nested</p></li></ul></li><li><p>two</p></li></ul>',
    '<ol><li><p>first</p></li><li><p>second</p></li></ol>',
    '<ul data-type="taskList"><li data-checked="false" data-type="taskItem"><label><input type="checkbox"><span></span></label><div><p>todo</p></div></li>',
    '<li data-checked="true" data-type="taskItem"><label><input type="checkbox" checked="checked"><span></span></label><div><p>done</p></div></li></ul>',
    '<blockquote><p>quoted</p></blockquote>',
    '<pre><code class="language-js">const a = &quot;&lt;x&gt;&quot;;</code></pre>',
    '<hr>',
    '<p><strong>Heading</strong></p>',
    '<p>see <a target="_blank" rel="noopener noreferrer nofollow" href="https://example.com/a?b=1&amp;c=2">https://example.com/a?b=1&amp;c=2</a>.</p>',
  ].join(''));
});

test('markdown in: no markup gets through as markup, and no script as a link', () => {
  assert.equal(strataMarkdownToHtml('<script>alert(1)</script>'), '<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>');
  assert.equal(strataMarkdownToHtml('[x](javascript:alert(1))'), '<p>[x](javascript:alert(1))</p>');
  assert.equal(strataMarkdownToHtml('![p](data:image/png;base64,AAAA)'), '<p>![p](data:image/png;base64,AAAA)</p>');
  assert.equal(strataMarkdownToHtml('snake_case_name and 2 * 3 * 4'), '<p>snake_case_name and 2 * 3 * 4</p>');
  assert.equal(strataMarkdownToHtml(''), '');
});

test('markdown round trip: what an agent writes is what it reads back', () => {
  const md = '- [ ] buy milk\n- [x] call Sam\n\n- one\n  - two\n\n> quote\n\n```sh\nls -la\n```\n\nplain **bold** `code`\n';

  assert.equal(strataHtmlToMarkdown(strataMarkdownToHtml(md)), md);
});

test('lines: the editor\'s keys, through lists, checklists and quotes', () => {
  const html = strataMarkdownToHtml('Intro\n- a\n  - a1\n- [ ] task\n> q\n```\ncode\n```\n---\nend');

  assert.deepEqual(strataNoteLines(html).map((l) => [l.line_key, l.text, l.kind, l.line_number]), [
    ['p:0', 'Intro', 'paragraph', 1],
    ['p:1.0.0', 'a', 'item', 2],
    ['p:1.0.1.0.0', 'a1', 'item', 2],
    ['p:2.0.0', 'task', 'task-open', 3],
    ['p:3.0', 'q', 'quote', 4],
    ['p:4', 'code', 'code', 5],
    ['p:6', 'end', 'paragraph', 7],
  ]);
});
