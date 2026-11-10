/**
 * Strata's three stores - notes, labels, labelled lines - as module singletons.
 *
 * Ported from Strata's Pinia stores with their local-first half taken out. There, IndexedDB was
 * the source of truth and a queue synced it to the server in the background; here there is no
 * offline copy and no second device to merge with, so every change is made in memory for the
 * page to show at once and sent to dev-api in order. `serial` is that order: a note's create
 * lands before its first label, and two quick saves of the same note arrive as typed.
 *
 * Each store is `reactive` around refs, which is what Pinia gave the pages: `notes.notes` is the
 * array, not a ref of it, so the templates read as they did.
 */
import { computed, reactive, ref } from 'vue';
import { api } from './api';
import type { Label, LineLabel, Note } from './api';

/** What went wrong with the last write, for the pages to say; '' when nothing has. */
export const strataProblem = ref('');

let chain: Promise<unknown> = Promise.resolve();

/** Run writes one after another, in the order they were asked for, and say when one fails. */
function serial<T>(work: () => Promise<T>): Promise<T> {
  const next = chain.then(work, work);

  chain = next.then(() => {
    strataProblem.value = '';
  }, (e: Error) => {
    strataProblem.value = e?.message || String(e);
  });

  return next;
}

/** Resolves once every write asked for so far has been answered. */
export function settled(): Promise<unknown> {
  return chain;
}

