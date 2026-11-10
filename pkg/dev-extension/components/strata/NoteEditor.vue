<script setup lang="ts">
/**
 * A note being written: Strata's editor, Tiptap with Strata's own extensions, as it was there.
 *
 * Rich text with Markdown's typing rules (`- `, `[ ] `, ``` and the rest) rather than Markdown
 * source, because that is what Strata is and what its notes hold. What changed in the move:
 * pictures are drawn from dev-api and saved under Strata's own `/api/images/` path; right-click
 * puts the caret on the line under the pointer before labelling it, so the label lands on the
 * line that was clicked; and "Label this line" from the tools opens beside the caret rather than
 * in the corner of the window.
 */
import {
  ref, watch, onBeforeUnmount, onMounted, computed, nextTick
} from 'vue';
import { useEditor, EditorContent } from '@tiptap/vue-3';
import { mergeAttributes } from '@tiptap/core';
import { DOMSerializer } from '@tiptap/pm/model';
import StarterKit from '@tiptap/starter-kit';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import ListItem from '@tiptap/extension-list-item';
import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight';
import { common, createLowlight } from 'lowlight';
import Image from '@tiptap/extension-image';
import Link from '@tiptap/extension-link';
import Underline from '@tiptap/extension-underline';
import Placeholder from '@tiptap/extension-placeholder';
import ImageViewer from './ImageViewer.vue';
import LabelSearchInput from './LabelSearchInput.vue';
import PageHeader from './PageHeader.vue';
import EditorToolbar from './EditorToolbar.vue';
import QuickToolsBar from './QuickToolsBar.vue';
import LineLabelPopover from './LineLabelPopover.vue';
import ImagePickerMenu from './ImagePickerMenu.vue';
import { sinkListItemSingle, SingleIndent } from '../../strata/editor/singleIndent';
import { CodeBlockNewline, TaskCheckboxNoScroll } from '../../strata/editor/extensions';
import { createLineLabelDecorations, refreshDecorations } from '../../strata/editor/lineLabelDecorations';
import { getLineKeyAtCursor, getLineTextAtCursor, getLineNumberAtCursor } from '../../strata/editor/lineKeys';
import { htmlToMarkdown, getImageIds } from '../../strata/editor/markdown';
import { downloadNoteMarkdown } from '../../strata/editor/noteDownload';
import { sandBlowElement } from '../../strata/editor/sandBlow';
import { useLabelsStore, useLineLabelsStore, strataProblem } from '../../strata/stores';
import {
  api, imagePath, imageSrc, storedHtml
} from '../../strata/api';
import { prepareImage } from '../../strata/images';
import '../../strata/style';

const props = defineProps<{
  noteId: string;
  content: string;
  title: string;
  noteLabelIds: string[];
  notePinned: boolean;
  highlightLineKey?: string | null;
  /** Make the note on the server if it is not there yet: a picture needs a note to belong to. */
  ensureCreated:(() => Promise<void>);
}>();

const emit = defineEmits<{
  (e: 'update:content', value: string): void;
  (e: 'update:title', value: string): void;
  (e: 'toggle-note-label', labelId: string): void;
  (e: 'toggle-pin'): void;
  (e: 'delete'): void;
  (e: 'clear-highlight'): void;
}>();

const labelsStore = useLabelsStore();
const lineLabelsStore = useLineLabelsStore();

const rootEl = ref<HTMLElement | null>(null);
const viewingImage = ref<string | null>(null);

// ── Phone or not, keyboard up or not ──
// The product's one breakpoint. "Keyboard up" is a focused editor on a phone, or a visual
// viewport a keyboard's height shorter than the window, whichever is noticed first.
const width = ref(window.innerWidth);
const focused = ref(false);
const keyboardHeight = ref(0);
const isMobile = computed(() => width.value <= 760);
const keyboardOpen = computed(() => isMobile.value && (focused.value || keyboardHeight.value > 50));

function measure() {
  width.value = window.innerWidth;
  keyboardHeight.value = window.visualViewport ? window.innerHeight - window.visualViewport.height : 0;
}

