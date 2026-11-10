// Pure helpers that locate a labeled line inside a note's HTML content and
// extract display text for it. Line keys are child-index paths ("p:0.2.1").

import { parseNoteHtml } from './parseHtml';

export function resolveLineElement(content: string, lineKey: string, lineNumber: number): Element | null {
  if (!content) return null;
  const div = parseNoteHtml(content);

  const indices = lineKey.replace(/^(p|pos|line):/, '').split('.').map(Number);
  let el: Element | null = div;
  for (const idx of indices) {
    if (!el || isNaN(idx)) break;
    el = el.children[idx] || null;
  }
  if (!el || el === div) {
    // Fallback: use lineNumber as top-level index
    el = div.children[(lineNumber || 1) - 1] || null;
  }
  return el;
}

export function extractLineText(content: string, lineKey: string, lineNumber: number): string {
  const el = resolveLineElement(content, lineKey, lineNumber);
  if (!el) return '';

  // If we landed on a container (list, blockquote), grab the first paragraph's text only
  const leaf = el.querySelector('p, pre, h1, h2, h3, h4, h5, h6');
  const target = (leaf && leaf !== el) ? leaf : el;

  // Get only direct text, not nested block text
  let text = '';
  for (const node of Array.from(target.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE || (node.nodeType === Node.ELEMENT_NODE && !(node as Element).matches('ul, ol, blockquote'))) {
      text += node.textContent || '';
    }
  }
  return text.trim();
}

export interface LineDescendant {
  text: string;
  depth: number;
  checked?: boolean;
}

export function extractLineDescendants(content: string, lineKey: string, lineNumber: number): LineDescendant[] {
  let el = resolveLineElement(content, lineKey, lineNumber);
  if (!el) return [];

  const tag = el.tagName.toLowerCase();
  if (tag === 'p' || tag === 'pre' || /^h[1-6]$/.test(tag)) {
    const parent = el.parentElement;
    if (parent && parent.tagName.toLowerCase() === 'li') el = parent;
  }

  const results: LineDescendant[] = [];

  function walkChildren(parent: Element, depth: number) {
    for (const child of Array.from(parent.children)) {
      const tag = child.tagName.toLowerCase();
      if (tag === 'ul' || tag === 'ol') {
        for (const li of Array.from(child.children)) {
          if (li.tagName.toLowerCase() !== 'li') continue;
          let text = '';
          for (const node of Array.from(li.childNodes)) {
            if (node.nodeType === Node.TEXT_NODE) {
              text += node.textContent || '';
            } else if (node.nodeType === Node.ELEMENT_NODE) {
              const t = (node as Element).tagName.toLowerCase();
              if (t !== 'ul' && t !== 'ol') text += (node as Element).textContent || '';
            }
          }
          text = text.trim();
          const checked = li.getAttribute('data-checked') === 'true' ? true :
                          li.getAttribute('data-checked') === 'false' ? false : undefined;
          if (text) results.push({ text, depth, checked });
          walkChildren(li, depth + 1);
        }
      }
    }
  }

  walkChildren(el, 0);
  return results;
}

export function truncateText(text: string, maxLen = 60): string {
  if (!text) return '';
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + '...';
}