/** A time as the server writes one: UTC, `YYYY-MM-DD HH:MM:SS`, no zone. */
export function nowStamp(): string {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function once<T>(setup: () => T): () => T {
  let made: T | undefined;

  return () => {
    made ??= setup();

    return made;
  };
}

// ── Notes ────────────────────────────────────────────────────────────────────────────────────

function notesSetup() {
  const notes = ref<Note[]>([]);
  const loading = ref(false);
  const loaded = ref(false);
  const searchQuery = ref('');
  const searchLabels = ref('');
  const includeLabels = ref<Set<string>>(new Set());
  const excludeLabels = ref<Set<string>>(new Set());
  const filterUnlabeled = ref(false);
  const lastDeletedNoteId = ref<string | null>(null);
  const searchPending = ref(false);
  /** Every live note, whatever the list is filtered to: the pinned bar and the label tree read this. */
  const all = ref<Note[]>([]);

  const sortedNotes = computed(() => [...notes.value].sort((a, b) => {
    if (b.sort_order !== a.sort_order) {
      return b.sort_order - a.sort_order;
    }

    return b.created_at.localeCompare(a.created_at);
  }));

  const pinnedNotes = computed(() => all.value.filter((n) => n.pinned));

  function rebuildSearchLabels() {
    const parts: string[] = [];

    if (filterUnlabeled.value) {
      parts.push('*none');
    }
    for (const name of includeLabels.value) {
      parts.push(name);
    }
    for (const name of excludeLabels.value) {
      parts.push(`-${ name }`);
    }
    searchLabels.value = parts.join('+');
  }

  function addLabelFilter(name: string) {
    if (!includeLabels.value.has(name)) {
      includeLabels.value.add(name);
      searchQuery.value = '';
      rebuildSearchLabels();
      search();
    }
  }

  function toggleLabelFilter(name: string) {
    if (includeLabels.value.has(name)) {
      includeLabels.value.delete(name);
      excludeLabels.value.add(name);
    } else if (excludeLabels.value.has(name)) {
      excludeLabels.value.delete(name);
    } else {
      includeLabels.value.add(name);
    }
    searchQuery.value = '';
    rebuildSearchLabels();
    search();
  }

  function toggleUnlabeled() {
    filterUnlabeled.value = !filterUnlabeled.value;
    rebuildSearchLabels();
    search();
  }

  function clearFilters() {
    searchQuery.value = '';
    searchLabels.value = '';
    includeLabels.value.clear();
    excludeLabels.value.clear();
    filterUnlabeled.value = false;
    fetchNotes();
  }

  function getLabelFilterState(name: string): 'include' | 'exclude' | 'none' {
    if (includeLabels.value.has(name)) {
      return 'include';
    }
    if (excludeLabels.value.has(name)) {
      return 'exclude';
    }

    return 'none';
  }

  const filtering = () => !!(searchQuery.value.trim() || searchLabels.value);

  async function fetchNotes() {
    loading.value = true;
    try {
      // After any write still on its way, so a list read now does not undo an edit just made.
      await settled();
      const fresh = await api.getNotes();

      all.value = fresh;
      if (!filtering()) {
        notes.value = fresh;
      }
      loaded.value = true;
      strataProblem.value = '';
    } catch (e: any) { // eslint-disable-line @typescript-eslint/no-explicit-any
      strataProblem.value = e?.message || String(e);
    } finally {
      loading.value = false;
      searchPending.value = false;
    }
  }

  /** The same note in both lists: the one shown and the one everything else reads. */
  function eachCopy(id: string, change: (note: Note) => void) {
    for (const list of [notes.value, all.value]) {
      const note = list.find((n) => n.id === id);

      if (note) {
        change(note);
      }
    }
  }

  async function createNote(data: Partial<Note> = {}) {
    const now = nowStamp();
    const note: Note = {
      id:         data.id || crypto.randomUUID(),
      title:      data.title || '',
      content:    data.content || '',
      created_at: now,
      updated_at: now,
      deleted:    0,
      sort_order: data.sort_order || 0,
      pinned:     0,
      pin_order:  0,
      label_ids:  [],
    };

    notes.value.unshift(note);
    all.value.unshift({ ...note });
    await serial(() => api.createNote(note));

    return note;
  }

  async function updateNote(id: string, data: Partial<Note>) {
    const now = nowStamp();

    eachCopy(id, (note) => Object.assign(note, data, { updated_at: now }));
    await serial(() => api.updateNote(id, data));

    return getNoteById(id);
  }

  async function deleteNote(id: string) {
    notes.value = notes.value.filter((n) => n.id !== id);
    all.value = all.value.filter((n) => n.id !== id);
    await serial(() => api.deleteNote(id));
  }

  async function restoreNote(id: string) {
    if (getNoteById(id)) {
      return getNoteById(id);
    }
    const restored = await serial(() => api.restoreNote(id));

    if (restored && !getNoteById(id)) {
      notes.value.unshift(restored);
      all.value.unshift({ ...restored, label_ids: [...restored.label_ids] });
    }

    return restored;
  }

  async function togglePin(id: string) {
    const note = getNoteById(id);

    if (!note) {
      return;
    }
    const pinned = note.pinned ? 0 : 1;

    eachCopy(id, (n) => {
      n.pinned = pinned;
    });
    await serial(() => api.updateNote(id, { pinned }));
  }

  /** Change a note's labels in memory, in both lists. */
  function setNoteLabels(id: string, labelIds: string[]) {
    eachCopy(id, (n) => {
      n.label_ids = [...labelIds];
    });
  }

  async function addNoteLabel(id: string, labelId: string) {
    const note = getNoteById(id);

    if (note && !note.label_ids.includes(labelId)) {
      setNoteLabels(id, [...note.label_ids, labelId]);
    }
    await serial(() => api.addNoteLabel(id, labelId));
  }

  async function removeNoteLabel(id: string, labelId: string) {
    const note = getNoteById(id);

    if (note) {
      setNoteLabels(id, note.label_ids.filter((l) => l !== labelId));
    }
    await serial(() => api.removeNoteLabel(id, labelId));
  }

  async function setPinOrder(id: string, order: number) {
    eachCopy(id, (n) => {
      n.pin_order = order;
    });
    await serial(() => api.updateNote(id, { pin_order: order }));
  }

  async function search() {
    if (!filtering()) {
      return fetchNotes();
    }
    loading.value = true;
    try {
      notes.value = await api.search(searchQuery.value.trim() || undefined, searchLabels.value || undefined);
    } catch (e: any) { // eslint-disable-line @typescript-eslint/no-explicit-any
      strataProblem.value = e?.message || String(e);
    } finally {
      loading.value = false;
      searchPending.value = false;
    }
  }

  /** Put a note read on its own into both lists, replacing what was there. */
  function upsert(fresh: Note) {
    for (const list of [notes.value, all.value]) {
      const at = list.findIndex((n) => n.id === fresh.id);

      if (at >= 0) {
        list.splice(at, 1, { ...fresh, label_ids: [...fresh.label_ids] });
      } else if (list === all.value && !fresh.deleted) {
        list.unshift({ ...fresh, label_ids: [...fresh.label_ids] });
      }
    }
  }

  function getNoteById(id: string): Note | undefined {
    return all.value.find((n) => n.id === id) || notes.value.find((n) => n.id === id);
  }

  return {
    notes,
    all,
    loading,
    loaded,
    searchQuery,
    searchLabels,
    includeLabels,
    excludeLabels,
    filterUnlabeled,
    sortedNotes,
    pinnedNotes,
    lastDeletedNoteId,
    searchPending,
    fetchNotes,
    createNote,
    updateNote,
    deleteNote,
    restoreNote,
    search,
    getNoteById,
    addLabelFilter,
    toggleLabelFilter,
    toggleUnlabeled,
    clearFilters,
    getLabelFilterState,
    rebuildSearchLabels,
    togglePin,
    addNoteLabel,
    removeNoteLabel,
    setNoteLabels,
    setPinOrder,
    upsert,
  };
}

export const useNotesStore = once(() => reactive(notesSetup()));

// ── Labels ───────────────────────────────────────────────────────────────────────────────────

function labelsSetup() {
  const labels = ref<Label[]>([]);
  const loading = ref(false);
  const loaded = ref(false);

  const pinnedLabels = computed(() => labels.value.filter((l) => l.pinned));

  function getChildren(parentId: string): Label[] {
    return labels.value.filter((l) => l.parent_id === parentId);
  }

  function getLabelById(id: string): Label | undefined {
    return labels.value.find((l) => l.id === id);
  }

  async function fetchLabels() {
    loading.value = true;
    try {
      labels.value = await api.getLabels();
      loaded.value = true;
    } catch (e: any) { // eslint-disable-line @typescript-eslint/no-explicit-any
      strataProblem.value = e?.message || String(e);
    } finally {
      loading.value = false;
    }
  }

  async function createLabel(data: Partial<Label>) {
    const label: Label = {
      id:         data.id || crypto.randomUUID(),
      name:       data.name || '',
      color:      data.color || '#f472b6',
      parent_id:  data.parent_id || null,
      pinned:     0,
      pin_order:  0,
      created_at: nowStamp(),
    };

    labels.value.push(label);
    await serial(() => api.createLabel(label));

    return label;
  }

  async function updateLabel(id: string, data: Partial<Label>) {
    const label = getLabelById(id);

    if (label) {
      Object.assign(label, data);
    }
    await serial(() => api.updateLabel(id, data));

    return getLabelById(id);
  }

  async function deleteLabel(id: string) {
    labels.value = labels.value.filter((l) => l.id !== id);
    for (const child of labels.value.filter((l) => l.parent_id === id)) {
      child.parent_id = null;
    }
    const notes = useNotesStore();

    for (const list of [notes.notes, notes.all]) {
      for (const note of list) {
        if (note.label_ids.includes(id)) {
          note.label_ids = note.label_ids.filter((l) => l !== id);
        }
      }
    }
    const lines = useLineLabelsStore();

    lines.lineLabels = lines.lineLabels.filter((ll) => ll.label_id !== id);
    await serial(() => api.deleteLabel(id));
  }

  async function togglePin(id: string) {
    const label = getLabelById(id);

    if (!label) {
      return;
    }
    label.pinned = label.pinned ? 0 : 1;
    const pinned = label.pinned;

    await serial(() => api.updateLabel(id, { pinned }));
  }

  async function setPinOrder(id: string, order: number) {
    const label = getLabelById(id);

    if (label) {
      label.pin_order = order;
    }
    await serial(() => api.updateLabel(id, { pin_order: order }));
  }

  return {
    labels,
    loading,
    loaded,
    pinnedLabels,
    getChildren,
    getLabelById,
    fetchLabels,
    createLabel,
    updateLabel,
    deleteLabel,
    togglePin,
    setPinOrder,
  };
}

export const useLabelsStore = once(() => reactive(labelsSetup()));

// ── Line labels ──────────────────────────────────────────────────────────────────────────────

function lineLabelsSetup() {
  const lineLabels = ref<LineLabel[]>([]);

  function forNote(noteId: string): LineLabel[] {
    return lineLabels.value.filter((ll) => ll.note_id === noteId);
  }

  function forLabel(labelId: string): LineLabel[] {
    return lineLabels.value.filter((ll) => ll.label_id === labelId);
  }

  /** Replace the records `scope` picks out with `fresh`, keeping what was known about survivors (note_title). */
  function replaceScope(scope: (ll: LineLabel) => boolean, fresh: LineLabel[]) {
    const existing = new Map(lineLabels.value.map((ll) => [ll.id, ll]));

    lineLabels.value = [
      ...lineLabels.value.filter((ll) => !scope(ll)),
      ...fresh.map((ll) => ({ ...existing.get(ll.id), ...ll })),
    ];
  }

  async function fetchForNote(noteId: string) {
    try {
      replaceScope((ll) => ll.note_id === noteId, await api.getLineLabels(noteId));
    } catch (e: any) { // eslint-disable-line @typescript-eslint/no-explicit-any
      strataProblem.value = e?.message || String(e);
    }
  }

  async function fetchForLabel(labelId: string) {
    try {
      replaceScope((ll) => ll.label_id === labelId, await api.getLineLabelsByLabel(labelId));
    } catch (e: any) { // eslint-disable-line @typescript-eslint/no-explicit-any
      strataProblem.value = e?.message || String(e);
    }
  }

  async function add(noteId: string, lineKey: string, labelId: string, lineText = '', lineNumber = 0) {
    const record: LineLabel = {
      id:          crypto.randomUUID(),
      note_id:     noteId,
      line_key:    lineKey,
      label_id:    labelId,
      line_text:   lineText,
      line_number: lineNumber,
    };

    lineLabels.value.push(record);
    // The server picks its own id; the record takes it so a later remove names the right one.
    const saved = await serial(() => api.addLineLabel(noteId, lineKey, labelId, lineText, lineNumber));
    // Onto the record itself even when it has left the list: a remove made meanwhile holds it.
    const local = lineLabels.value.find((ll) => ll.id === record.id) || record;

    if (saved) {
      Object.assign(local, saved);
    }

    return record;
  }

  async function remove(id: string) {
    const record = lineLabels.value.find((ll) => ll.id === id);

    lineLabels.value = lineLabels.value.filter((ll) => ll.id !== id);
    // Read the id when the call is made: an add still in flight may be about to rename it.
    await serial(() => api.removeLineLabel(record?.id || id));
  }

  return {
    lineLabels,
    forNote,
    forLabel,
    fetchForNote,
    fetchForLabel,
    add,
    remove,
  };
}

export const useLineLabelsStore = once(() => reactive(lineLabelsSetup()));

/** Notes and labels read, once per visit unless `fresh`: what every Strata page starts from. */
export async function loadStrata(fresh = false): Promise<void> {
  const notes = useNotesStore();
  const labels = useLabelsStore();

  await Promise.all([
    fresh || !notes.loaded ? notes.fetchNotes() : null,
    fresh || !labels.loaded ? labels.fetchLabels() : null,
  ]);
}
