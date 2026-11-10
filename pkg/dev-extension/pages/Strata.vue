<script setup lang="ts">
/**
 * Strata: notes, the labels on them, and the lines labelled within them.
 *
 * The notes list - Strata's NotesView - in this product's page frame: pinned notes and labels at
 * the top, search and its label filters, then the notes as cards. Strata's sync, offline store,
 * sign-in and app install are not here; dev-api keeps the notes (strata-store.mjs).
 */
import { computed, onMounted } from 'vue';
import { useHostRouter } from '../strata/router';
import { RcButton } from '@components/RcButton';
import DevPage from '../components/DevPage.vue';
import PinnedBar from '../components/strata/PinnedBar.vue';
import SearchBar from '../components/strata/SearchBar.vue';
import NoteCard from '../components/strata/NoteCard.vue';
import UndoToast from '../components/strata/UndoToast.vue';
import StrataBackup from '../components/strata/StrataBackup.vue';
import {
  useNotesStore, useLabelsStore, loadStrata, strataProblem
} from '../strata/stores';
import { STRATA_STORE } from '../strata/api';
import '../strata/style';
import {
  DEV_PRODUCT, BLANK_CLUSTER, STRATA_NOTE_ROUTE
} from '../config/constants';

const router = useHostRouter();
const notesStore = useNotesStore();
const labelsStore = useLabelsStore();

const filtering = computed(() => !!(notesStore.searchQuery.trim() || notesStore.searchLabels));
const empty = computed(() => notesStore.sortedNotes.length === 0);

onMounted(async() => {
  await loadStrata(true);
  // Back from a note with a search still up: run it again, so an edit there shows here.
  if (filtering.value) {
    notesStore.search();
  }
});

function openNote(id: string) {
  router.push({ name: STRATA_NOTE_ROUTE, params: { product: DEV_PRODUCT, cluster: BLANK_CLUSTER, id } });
}

function newNote() {
  openNote(crypto.randomUUID());
}

function handleLabelClick(labelId: string) {
  const label = labelsStore.getLabelById(labelId);

  if (label) {
    notesStore.addLabelFilter(label.name);
  }
}
</script>

<template>
  <DevPage
    :title="STRATA_STORE ? `Strata (${ STRATA_STORE } store)` : 'Strata'"
    lede="Notes, the labels on them, and the lines you label inside them."
    class="strata-page"
  >
    <template #actions>
      <RcButton
        variant="primary"
        size="small"
        data-testid="strata-new"
        @click="newNote"
      >
        New note
      </RcButton>
    </template>

    <div class="strata-page__body">
      <p
        v-if="strataProblem"
        class="strata-page__problem"
        role="alert"
      >
        {{ strataProblem }}
      </p>
      <PinnedBar />
      <SearchBar />
      <p
        v-if="empty && (notesStore.loading || notesStore.searchPending)"
        class="text-muted strata-page__empty"
      >
        Loading…
      </p>
      <div
        v-else-if="empty && !notesStore.loaded"
        class="strata-page__empty"
        data-testid="strata-unreadable"
      >
        <p>The notes could not be read.</p>
        <button
          type="button"
          class="btn role-secondary btn-sm"
          @click="loadStrata(true)"
        >
          Try again
        </button>
      </div>
      <div
        v-else-if="empty"
        class="strata-page__empty"
        data-testid="strata-empty"
      >
        <template v-if="filtering">
          <p>Nothing matches.</p>
        </template>
        <template v-else>
          <p>No notes yet.</p>
          <p class="text-muted">
            New note makes one.
          </p>
        </template>
      </div>
      <div
        v-else
        class="strata-page__grid"
        :class="{ 'strata-page__grid--stale': notesStore.searchPending }"
        data-testid="strata-notes"
      >
        <NoteCard
          v-for="note in notesStore.sortedNotes"
          :key="note.id"
          :note="note"
          @open="openNote(note.id)"
          @label-click="handleLabelClick"
        />
      </div>
      <StrataBackup v-if="!STRATA_STORE" />
    </div>
    <UndoToast />
  </DevPage>
</template>

<style lang="scss" scoped>
.strata-page {
  height:     100%;
  min-height: 0;

  &__body {
    display:        flex;
    flex-direction: column;
    gap:            var(--dev-space-5);
    margin-top:     var(--dev-space-5);
  }

  .btn { line-height: 1.4; }

  &__problem {
    margin:        0;
    padding:       var(--dev-space-3) var(--dev-space-4);
    border-radius: var(--r-sm);
    background:    var(--error-banner-bg);
    color:         var(--error);
    font-size:     13px;
  }

  &__empty {
    padding:    60px var(--dev-space-5);
    text-align: center;

    p { margin: 0 0 var(--dev-space-2); }
  }

  &__grid {
    display:               grid;
    grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
    align-items:           start;
    gap:                   var(--dev-space-4);
    transition:            opacity 0.15s ease;

    &--stale { opacity: 0.6; }
  }
}

@media (max-width: 760px) {
  .strata-page__grid { grid-template-columns: minmax(0, 1fr); }
}
</style>
