<script setup lang="ts">
/** Strata's formatting row: marks, lists, quote, code and a picture. Kept from Strata as it was. */
import type { Editor } from '@tiptap/core';
import { S } from '../../strata/editor/icons';

const props = defineProps<{
  editor: Editor | undefined;
}>();

const emit = defineEmits<{ (e: 'insert-image'): void }>();

type ToolbarAction = {
  svg: string;
  title: string;
  shortcut?: string;
  action: () => void;
  isActive?: () => boolean;
  sep?: boolean;
};

const tools: ToolbarAction[] = [
  {
    svg: S('<path d="M6 4h8a4 4 0 0 1 4 4 4 4 0 0 1-4 4H6z"/><path d="M6 12h9a4 4 0 0 1 4 4 4 4 0 0 1-4 4H6z"/>'),
    title: 'Bold', shortcut: 'Ctrl+B',
    action: () => props.editor?.chain().focus().toggleBold().run(),
    isActive: () => props.editor?.isActive('bold') ?? false,
  },
  {
    svg: S('<line x1="19" y1="4" x2="10" y2="4"/><line x1="14" y1="20" x2="5" y2="20"/><line x1="15" y1="4" x2="9" y2="20"/>'),
    title: 'Italic', shortcut: 'Ctrl+I',
    action: () => props.editor?.chain().focus().toggleItalic().run(),
    isActive: () => props.editor?.isActive('italic') ?? false,
  },
  {
    svg: S('<path d="M6 3v7a6 6 0 0 0 6 6 6 6 0 0 0 6-6V3"/><line x1="4" y1="21" x2="20" y2="21"/>'),
    title: 'Underline', shortcut: 'Ctrl+U',
    action: () => props.editor?.chain().focus().toggleUnderline().run(),
    isActive: () => props.editor?.isActive('underline') ?? false,
  },
  { svg: '', title: '', action: () => {}, sep: true },
  {
    svg: S('<line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/>'),
    title: 'Bullet List',
    action: () => props.editor?.chain().focus().toggleBulletList().run(),
    isActive: () => props.editor?.isActive('bulletList') ?? false,
  },
  {
    svg: S('<line x1="10" y1="6" x2="21" y2="6"/><line x1="10" y1="12" x2="21" y2="12"/><line x1="10" y1="18" x2="21" y2="18"/><path d="M4 6h1v4"/><path d="M4 10h2"/><path d="M6 18H4c0-1 2-2 2-3s-1-1.5-2-1"/>'),
    title: 'Numbered List',
    action: () => props.editor?.chain().focus().toggleOrderedList().run(),
    isActive: () => props.editor?.isActive('orderedList') ?? false,
  },
  {
    svg: S('<polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>'),
    title: 'Checklist',
    action: () => props.editor?.chain().focus().toggleTaskList().run(),
    isActive: () => props.editor?.isActive('taskList') ?? false,
  },
  { svg: '', title: '', action: () => {}, sep: true },
  {
    svg: S('<path d="M3 21c3 0 7-1 7-8V5c0-1.25-.756-2.017-2-2H4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2 1 0 1 0 1 1v1c0 1-1 2-2 2s-1 .008-1 1.031V21z"/><path d="M15 21c3 0 7-1 7-8V5c0-1.25-.757-2.017-2-2h-4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2h.75c0 2.25.25 4-2.75 4v3z"/>'),
    title: 'Blockquote',
    action: () => {
      const e = props.editor;
      if (!e) return;
      if (e.isActive('blockquote')) {
        e.chain().focus().lift('blockquote').run();
      } else {
        const success = e.chain().focus().toggleBlockquote().run();
        if (!success) {
          e.chain().focus().wrapIn('blockquote').run();
        }
      }
    },
    isActive: () => props.editor?.isActive('blockquote') ?? false,
  },
  {
    svg: S('<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>'),
    title: 'Code Block',
    action: () => props.editor?.chain().focus().toggleCodeBlock().run(),
    isActive: () => props.editor?.isActive('codeBlock') ?? false,
  },
  {
    svg: S('<rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>'),
    title: 'Insert Image',
    action: () => emit('insert-image'),
  },
];
</script>

<template>
  <div
    class="strata-toolbar"
    role="toolbar"
    aria-label="Formatting"
    data-testid="strata-toolbar"
  >
    <template
      v-for="(tool, i) in tools"
      :key="i"
    >
      <div
        v-if="tool.sep"
        class="strata-toolbar__sep"
      />
      <button
        v-else
        type="button"
        class="strata-toolbar__btn"
        :class="{ 'strata-toolbar__btn--on': tool.isActive?.() }"
        :title="tool.title + (tool.shortcut ? ` (${ tool.shortcut })` : '')"
        :aria-label="tool.title"
        :aria-pressed="tool.isActive ? !!tool.isActive() : undefined"
        :data-testid="`strata-tool-${ tool.title.toLowerCase().replace(/\s+/g, '-') }`"
        @pointerdown.prevent
        @mousedown.prevent
        @click="tool.action"
        v-html="tool.svg"
      />
    </template>
  </div>
</template>

<style lang="scss" scoped>
.strata-toolbar {
  display:         flex;
  align-items:     center;
  gap:             var(--dev-space-3);
  padding:         var(--dev-space-3) 0;
  overflow-x:      auto;
  overflow-y:      hidden;
  flex-shrink:     0;
  scrollbar-width: none;

  &::-webkit-scrollbar { display: none; }

  &__btn {
    display:         inline-flex;
    flex-shrink:     0;
    align-items:     center;
    justify-content: center;
    width:           var(--dev-control);
    height:          var(--dev-control);
    min-height:      0;
    padding:         0;
    border:          1px solid var(--border);
    border-radius:   var(--r-sm);
    background:      var(--body-bg);
    color:           var(--body-text);
    line-height:     1;
    cursor:          pointer;

    :deep(svg) { width: 14px; height: 14px; }

    &:hover { border-color: var(--dev-accent); }

    &--on {
      border-color: var(--dev-accent);
      background:   color-mix(in srgb, var(--dev-accent) 14%, transparent);
      color:        var(--dev-accent);
    }
  }

  &__sep {
    flex-shrink: 0;
    width:       1px;
    height:      18px;
    margin:      0 var(--dev-space-1);
    background:  var(--border);
  }
}
</style>
