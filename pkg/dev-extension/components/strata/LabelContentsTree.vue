<script setup lang="ts">
/**
 * Everything under a label, as one tree: the labels above it (each with what it holds), the
 * label itself, its notes by title with the lines labelled in them - each line's text read live
 * from the note, and the list items nested under it - then its child labels, the same way down.
 * Labels open their page, notes open the note, lines open the note on that line; the × that
 * shows on hover takes the label off a note or a line.
 */
import { computed, watch } from 'vue';
import { useHostRouter } from '../../strata/router';
import { useLabelsStore, useNotesStore, useLineLabelsStore } from '../../strata/stores';
import ColorDot from './ColorDot.vue';
import type { Note, Label, LineLabel } from '../../strata/api';
import { extractLineText, extractLineDescendants, truncateText } from '../../strata/noteLines';
import {
  DEV_PRODUCT, BLANK_CLUSTER, STRATA_NOTE_ROUTE, STRATA_LABEL_ROUTE
} from '../../config/constants';

const props = defineProps<{ labelId: string }>();

const router = useHostRouter();
const labelsStore = useLabelsStore();
const notesStore = useNotesStore();
const lineLabelsStore = useLineLabelsStore();

const label = computed(() => labelsStore.getLabelById(props.labelId));

const ancestors = computed(() => {
  const chain: Label[] = [];
  let current = label.value;
  while (current?.parent_id) {
    const parent = labelsStore.getLabelById(current.parent_id);
    if (!parent || chain.some(c => c.id === parent.id)) break;
    chain.unshift(parent);
    current = parent;
  }
  return chain;
});

function notesForLabel(labelId: string): Note[] {
  return notesStore.all
    .filter(n => n.label_ids.includes(labelId))
    .sort((a, b) => a.title.localeCompare(b.title) || a.created_at.localeCompare(b.created_at));
}

interface TreeRow {
  type: 'label' | 'note' | 'line' | 'line-desc';
  id: string;
  depth: number;
  isCurrent?: boolean;
  parentLabelId?: string;
  noteId?: string;
  lineKey?: string;
  lineNumber?: number;
  descText?: string;
  isChecked?: boolean;
}

function rowLabel(row: TreeRow) { return labelsStore.getLabelById(row.id); }
function rowNote(row: TreeRow) { return notesStore.getNoteById(row.noteId || row.id); }
function rowLineText(row: TreeRow): string {
  const num = row.lineNumber || 1;
  const content = notesStore.getNoteById(row.noteId || '')?.content || '';
  const text = extractLineText(content, row.lineKey || '', num);
  const ll = lineLabelsStore.lineLabels.find(l => l.id === row.id);
  return text || ll?.line_text || '';
}

const unifiedTree = computed(() => {
  const rows: TreeRow[] = [];
  if (!label.value) return rows;

  function addLineWithDescendants(ll: LineLabel, baseDepth: number, labelId: string) {
    const num = ll.line_number || (parseInt(ll.line_key.replace(/^(p|pos|line):/, '').split('.')[0]) + 1) || 1;
    rows.push({ type: 'line', id: ll.id, depth: baseDepth, noteId: ll.note_id, parentLabelId: labelId, lineNumber: num, lineKey: ll.line_key });
    const content = notesStore.getNoteById(ll.note_id)?.content || '';
    const descs = extractLineDescendants(content, ll.line_key, num);
    for (const d of descs) {
      rows.push({ type: 'line-desc', id: `${ll.id}-d${rows.length}`, depth: baseDepth + 1 + d.depth, descText: d.text, noteId: ll.note_id, lineKey: ll.line_key, isChecked: d.checked });
    }
  }

  /*
   * `path` is the rest of the way down to the current label. An ancestor goes on down that path
   * alone: walking all its children took the current label's whole subtree with it, and then
   * the loop that followed added it all again, in bold.
   */
  function addLabelContents(labelId: string, depth: number, isCurrent: boolean, path: string[] = []) {
    rows.push({ type: 'label', id: labelId, depth, isCurrent });

    const notes = notesForLabel(labelId);
    const lls = lineLabelsStore.forLabel(labelId);
    const linesByNote = new Map<string, LineLabel[]>();
    for (const ll of lls) {
      const arr = linesByNote.get(ll.note_id) || [];
      arr.push(ll);
      linesByNote.set(ll.note_id, arr);
    }

    const noteIdsShown = new Set<string>();

    for (const note of notes) {
      noteIdsShown.add(note.id);
      rows.push({ type: 'note', id: note.id, depth: depth + 1, parentLabelId: labelId });
      for (const ll of linesByNote.get(note.id) || []) {
        addLineWithDescendants(ll, depth + 2, labelId);
      }
    }

    for (const [noteId, noteLines] of linesByNote) {
      if (noteIdsShown.has(noteId)) continue;
      rows.push({ type: 'note', id: noteId, depth: depth + 1, parentLabelId: labelId });
      for (const ll of noteLines) {
        addLineWithDescendants(ll, depth + 2, labelId);
      }
    }

    if (path.length) {
      addLabelContents(path[0], depth + 1, path.length === 1, path.slice(1));

      return;
    }
    for (const child of labelsStore.getChildren(labelId)) {
      addLabelContents(child.id, depth + 1, false);
    }
  }

  const chain = [...ancestors.value.map((a) => a.id), props.labelId];

  addLabelContents(chain[0], 0, chain.length === 1, chain.slice(1));

  return rows;
});

