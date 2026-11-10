import type { Editor } from '@tiptap/core';

// Line keys identify a block by its child-index path, e.g. "p:0.2.1"

// Build a map of path keys to positions by scanning the doc
export function buildPathMap(doc: any): Map<string, number> {
  const map = new Map<string, number>();
  function walk(node: any, basePath: number[], basePos: number) {
    node.forEach((child: any, offset: number, index: number) => {
      const childPos = basePos + offset;
      const path = [...basePath, index];
      map.set(`p:${path.join('.')}`, childPos);
      if (child.childCount > 0) {
        walk(child, path, childPos + 1);
      }
    });
  }
  walk(doc, [], 0);
  return map;
}

export function getLineKeyAtCursor(editor: Editor | undefined): string | null {
  if (!editor) return null;
  const { $from } = editor.state.selection;
  const indices: number[] = [];
  for (let d = 1; d <= $from.depth; d++) {
    indices.push($from.index(d - 1));
  }
  if (indices.length === 0) return null;
  return `p:${indices.join('.')}`;
}

// Text content of the block at the cursor (capped for storage)
export function getLineTextAtCursor(editor: Editor | undefined): string {
  if (!editor) return '';
  const { $from } = editor.state.selection;
  for (let d = $from.depth; d > 0; d--) {
    const node = $from.node(d);
    if (node.isBlock) {
      return node.textContent.slice(0, 100);
    }
  }
  return '';
}

// 1-based index of the top-level block containing the cursor
export function getLineNumberAtCursor(editor: Editor | undefined): number {
  if (!editor) return 0;
  const { $from } = editor.state.selection;
  return $from.index(0) + 1;
}