onMounted(() => {
  window.addEventListener('resize', measure);
  window.visualViewport?.addEventListener('resize', measure);
});

// ── Line labels ──
const lineLabels = computed(() => lineLabelsStore.forNote(props.noteId));
const showLineLabelPicker = ref(false);
const currentLineKey = ref<string | null>(null);
const lineLabelPos = ref<{ x: number; y: number } | null>(null);

const refresh = () => refreshDecorations(editor.value);

lineLabelsStore.fetchForNote(props.noteId).then(() => nextTick(refresh));

const currentLineLabels = computed(() => {
  if (!currentLineKey.value) {
    return [];
  }

  return lineLabels.value.filter((ll) => ll.line_key === currentLineKey.value).map((ll) => ll.label_id);
});

function openLineLabelAt(x: number, y: number) {
  const key = getLineKeyAtCursor(editor.value);

  if (!key) {
    return;
  }
  currentLineKey.value = key;
  lineLabelPos.value = { x, y };
  showLineLabelPicker.value = true;
}

/** From the tools: beside the caret, so it is plainly about that line. */
function openLineLabelPicker() {
  const e = editor.value;

  if (!e) {
    return;
  }
  let x = 16;
  let y = 16;

  try {
    const at = e.view.coordsAtPos(e.state.selection.from);

    x = at.left;
    y = at.bottom + 6;
  } catch { /* no layout yet: the corner will do */ }
  openLineLabelAt(x, y);
}

function closeLineLabelPicker() {
  showLineLabelPicker.value = false;
  lineLabelPos.value = null;
}

function handleContextMenu(e: MouseEvent) {
  const ed = editor.value;

  if (isMobile.value || !ed) {
    return;
  }
  e.preventDefault();
  // The line under the pointer, not wherever the caret happened to be.
  const at = ed.view.posAtCoords({ left: e.clientX, top: e.clientY });

  if (at) {
    const { from, to } = ed.state.selection;

    if (at.pos < from || at.pos > to) {
      ed.commands.setTextSelection(at.pos);
    }
  }
  openLineLabelAt(e.clientX, e.clientY);
}

async function toggleLineLabel(labelId: string) {
  if (!currentLineKey.value) {
    return;
  }
  const existing = lineLabels.value.find((ll) => ll.line_key === currentLineKey.value && ll.label_id === labelId);

  if (existing) {
    lineLabelsStore.remove(existing.id);
  } else {
    // A label on a line of a note that is not saved yet needs the note first.
    await props.ensureCreated();
    lineLabelsStore.add(props.noteId, currentLineKey.value, labelId, getLineTextAtCursor(editor.value), getLineNumberAtCursor(editor.value));
  }
  nextTick(refresh);
}

// ── Editor ──
let uploadingImage = false;
let lastKnownImageIds = getImageIds(props.content);

/** Pictures drawn from dev-api; the document keeps Strata's path. See storedHtml. */
const StrataImage = Image.extend({
  renderHTML({ HTMLAttributes }) {
    return ['img', mergeAttributes(this.options.HTMLAttributes, HTMLAttributes, { src: imageSrc(HTMLAttributes.src) })];
  },
});