function getAllLabelIds(): string[] {
  const ids = [props.labelId];
  for (const anc of ancestors.value) ids.push(anc.id);
  function walk(parentId: string) {
    for (const child of labelsStore.getChildren(parentId)) {
      ids.push(child.id);
      walk(child.id);
    }
  }
  walk(props.labelId);
  return ids;
}

// Every label the tree shows, fetched again whenever that set changes (a new parent, say).
watch(() => getAllLabelIds().join(','), () => {
  Promise.all(getAllLabelIds().map((lid) => lineLabelsStore.fetchForLabel(lid))).catch(() => {});
}, { immediate: true });

async function removeFromNote(noteId: string, labelId: string) {
  await notesStore.removeNoteLabel(noteId, labelId);
}

async function removeLineLabel(recordId: string) {
  await lineLabelsStore.remove(recordId);
}

function noteTo(id: string, hl?: string) {
  return {
    name: STRATA_NOTE_ROUTE, params: { product: DEV_PRODUCT, cluster: BLANK_CLUSTER, id }, ...(hl ? { query: { hl } } : {})
  };
}

function labelTo(id: string) {
  return { name: STRATA_LABEL_ROUTE, params: { product: DEV_PRODUCT, cluster: BLANK_CLUSTER, id } };
}

function goToLine(noteId: string, lineKey: string) {
  router.push(noteTo(noteId, lineKey));
}
</script>

