// Convert the editor's HTML into Markdown for clipboard export
export function htmlToMarkdown(html: string): string {
  const div = document.createElement('div');
  div.innerHTML = html;

  function convert(node: Node, listDepth = 0): string {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent || '';
    if (node.nodeType !== Node.ELEMENT_NODE) return '';
    const el = node as HTMLElement;
    const tag = el.tagName.toLowerCase();
    const children = () => Array.from(el.childNodes).map(c => convert(c, listDepth)).join('');

    switch (tag) {
      case 'p': return children() + (el.parentElement?.closest('li') ? '\n' : '\n\n');
      case 'br': return '\n';
      case 'strong': case 'b': return `**${children()}**`;
      case 'em': case 'i': return `*${children()}*`;
      case 'u': return children();
      case 's': case 'del': return `~~${children()}~~`;
      case 'code': return `\`${children()}\``;
      case 'h1': return `# ${children()}\n\n`;
      case 'h2': return `## ${children()}\n\n`;
      case 'h3': return `### ${children()}\n\n`;
      case 'h4': return `#### ${children()}\n\n`;
      case 'blockquote': return children().split('\n').filter(l => l.trim()).map(l => `> ${l}`).join('\n') + '\n\n';
      case 'pre': {
        const code = el.querySelector('code');
        const lang = code?.className?.match(/language-(\w+)/)?.[1] || '';
        return '```' + lang + '\n' + (code?.textContent || el.textContent || '') + '\n```\n\n';
      }
      case 'ul': return Array.from(el.children).map(li => convert(li, listDepth)).join('') + (listDepth === 0 ? '\n' : '');
      case 'ol': return Array.from(el.children).map((li, i) => {
        const indent = '  '.repeat(listDepth);
        const inner = Array.from(li.childNodes).map(c => convert(c, listDepth + 1)).join('').trim();
        return `${indent}${i + 1}. ${inner}\n`;
      }).join('') + (listDepth === 0 ? '\n' : '');
      case 'li': {
        const indent = '  '.repeat(listDepth);
        const isTask = el.hasAttribute('data-checked');
        const check = isTask ? (el.getAttribute('data-checked') === 'true' ? '[x]' : '[ ]') : '-';
        const inner = Array.from(el.childNodes).map(c => convert(c, listDepth + 1)).join('').trim();
        return `${indent}${check} ${inner}\n`;
      }
      case 'img': return `![${el.getAttribute('alt') || ''}](${el.getAttribute('src') || ''})\n`;
      default: return children();
    }
  }

  return convert(div).replace(/\n{3,}/g, '\n\n').trim();
}

// Ids of all note-hosted images referenced by an HTML string
export function getImageIds(html: string): Set<string> {
  const ids = new Set<string>();
  const re = /\/(?:api|strata)\/images\/([^/"?]+)/g;
  let m;
  while ((m = re.exec(html)) !== null) ids.add(m[1]);
  return ids;
}