const editor = useEditor({
  content:    props.content,
  extensions: [
    StarterKit.configure({
      heading: false, strike: false, listItem: false, codeBlock: false
    }),
    CodeBlockLowlight.configure({ lowlight: createLowlight(common), defaultLanguage: null }),
    ListItem.extend({ content: '(paragraph | codeBlock | blockquote) block*' }),
    TaskList,
    TaskItem.extend({ content: '(paragraph | codeBlock | blockquote) block*' }).configure({ nested: true }),
    StrataImage.configure({ inline: true, allowBase64: true }),
    Link.configure({
      openOnClick: true, autolink: true, linkOnPaste: true, HTMLAttributes: { target: '_blank', rel: 'noopener noreferrer nofollow' }
    }),
    Underline,
    Placeholder.configure({ placeholder: 'Start writing...' }),
    CodeBlockNewline,
    SingleIndent,
    createLineLabelDecorations({
      getLineLabels:   () => lineLabels.value,
      getLabelColor:   (id) => labelsStore.getLabelById(id)?.color,
      getHighlightKey: () => props.highlightLineKey,
    }),
    TaskCheckboxNoScroll,
  ],
  onUpdate({ editor: e }) {
    if (uploadingImage) {
      return;
    }
    const html = storedHtml(e.getHTML());
    // A picture taken out of the text is deleted on the server.
    const currentIds = getImageIds(html);

    for (const id of lastKnownImageIds) {
      if (!currentIds.has(id)) {
        api.deleteImage(id).catch(() => {});
      }
    }
    lastKnownImageIds = currentIds;
    emit('update:content', html);
  },
  onSelectionUpdate() {
    const key = getLineKeyAtCursor(editor.value);

    if (showLineLabelPicker.value && key !== currentLineKey.value) {
      showLineLabelPicker.value = false;
    }
    currentLineKey.value = key;
  },
  onFocus() {
    focused.value = true;
  },
  onBlur() {
    setTimeout(() => {
      focused.value = !!editor.value?.isFocused;
      if (!showLineLabelPicker.value && !focused.value) {
        currentLineKey.value = null;
      }
    }, 150);
  },
  editorProps: {
    attributes: {
      class: 'strata-rich', spellcheck: 'false', 'data-testid': 'strata-editor'
    },
    handleClick(view, pos, event) {
      if (props.highlightLineKey) {
        emit('clear-highlight');
        nextTick(refresh);
      }
      const target = event.target as HTMLElement;

      if (target.tagName === 'IMG') {
        viewingImage.value = (target.getAttribute('src') || '').replace(/\/thumbnail$/, '');

        return true;
      }

      return false;
    },
  },
});

function noteHtml(): string {
  return storedHtml(editor.value?.getHTML() || '');
}

watch(lineLabels, () => nextTick(refresh), { deep: true });
watch(() => labelsStore.labels.map((l) => l.color).join(), () => nextTick(refresh));
watch(() => props.highlightLineKey, () => nextTick(() => {
  refresh();
  revealHighlight();
}));

watch(() => props.content, (val) => {
  if (editor.value && noteHtml() !== val) {
    editor.value.commands.setContent(val, false);
    lastKnownImageIds = getImageIds(val);
    nextTick(refresh);
  }
});

/** A line opened from a label is scrolled to, not left for the reader to find. */
function revealHighlight() {
  if (!props.highlightLineKey) {
    return;
  }
  setTimeout(() => rootEl.value?.querySelector('.highlighted-line')?.scrollIntoView({ block: 'center' }), 50);
}

watch(editor, (e) => {
  if (e) {
    nextTick(revealHighlight);
  }
}, { immediate: true });

onBeforeUnmount(() => {
  window.removeEventListener('resize', measure);
  window.visualViewport?.removeEventListener('resize', measure);
  editor.value?.destroy();
});

// ── Pictures ──
const showImageMenu = ref(false);

function uploadImage() {
  // On a phone the camera is a choice, not the default Android forces with `capture`.
  if (isMobile.value) {
    showImageMenu.value = true;
  } else {
    pickImageFile();
  }
}

function pickImageFile(capture?: 'environment') {
  showImageMenu.value = false;
  const input = document.createElement('input');

  input.type = 'file';
  input.accept = 'image/png,image/jpeg,image/gif,image/webp,image/avif,image/bmp';
  if (capture) {
    input.setAttribute('capture', capture);
  }
  input.style.display = 'none';
  document.body.appendChild(input);
  input.addEventListener('cancel', () => input.remove());
  input.onchange = async() => {
    input.remove();
    const file = input.files?.[0];

    if (file && editor.value) {
      await insertImage(file);
    }
  };
  input.click();
}