<template>
  <div
    class="strata-tree"
    data-testid="strata-tree"
  >
    <div
      v-for="(row, i) in unifiedTree"
      :key="row.type + '-' + row.id + '-' + i"
      class="strata-tree__row"
      :class="[`strata-tree__row--${ row.type }`, { 'strata-tree__row--current': row.isCurrent }]"
      :style="{ paddingLeft: `${ row.depth * 20 + 12 }px` }"
      :data-testid="`strata-tree-${ row.type }`"
    >
      <template v-if="row.type === 'label'">
        <ColorDot :color="rowLabel(row)?.color || ''" />
        <router-link
          v-if="!row.isCurrent"
          class="strata-tree__label"
          :to="labelTo(row.id)"
        >
          {{ rowLabel(row)?.name }}
        </router-link>
        <span
          v-else
          class="strata-tree__label strata-tree__label--current"
        >{{ rowLabel(row)?.name }}</span>
      </template>
      <template v-else-if="row.type === 'note'">
        <i class="icon icon-file strata-tree__icon" />
        <router-link
          class="strata-tree__note"
          :to="noteTo(row.id)"
        >
          {{ rowNote(row)?.title || 'Untitled' }}
        </router-link>
        <button
          type="button"
          class="strata-tree__remove"
          title="Remove label"
          aria-label="Remove label from this note"
          data-testid="strata-tree-remove-note"
          @click.stop="removeFromNote(row.id, row.parentLabelId!)"
        >
          <i class="icon icon-close" />
        </button>
      </template>
      <template v-else-if="row.type === 'line'">
        <svg
          class="strata-tree__line-icon"
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          aria-hidden="true"
        >
          <line
            x1="3"
            y1="6"
            x2="21"
            y2="6"
          /><line
            x1="3"
            y1="12"
            x2="15"
            y2="12"
          /><line
            x1="3"
            y1="18"
            x2="18"
            y2="18"
          />
        </svg>
        <a
          class="strata-tree__line"
          :href="router.resolve(noteTo(row.noteId!, row.lineKey!)).href"
          :title="rowLineText(row)"
          @click.prevent="goToLine(row.noteId!, row.lineKey!)"
        >{{ truncateText(rowLineText(row)) || '(empty line)' }}</a>
        <button
          type="button"
          class="strata-tree__remove"
          title="Remove line label"
          aria-label="Remove label from this line"
          data-testid="strata-tree-remove-line"
          @click.stop="removeLineLabel(row.id)"
        >
          <i class="icon icon-close" />
        </button>
      </template>
      <template v-else-if="row.type === 'line-desc'">
        <span
          v-if="row.isChecked !== undefined"
          class="strata-tree__mark"
        >
          <svg
            v-if="row.isChecked"
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            aria-label="done"
          ><polyline points="9 11 12 14 22 4" /><rect
            x="3"
            y="3"
            width="18"
            height="18"
            rx="2"
          /></svg>
          <svg
            v-else
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            aria-label="not done"
          ><rect
            x="3"
            y="3"
            width="18"
            height="18"
            rx="2"
          /></svg>
        </span>
        <span
          v-else
          class="strata-tree__mark"
        >&#8226;</span>
        <span
          class="strata-tree__desc"
          :class="{ 'strata-tree__desc--done': row.isChecked }"
        >{{ truncateText(row.descText || '', 80) }}</span>
      </template>
    </div>
  </div>
</template>

<style lang="scss" scoped>
.strata-tree {
  padding:       var(--dev-space-3) 0;
  border:        1px solid var(--border);
  border-radius: var(--r-sm);
  background:    var(--box-bg);

  &__row {
    display:     flex;
    align-items: center;
    gap:         var(--dev-space-4);
    min-height:  32px;
    padding:     4px 12px;

    &--current { background: var(--sortable-table-hover-bg); }
    &--note:hover, &--line:hover { background: var(--sortable-table-hover-bg); }
    &--line-desc { min-height: 24px; padding-top: 2px; padding-bottom: 2px; opacity: 0.75; }
  }

  &__label {
    color:       var(--body-text);
    font-size:   13px;
    font-weight: 500;

    &--current { font-weight: 700; }
  }

  &__icon { flex-shrink: 0; color: var(--muted); font-size: 13px; }
  &__line-icon { flex-shrink: 0; color: var(--dev-accent); }

  &__note {
    flex:      1;
    min-width: 0;
    overflow:  hidden;
    font-size: 13px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  &__line {
    flex:          1;
    min-width:     0;
    overflow:      hidden;
    color:         var(--muted);
    font-size:     13px;
    text-overflow: ellipsis;
    white-space:   nowrap;

    &:hover { color: var(--dev-accent); text-decoration: underline; }
  }

  &__remove {
    flex-shrink: 0;
    width:       24px;
    height:      24px;
    min-height:  0;
    padding:     0;
    border:      0;
    background:  none;
    color:       var(--muted);
    line-height: 1;
    opacity:     0;
    cursor:      pointer;
    transition:  opacity 0.15s ease;

    &:hover { color: var(--error); }
    &:focus-visible { opacity: 1; }
  }

  &__row:hover &__remove { opacity: 1; }

  /* No hover on a touch screen: the × stays visible there. */
  @media (hover: none) {
    &__remove { opacity: 0.6; }
  }

  &__mark {
    display:         flex;
    flex-shrink:     0;
    align-items:     center;
    justify-content: center;
    width:           14px;
    color:           var(--muted);
    font-size:       10px;
  }

  &__desc {
    overflow:      hidden;
    color:         var(--muted);
    font-size:     12px;
    text-overflow: ellipsis;
    white-space:   nowrap;

    &--done { text-decoration: line-through; opacity: 0.6; }
  }
}
</style>
