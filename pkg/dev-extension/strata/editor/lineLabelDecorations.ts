import { Extension, type Editor } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { LineLabel } from '../api';
import { buildPathMap } from './lineKeys';

const REFRESH_META = 'refreshLineLabels';
const decorationPluginKey = new PluginKey('lineLabels');

export interface LineLabelDecorationSources {
  getLineLabels: () => LineLabel[];
  getLabelColor: (labelId: string) => string | undefined;
  getHighlightKey: () => string | null | undefined;
}

// Re-run decoration building (call after the line-label set changes)
export function refreshDecorations(editor: Editor | undefined) {
  if (!editor) return;
  const tr = editor.state.tr.setMeta(REFRESH_META, true);
  editor.view.dispatch(tr);
}

function buildDecorations(doc: any, sources: LineLabelDecorationSources): DecorationSet {
  const lineLabels = sources.getLineLabels();
  // Not an early return when there are no labels: a `?hl=` highlight is drawn below, and a note
  // whose labelled line was since unlabelled still has a line to light.
  if (lineLabels.length === 0 && !sources.getHighlightKey()) return DecorationSet.empty;

  const pathMap = buildPathMap(doc);
  const byLine = new Map<string, LineLabel[]>();
  for (const ll of lineLabels) {
    const arr = byLine.get(ll.line_key) || [];
    arr.push(ll);
    byLine.set(ll.line_key, arr);
  }

  const decorations: Decoration[] = [];
  byLine.forEach((labels, lineKey) => {
    const pos = pathMap.get(lineKey);
    if (pos === undefined) return;

    try {
      const node = doc.nodeAt(pos);
      if (!node) return;

      // Up to 3 dots, stacked diagonally:
      // ::after is the bottom-left dot (first label color),
      // box-shadows go up+right for additional labels
      const colors = labels.slice(0, 3).map(ll => sources.getLabelColor(ll.label_id) || '#f472b6');
      const baseColor = colors[0];
      const extraShadows = colors.slice(1).map((c, i) =>
        `${(i + 1) * -4}px ${(i + 1) * -4}px 0 0 ${c}`
      );

      decorations.push(Decoration.node(pos, pos + node.nodeSize, {
        class: 'has-line-labels',
        style: `--ll-bg: ${baseColor}; --ll-shadow: ${extraShadows.join(', ') || '0 0 0 0 transparent'};`,
      }));
    } catch {
      // Invalid position
    }
  });

  const highlightKey = sources.getHighlightKey();
  if (highlightKey) {
    // Translate old key formats to the current p: format
    let hlKey = highlightKey;
    if (hlKey.startsWith('line:')) hlKey = 'p:' + hlKey.slice(5);
    else if (hlKey.startsWith('pos:')) hlKey = 'p:' + hlKey.slice(4);

    let hlPos = pathMap.get(hlKey);
    if (hlPos !== undefined) {
      try {
        let hlNode = doc.nodeAt(hlPos);
        // Drill into containers (lists, blockquotes) to the first textblock
        while (hlNode && !hlNode.isTextblock && hlNode.firstChild) {
          hlPos += 1;
          hlNode = hlNode.firstChild;
        }
        if (hlNode) {
          decorations.push(Decoration.node(hlPos, hlPos + hlNode.nodeSize, { class: 'highlighted-line' }));
        }
      } catch { /* ignore */ }
    }
  }

  return DecorationSet.create(doc, decorations);
}

// Colored margin dots for labeled lines + the jump-target line highlight
export function createLineLabelDecorations(sources: LineLabelDecorationSources) {
  return Extension.create({
    name: 'lineLabelDecorations',
    addProseMirrorPlugins() {
      return [
        new Plugin({
          key: decorationPluginKey,
          state: {
            init: (_, { doc }) => buildDecorations(doc, sources),
            apply: (tr, oldDecos) => {
              if (tr.docChanged || tr.getMeta(REFRESH_META)) {
                return buildDecorations(tr.doc, sources);
              }
              return oldDecos.map(tr.mapping, tr.doc);
            }
          },
          props: {
            decorations(state) {
              return this.getState(state);
            }
          }
        })
      ];
    }
  });
}