async function insertImage(file: File) {
  const e = editor.value;

  if (!e) {
    return;
  }
  const placeholder = URL.createObjectURL(file);

  uploadingImage = true;
  e.chain().focus().setImage({ src: placeholder, alt: 'Uploading...' }).run();
  try {
    await props.ensureCreated();
    const result = await api.uploadImage(props.noteId, await prepareImage(file));
    const html = noteHtml().split(placeholder).join(imagePath(result.id, true));

    e.commands.setContent(html, false);
    lastKnownImageIds = getImageIds(html);
    uploadingImage = false;
    emit('update:content', html);
  } catch (err: any) { // eslint-disable-line @typescript-eslint/no-explicit-any
    const html = noteHtml().replace(new RegExp(`<img[^>]*src="${ placeholder.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }"[^>]*>`, 'g'), '');

    e.commands.setContent(html, false);
    uploadingImage = false;
    emit('update:content', html);
    strataProblem.value = `The picture was not saved: ${ err?.message || err }`;
  } finally {
    uploadingImage = false;
    URL.revokeObjectURL(placeholder);
  }
}

// ── Line and checklist tools ──
async function copyNoteMarkdown() {
  const e = editor.value;

  if (!e) {
    return;
  }
  const { from, to, empty } = e.state.selection;
  let html: string;

  if (!empty) {
    const div = document.createElement('div');

    div.appendChild(DOMSerializer.fromSchema(e.schema).serializeFragment(e.state.doc.cut(from, to).content));
    html = storedHtml(div.innerHTML);
  } else {
    html = noteHtml();
  }
  await navigator.clipboard.writeText(htmlToMarkdown(html));
}

function downloadNote() {
  if (editor.value) {
    downloadNoteMarkdown(props.title, noteHtml());
  }
}

async function copyLine() {
  const e = editor.value;

  if (!e) {
    return;
  }
  const { $from } = e.state.selection;

  for (let d = $from.depth; d > 0; d--) {
    const node = $from.node(d);

    if (node.isBlock) {
      await navigator.clipboard.writeText(node.textContent);

      return;
    }
  }
}

function deleteCurrentLine() {
  const e = editor.value;

  if (!e) {
    return;
  }
  e.chain().focus(undefined, { scrollIntoView: false }).command(({ tr, state }) => {
    const { $from } = state.selection;
    // The whole list item inside a list, else the top-level block.
    let depth = 1;

    for (let d = $from.depth; d > 0; d--) {
      const name = $from.node(d).type.name;

      if (name === 'listItem' || name === 'taskItem') {
        depth = d;
        break;
      }
    }
    // The last child of its parent takes the parent with it: an empty list is not valid.
    while (depth > 1 && $from.node(depth - 1).childCount === 1) {
      depth -= 1;
    }
    if (depth === 1 && state.doc.childCount === 1) {
      tr.replaceWith(0, state.doc.content.size, state.schema.nodes.paragraph.create());

      return true;
    }
    const pos = $from.before(depth);

    tr.delete(pos, pos + $from.node(depth).nodeSize);

    return true;
  }).run();
}

function outdentListItem() {
  const e = editor.value;

  if (e && !e.chain().focus().liftListItem('listItem').run()) {
    e.chain().focus().liftListItem('taskItem').run();
  }
}

function indentListItem() {
  if (editor.value && !sinkListItemSingle('listItem', editor.value)) {
    sinkListItemSingle('taskItem', editor.value);
  }
}

const checkedItems = computed(() => {
  let count = 0;

  editor.value?.state.doc.descendants((node) => {
    if (node.type.name === 'taskItem' && node.attrs.checked) {
      count++;
    }
  });

  return count;
});

const clearing = ref(false);

async function clearCheckedItems() {
  const e = editor.value;

  if (!e || checkedItems.value === 0) {
    return;
  }
  clearing.value = true;
  let covers: HTMLElement[] = [];
  const prose = rootEl.value?.querySelector('.strata-editor-scroll .ProseMirror');

  if (prose) {
    try {
      covers = await Promise.all(Array.from(prose.querySelectorAll('li[data-checked="true"]')).map((el) => sandBlowElement(el as HTMLElement)));
    } catch { /* no animation, the items still go */ }
  }
  e.commands.command(({ tr, state }) => {
    const toDelete: { from: number; to: number }[] = [];

    state.doc.descendants((node, pos) => {
      if (node.type.name === 'taskList') {
        let allChecked = true;

        node.forEach((child) => {
          if (child.type.name === 'taskItem' && !child.attrs.checked) {
            allChecked = false;
          }
        });
        if (allChecked) {
          toDelete.push({ from: pos, to: pos + node.nodeSize });

          return false;
        }
      }
      if (node.type.name === 'taskItem' && node.attrs.checked) {
        toDelete.push({ from: pos, to: pos + node.nodeSize });

        return false;
      }
    });
    for (const { from, to } of toDelete.reverse()) {
      tr.delete(from, to);
    }

    return true;
  });
  covers.forEach((c) => c.remove());
  clearing.value = false;
  emit('update:content', noteHtml());
}

