<script setup lang="ts">
/**
 * Search, and the label filters it grows.
 *
 * Typing searches after 300 ms. Labels whose names match appear as chips under the box: the chip
 * opens the label, its dot cycles that label through include, exclude and off. "Unlabeled" is
 * offered when the query looks like it, and "labels" lists every label. What is filtering the
 * list is shown on a line of its own, each removable.
 *
 * And what was searched for can be made, which Strata could not do: a query that is not already a
 * note's title offers a new note with it as the title, and one that is not already a label's name
 * offers a new label by that name. Searching for a thing and finding it missing is exactly when
 * one wants to write it down.
 */
import { computed, ref, watch } from 'vue';
import { useHostRouter } from '../../strata/router';
import { useLabelsStore, useNotesStore } from '../../strata/stores';
import { randomLabelColor } from '../../strata/colors';
import LabelChip from './LabelChip.vue';
import {
  DEV_PRODUCT, BLANK_CLUSTER, STRATA_LABEL_ROUTE, STRATA_NOTE_ROUTE
} from '../../config/constants';

const router = useHostRouter();
const notesStore = useNotesStore();
const labelsStore = useLabelsStore();

let debounceTimer: ReturnType<typeof setTimeout>;

watch(() => notesStore.searchQuery, () => {
  clearTimeout(debounceTimer);
  notesStore.searchPending = true;
  debounceTimer = setTimeout(() => notesStore.search(), 300);
});

const matchingLabels = computed(() => {
  const q = notesStore.searchQuery.toLowerCase().trim();

  if (!q) {
    return [];
  }
  if (q === 'labels') {
    return labelsStore.labels;
  }

  return labelsStore.labels.filter((l) => l.name.toLowerCase().includes(q));
});

const showUnlabeledOption = computed(() => {
  const q = notesStore.searchQuery.toLowerCase().trim();

  return !!q && ('unlabeled'.includes(q) || 'no label'.includes(q) || q === 'labels');
});

const hasActiveFilters = computed(() => notesStore.includeLabels.size > 0 || notesStore.excludeLabels.size > 0 || notesStore.filterUnlabeled);

function state(name: string) {
  return notesStore.getLabelFilterState(name);
}

function openLabel(id: string) {
  router.push({ name: STRATA_LABEL_ROUTE, params: { product: DEV_PRODUCT, cluster: BLANK_CLUSTER, id } });
}

/** The query as a name: what was typed, trimmed, or '' for the words the box already means something by. */
const asName = computed(() => {
  const q = notesStore.searchQuery.trim();

  return ['labels', 'unlabeled', 'no label'].includes(q.toLowerCase()) ? '' : q;
});

const canMakeNote = computed(() => !!asName.value && !notesStore.all.some((n) => n.title.trim().toLowerCase() === asName.value.toLowerCase()));
const canMakeLabel = computed(() => !!asName.value && !labelsStore.labels.some((l) => l.name.toLowerCase() === asName.value.toLowerCase()));
const making = ref(false);

async function makeNote() {
  if (making.value) {
    return;
  }
  making.value = true;
  try {
    const note = await notesStore.createNote({ title: asName.value });

    router.push({ name: STRATA_NOTE_ROUTE, params: { product: DEV_PRODUCT, cluster: BLANK_CLUSTER, id: note.id } });
  } finally {
    making.value = false;
  }
}

async function makeLabel() {
  if (making.value) {
    return;
  }
  making.value = true;
  try {
    const label = await labelsStore.createLabel({ name: asName.value, color: randomLabelColor(labelsStore.labels.map((l) => l.color)) });

    openLabel(label.id);
  } finally {
    making.value = false;
  }
}
</script>

