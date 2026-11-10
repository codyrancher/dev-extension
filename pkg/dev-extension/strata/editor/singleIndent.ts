import { Extension } from '@tiptap/core';
import { TextSelection } from '@tiptap/pm/state';
import { Fragment, Node as PmNode } from '@tiptap/pm/model';

// Indent a list item exactly one level, keeping its children at their depth
// (tiptap's sinkListItem drags the nested list down a level too).
export function sinkListItemSingle(itemTypeName: string, editor: any): boolean {
  const { state, dispatch } = editor.view;
  const { $from, $to } = state.selection;
  const itemType = state.schema.nodes[itemTypeName];
  if (!itemType) return false;

  const range = $from.blockRange($to, (node: PmNode) => node.childCount > 0 && node.firstChild!.type === itemType);
  if (!range) return false;

  const parent = range.parent;
  const startIndex = range.startIndex;
  if (startIndex === 0) return false;

  const currentItem = parent.child(startIndex);
  const prevItem = parent.child(startIndex - 1);
  if (prevItem.type !== itemType) return false;

  const hasNestedList = currentItem.childCount > 1 && currentItem.lastChild!.type === parent.type;
  if (!hasNestedList) {
    return editor.commands.sinkListItem(itemTypeName);
  }

  const nestedList = currentItem.lastChild!;
  const listType = parent.type;

  const contentNodes: PmNode[] = [];
  for (let i = 0; i < currentItem.childCount - 1; i++) {
    contentNodes.push(currentItem.child(i));
  }
  const contentOnlyItem = itemType.create(currentItem.attrs, Fragment.from(contentNodes));

  const formerChildren: PmNode[] = [];
  for (let i = 0; i < nestedList.childCount; i++) {
    formerChildren.push(nestedList.child(i));
  }

  const subListItems = [contentOnlyItem, ...formerChildren];

  const prevChildren: PmNode[] = [];
  let existingSizes = 0;
  for (let i = 0; i < prevItem.childCount; i++) {
    const child = prevItem.child(i);
    if (i === prevItem.childCount - 1 && child.type === listType) {
      const existing: PmNode[] = [];
      for (let j = 0; j < child.childCount; j++) {
        existing.push(child.child(j));
        existingSizes += child.child(j).nodeSize;
      }
      prevChildren.push(listType.create(child.attrs, Fragment.from([...existing, ...subListItems])));
    } else {
      prevChildren.push(child);
    }
  }
  if (existingSizes === 0 && !(prevItem.lastChild && prevItem.lastChild.type === listType)) {
    prevChildren.push(listType.create(null, Fragment.from(subListItems)));
  }
  const newPrevItem = itemType.create(prevItem.attrs, Fragment.from(prevChildren));

  const prevItemPos = range.start - prevItem.nodeSize;
  const tr = state.tr;
  tr.replaceWith(prevItemPos, range.end, [newPrevItem]);

  let cursorPos = prevItemPos + 1;
  for (let i = 0; i < prevChildren.length - 1; i++) {
    cursorPos += prevChildren[i].nodeSize;
  }
  cursorPos += 1 + existingSizes + 1 + 1;
  tr.setSelection(TextSelection.near(tr.doc.resolve(cursorPos)));

  dispatch(tr.scrollIntoView());
  return true;
}

export const SingleIndent = Extension.create({
  name: 'singleIndent',
  addKeyboardShortcuts() {
    return {
      Tab: ({ editor }) => {
        if (editor.isActive('listItem')) return sinkListItemSingle('listItem', editor);
        if (editor.isActive('taskItem')) return sinkListItemSingle('taskItem', editor);
        return false;
      },
    };
  },
});