function uncheckAllItems() {
  const e = editor.value;

  if (!e || checkedItems.value === 0) {
    return;
  }
  e.commands.command(({ tr, state }) => {
    state.doc.descendants((node, pos) => {
      if (node.type.name === 'taskItem' && node.attrs.checked) {
        tr.setNodeMarkup(pos, undefined, { ...node.attrs, checked: false });
      }
    });

    return true;
  });
  emit('update:content', noteHtml());
}
</script>

<template>
  <div
    ref="rootEl"
    class="strata-editor"
  >
    <PageHeader
      :pinned="notePinned"
      delete-title="Delete note"
      @toggle-pin="emit('toggle-pin')"
      @delete="emit('delete')"
    >
      <input
        class="strata-editor__title"
        :value="title"
        type="text"
        placeholder="Note title..."
        aria-label="Title"
        data-testid="strata-title"
        @input="emit('update:title', ($event.target as HTMLInputElement).value)"
      >
    </PageHeader>
    <div
      class="strata-editor__labels"
      @touchstart.stop
      @touchmove.stop
    >
      <LabelSearchInput
        :selected-ids="noteLabelIds"
        placeholder="Add note label..."
        @toggle="emit('toggle-note-label', $event)"
      />
    </div>
    <EditorToolbar
      :editor="editor"
      @insert-image="uploadImage"
    />
    <div
      class="strata-editor-scroll"
      :class="{ 'strata-editor-scroll--clearing': clearing }"
      @contextmenu="handleContextMenu"
    >
      <EditorContent :editor="editor" />
    </div>
    <QuickToolsBar
      :is-mobile="isMobile"
      :keyboard-open="keyboardOpen"
      :checked-items="checkedItems"
      :clearing="clearing"
      :has-current-line="!!currentLineKey"
      @delete-line="deleteCurrentLine"
      @copy-line="copyLine"
      @label-line="openLineLabelPicker"
      @outdent="outdentListItem"
      @indent="indentListItem"
      @clear-checked="clearCheckedItems"
      @uncheck-all="uncheckAllItems"
      @copy-note="copyNoteMarkdown"
      @download-note="downloadNote"
    />
    <LineLabelPopover
      :open="showLineLabelPicker"
      :pos="lineLabelPos"
      :is-mobile="isMobile"
      :selected-ids="currentLineLabels"
      @toggle="toggleLineLabel"
      @close="closeLineLabelPicker"
    />
    <ImagePickerMenu
      v-if="showImageMenu"
      @close="showImageMenu = false"
      @pick="pickImageFile"
    />
    <ImageViewer
      v-if="viewingImage"
      :src="viewingImage"
      @close="viewingImage = null"
    />
  </div>
</template>

<style lang="scss" scoped>
.strata-editor {
  display:        flex;
  flex-direction: column;
  gap:            var(--dev-space-3);
  height:         100%;
  min-height:     0;

  &__title {
    flex:        1;
    min-width:   0;
    height:      auto;
    padding:     2px 0;
    border:      0;
    border-bottom: 1px solid transparent;
    border-radius: 0;
    background:  none;
    box-shadow:  none;
    color:       var(--body-text);
    font-size:   24px;
    font-weight: 600;
    line-height: 1.3;

    &:focus { border-bottom-color: var(--dev-accent); outline: none; }
    &::placeholder { color: var(--muted); }
  }

  &__labels { flex-shrink: 0; }
}

.strata-editor-scroll {
  flex:                1;
  min-height:          0;
  overflow-y:          auto;
  overscroll-behavior: contain;
  border-top:          1px solid var(--border);
}
</style>