<template>
  <div class="strata-search">
    <div class="strata-search__box">
      <i class="icon icon-search strata-search__icon" />
      <input
        v-model="notesStore.searchQuery"
        type="search"
        placeholder="Search notes and labels..."
        aria-label="Search notes and labels"
        class="strata-search__input"
        data-testid="strata-search"
      >
      <button
        v-if="notesStore.searchQuery || notesStore.searchLabels"
        type="button"
        class="strata-search__clear"
        title="Clear search"
        aria-label="Clear search"
        data-testid="strata-search-clear"
        @click="notesStore.clearFilters()"
      >
        <i class="icon icon-close" />
      </button>
    </div>

    <div
      v-if="matchingLabels.length > 0 || showUnlabeledOption"
      class="strata-search__row"
      data-testid="strata-search-labels"
    >
      <LabelChip
        v-if="showUnlabeledOption"
        name="Unlabeled"
        :variant="notesStore.filterUnlabeled ? 'include' : 'unlabeled'"
        data-testid="strata-unlabeled"
        @click="notesStore.toggleUnlabeled()"
      />
      <LabelChip
        v-for="label in matchingLabels"
        :key="label.id"
        :name="label.name"
        :color="label.color"
        :variant="state(label.name) === 'none' ? 'default' : state(label.name)"
        @click="openLabel(label.id)"
      >
        <template #after>
          <span
            class="strata-search__toggle"
            :class="`strata-search__toggle--${ state(label.name) }`"
            role="button"
            :title="state(label.name) === 'include' ? 'Exclude it' : state(label.name) === 'exclude' ? 'Stop filtering on it' : 'Only notes with it'"
            data-testid="strata-filter-toggle"
            @click.stop="notesStore.toggleLabelFilter(label.name)"
          >
            <template v-if="state(label.name) === 'include'">&#10003;</template>
            <template v-else-if="state(label.name) === 'exclude'">&minus;</template>
            <template v-else>&#9679;</template>
          </span>
        </template>
      </LabelChip>
    </div>

    <div
      v-if="canMakeNote || canMakeLabel"
      class="strata-search__row"
      data-testid="strata-search-make"
    >
      <button
        v-if="canMakeNote"
        type="button"
        class="btn btn-sm role-secondary strata-search__make"
        :disabled="making"
        data-testid="strata-make-note"
        @click="makeNote"
      >
        <i class="icon icon-plus" /> New note “{{ asName }}”
      </button>
      <button
        v-if="canMakeLabel"
        type="button"
        class="btn btn-sm role-secondary strata-search__make"
        :disabled="making"
        data-testid="strata-make-label"
        @click="makeLabel"
      >
        <i class="icon icon-plus" /> New label “{{ asName }}”
      </button>
    </div>

    <div
      v-if="hasActiveFilters"
      class="strata-search__row"
      data-testid="strata-active-filters"
    >
      <span class="strata-search__caption">Filtering:</span>
      <LabelChip
        v-if="notesStore.filterUnlabeled"
        name="Unlabeled"
        variant="unlabeled"
        removable
        @remove="notesStore.toggleUnlabeled()"
      />
      <LabelChip
        v-for="name in [...notesStore.includeLabels]"
        :key="'inc-' + name"
        :name="name"
        variant="include"
        removable
        @remove="notesStore.toggleLabelFilter(name)"
      />
      <LabelChip
        v-for="name in [...notesStore.excludeLabels]"
        :key="'exc-' + name"
        :name="name"
        variant="exclude"
        removable
        @remove="notesStore.toggleLabelFilter(name)"
      />
    </div>
  </div>
</template>

<style lang="scss" scoped>
.strata-search {
  display:        flex;
  flex-direction: column;
  gap:            var(--dev-space-4);

  &__box {
    position:    relative;
    display:     flex;
    align-items: center;
  }

  &__icon {
    position:       absolute;
    left:           12px;
    color:          var(--muted);
    pointer-events: none;
  }

  &__input {
    width:        100%;
    height:       40px;
    padding-left: 36px;
    padding-right: 36px;

    &::-webkit-search-cancel-button { display: none; }
  }

  &__clear {
    position:    absolute;
    right:       6px;
    min-height:  0;
    padding:     6px;
    border:      0;
    background:  none;
    color:       var(--muted);
    line-height: 1;
    cursor:      pointer;

    &:hover { color: var(--body-text); }
  }

  &__row {
    display:     flex;
    flex-wrap:   wrap;
    align-items: center;
    gap:         var(--dev-space-3);
  }

  &__caption { color: var(--muted); font-size: 12px; }

  &__make {
    display:     inline-flex;
    align-items: center;
    gap:         var(--dev-space-2);
    max-width:   100%;
    overflow:    hidden;
    line-height: 1.4;
    white-space: nowrap;
    text-overflow: ellipsis;
  }

  &__toggle {
    display:         inline-flex;
    align-items:     center;
    justify-content: center;
    width:           18px;
    height:          18px;
    margin-right:    -4px;
    border-radius:   var(--dev-space-2);
    font-size:       10px;
    opacity:         0.55;
    cursor:          pointer;

    &:hover { opacity: 1; background: color-mix(in srgb, var(--body-text) 12%, transparent); }
    &--include, &--exclude { opacity: 1; }
  }
}
</style>
