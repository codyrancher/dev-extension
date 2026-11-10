import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';

// Shift-Enter inserts a plain newline inside code blocks
export const CodeBlockNewline = Extension.create({
  name: 'codeBlockNewline',
  addKeyboardShortcuts() {
    return {
      'Shift-Enter': ({ editor }) => {
        if (editor.isActive('codeBlock')) {
          return editor.commands.command(({ tr, state }) => {
            const { $from } = state.selection;

            tr.insertText('\n', $from.pos);

            return true;
          });
        }

        return false;
      },
    };
  },
});

// Toggle task checkboxes without focusing the editor. TaskItem's own change
// handler calls editor.focus(), and the browser then scrolls the caret back
// into view — jumping away from wherever the user had scrolled. Intercept the
// change in the capture phase (before TaskItem's listener) and apply the
// toggle as a plain transaction: no focus, no selection change, no scroll.
export const TaskCheckboxNoScroll = Extension.create({
  name: 'taskCheckboxNoScroll',
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey('taskCheckboxNoScroll'),
        view(editorView) {
          const onChange = (event: Event) => {
            const target = event.target;

            if (!(target instanceof HTMLInputElement) || target.type !== 'checkbox') {
              return;
            }
            const li = target.closest('ul[data-type="taskList"] > li');

            if (!li) {
              return;
            }
            event.stopPropagation();
            const scroller = editorView.dom.closest('.strata-editor-scroll');
            const scrollTop = scroller?.scrollTop ?? 0;

            try {
              const pos = editorView.posAtDOM(li, 0) - 1;
              const node = editorView.state.doc.nodeAt(pos);

              if (node?.type.name !== 'taskItem') {
                return;
              }
              editorView.dispatch(editorView.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, checked: target.checked }));
            } catch { /* stale DOM node */ }
            if (scroller) {
              const restore = () => {
                if (scroller.scrollTop !== scrollTop) {
                  scroller.scrollTop = scrollTop;
                }
              };

              restore();
              requestAnimationFrame(restore);
              setTimeout(restore, 100);
            }
          };

          /*
           * A tap on the label around a box rather than on the box: on a phone the label is padded
           * to give the box a bigger reach, and a label's own click focuses its checkbox before it
           * clicks it - which took focus out of the editor and dropped the keyboard. Cancel that and
           * click the box directly, which toggles it (and runs onChange) without moving focus.
           */
          const taskLabel = (target: EventTarget | null) => (
            target instanceof HTMLLabelElement && target.matches('ul[data-type="taskList"] > li > label') ? target : null
          );
          const onLabelClick = (event: MouseEvent) => {
            const box = taskLabel(event.target)?.querySelector('input[type="checkbox"]');

            if (box instanceof HTMLInputElement) {
              event.preventDefault();
              event.stopPropagation();
              box.click();
            }
          };
          // The press on that label is what focuses the editor (it sits in the editable area), so
          // with nothing focused a tap beside a box brought the keyboard up; it moves no focus now.
          const onLabelPress = (event: MouseEvent) => {
            if (taskLabel(event.target)) {
              event.preventDefault();
            }
          };

          editorView.dom.addEventListener('change', onChange, true);
          editorView.dom.addEventListener('click', onLabelClick, true);
          editorView.dom.addEventListener('mousedown', onLabelPress, true);

          return {
            destroy: () => {
              editorView.dom.removeEventListener('change', onChange, true);
              editorView.dom.removeEventListener('click', onLabelClick, true);
              editorView.dom.removeEventListener('mousedown', onLabelPress, true);
            }
          };
        },
      }),
    ];
  },
});
