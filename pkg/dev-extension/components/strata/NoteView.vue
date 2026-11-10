<script setup lang="ts">
/**
 * One note open: Strata's EditorView. Mounted once per note (the page keys it by id), so moving
 * from one note to another starts clean rather than carrying the last one's text.
 *
 * A note that does not exist yet is made on the first thing typed, labelled or pinned, under the
 * id the URL already has. Title and text save 800 ms after the last change, and never when
 * nothing changed; leaving the page saves anything still waiting.
 */
import {
  ref, onMounted, onBeforeUnmount, watch, nextTick
} from 'vue';
import { useRoute, useRouter } from 'vue-router';
import NoteEditor from './NoteEditor.vue';
import {
  useNotesStore, loadStrata, strataProblem
} from '../../strata/stores';
import { api } from '../../strata/api';
import { DEV_PRODUCT, BLANK_CLUSTER, STRATA_ROUTE } from '../../config/constants';

const props = defineProps<{ noteId: string }>();
const route = useRoute();
const router = useRouter();
const notesStore = useNotesStore();

const title = ref('');
const content = ref('');
const labelIds = ref<string[]>([]);
const pinned = ref(false);
const loaded = ref(false);
const isNew = ref(false);
const wasDeleted = ref(false);
const highlightLineKey = ref<string | null>(null);
let created = false;
let creating: Promise<void> | null = null;

let saveTimer: ReturnType<typeof setTimeout> | undefined;
let dirty = false;
let applying = false;
// What is known to be saved. The watchers below also fire for the load itself, and saving what
// was just read would stamp it with a new time for nothing.
let savedTitle = '';
let savedContent = '';

function take(note: { title: string; content: string; label_ids: string[]; pinned: number }) {
  applying = true;
  title.value = note.title;
  content.value = note.content;
  labelIds.value = [...(note.label_ids || [])];
  pinned.value = !!note.pinned;
  savedTitle = note.title;
  savedContent = note.content;
  nextTick(() => {
    applying = false;
  });
}

onMounted(async() => {
  await loadStrata();
  try {
    // Read on its own, fresh: the list may be minutes old.
    const note = await api.getNote(props.noteId);

    take(note);
    notesStore.upsert(note);
    wasDeleted.value = !!note.deleted;
  } catch {
    const known = notesStore.getNoteById(props.noteId);

    if (known) {
      take(known);
    } else {
      isNew.value = true;
    }
  }
  highlightLineKey.value = (route.query.hl as string) || null;
  loaded.value = true;
});

function ensureCreated(): Promise<void> {
  if (!isNew.value || created) {
    return creating || Promise.resolve();
  }
  created = true;
  creating = notesStore.createNote({ id: props.noteId, title: title.value, content: content.value }).then(() => undefined);

  return creating;
}

async function save() {
  dirty = false;
  if (!title.value && !content.value && !created) {
    return;
  }
  if (title.value === savedTitle && content.value === savedContent) {
    return;
  }
  const t = title.value;
  const c = content.value;

  if (isNew.value && !created) {
    await ensureCreated();
  } else {
    await notesStore.updateNote(props.noteId, { title: t, content: c });
  }
  savedTitle = t;
  savedContent = c;
}

function scheduleAutoSave() {
  if (applying || !loaded.value) {
    return;
  }
  dirty = true;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 800);
}

watch(title, scheduleAutoSave);
watch(content, scheduleAutoSave);
watch(() => route.query.hl, (hl) => {
  highlightLineKey.value = (hl as string) || null;
});

onBeforeUnmount(() => {
  clearTimeout(saveTimer);
  if (dirty) {
    save();
  }
});

async function toggleNoteLabel(labelId: string) {
  await ensureCreated();
  if (labelIds.value.includes(labelId)) {
    labelIds.value = labelIds.value.filter((l) => l !== labelId);
    await notesStore.removeNoteLabel(props.noteId, labelId);
  } else {
    labelIds.value = [...labelIds.value, labelId];
    await notesStore.addNoteLabel(props.noteId, labelId);
  }
}

async function handleTogglePin() {
  await ensureCreated();
  await notesStore.togglePin(props.noteId);
  pinned.value = !!notesStore.getNoteById(props.noteId)?.pinned;
}

const listTo = { name: STRATA_ROUTE, params: { product: DEV_PRODUCT, cluster: BLANK_CLUSTER } };

async function handleDelete() {
  clearTimeout(saveTimer);
  dirty = false;
  if (isNew.value && !created) {
    // Nothing was ever saved, so there is nothing to delete or undo.
    router.push(listTo);

    return;
  }
  await creating;
  notesStore.lastDeletedNoteId = props.noteId;
  router.push(listTo);
  await notesStore.deleteNote(props.noteId);
}

async function restore() {
  const note = await notesStore.restoreNote(props.noteId);

  if (note) {
    wasDeleted.value = false;
  }
}
</script>

<template>
  <div
    v-if="loaded"
    class="strata-note"
    data-testid="strata-note"
  >
    <p
      v-if="wasDeleted"
      class="strata-note__notice"
    >
      This note is deleted.
      <button
        type="button"
        class="btn btn-sm role-secondary"
        data-testid="strata-restore"
        @click="restore"
      >
        Restore it
      </button>
    </p>
    <p
      v-if="strataProblem"
      class="strata-note__problem"
      role="alert"
    >
      {{ strataProblem }}
    </p>
    <NoteEditor
      v-model:content="content"
      v-model:title="title"
      :note-id="noteId"
      :note-label-ids="labelIds"
      :note-pinned="pinned"
      :highlight-line-key="highlightLineKey"
      :ensure-created="ensureCreated"
      @toggle-note-label="toggleNoteLabel"
      @toggle-pin="handleTogglePin"
      @delete="handleDelete"
      @clear-highlight="highlightLineKey = null"
    />
  </div>
  <p
    v-else
    class="text-muted"
  >
    Opening the note…
  </p>
</template>

<style lang="scss" scoped>
.strata-note {
  display:        flex;
  flex:           1;
  flex-direction: column;
  gap:            var(--dev-space-4);
  min-height:     0;

  &__notice, &__problem {
    display:     flex;
    flex-shrink: 0;
    align-items: center;
    gap:         var(--dev-space-4);
    margin:      0;
    padding:     var(--dev-space-3) var(--dev-space-4);
    border-radius: var(--r-sm);
    font-size:   13px;

    .btn { line-height: 1.4; }
  }

  &__notice { background: var(--warning-banner-bg, color-mix(in srgb, var(--warning) 14%, transparent)); }
  &__problem { background: var(--error-banner-bg); color: var(--error); }
}
</style>
