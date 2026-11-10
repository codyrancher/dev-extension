<script setup lang="ts">
/**
 * The labels on something, and a way to add one: a note's labels, a line's, a label's parent.
 *
 * The chips are what is chosen; + opens a box that filters every label as you type, and Enter
 * either picks the one that matches or makes a new one in a colour no label has yet.
 */
import { computed, nextTick, ref } from 'vue';
import { useLabelsStore } from '../../strata/stores';
import { randomLabelColor } from '../../strata/colors';
import LabelChip from './LabelChip.vue';
import ColorDot from './ColorDot.vue';

const props = defineProps<{
  selectedIds: string[];
  placeholder?: string;
  /** Where the menu opens; `inline` puts it in the flow, for a sheet that grows to hold it. */
  direction?: 'up' | 'down' | 'inline';
  /** Open with the box showing, for a picker that is nothing else (the line popover). */
  autofocus?: boolean;
}>();

const emit = defineEmits<{ (e: 'toggle', labelId: string): void }>();

const labelsStore = useLabelsStore();
const query = ref('');
const focused = ref(false);
const showInput = ref(!!props.autofocus);
const inputEl = ref<HTMLInputElement | null>(null);
const active = ref(-1);

if (props.autofocus) {
  nextTick(() => inputEl.value?.focus());
}

function openInput() {
  showInput.value = true;
  nextTick(() => inputEl.value?.focus());
}

const filteredLabels = computed(() => {
  const q = query.value.toLowerCase().trim();

  return q ? labelsStore.labels.filter((l) => l.name.toLowerCase().includes(q)) : labelsStore.labels;
});

const exactMatch = computed(() => {
  const q = query.value.toLowerCase().trim();

  return !q || labelsStore.labels.some((l) => l.name.toLowerCase() === q);
});

async function handleEnter() {
  if (active.value >= 0 && filteredLabels.value[active.value]) {
    selectLabel(filteredLabels.value[active.value].id);

    return;
  }
  const q = query.value.trim();

  if (!q) {
    return;
  }
  const existing = labelsStore.labels.find((l) => l.name.toLowerCase() === q.toLowerCase());

  if (existing) {
    emit('toggle', existing.id);
    query.value = '';

    return;
  }
  const label = await labelsStore.createLabel({ name: q, color: randomLabelColor(labelsStore.labels.map((l) => l.color)) });

  emit('toggle', label.id);
  query.value = '';
}

function selectLabel(id: string) {
  emit('toggle', id);
  query.value = '';
  active.value = -1;
}

function move(step: number) {
  const n = filteredLabels.value.length;

  if (n) {
    active.value = (active.value + step + n) % n;
  }
}

function handleBlur() {
  setTimeout(() => {
    focused.value = false;
    if (!props.autofocus) {
      showInput.value = false;
    }
    query.value = '';
    active.value = -1;
  }, 150);
}
</script>

<template>
  <div
    class="strata-labels"
    :class="{ 'strata-labels--inline': direction === 'inline' }"
    data-testid="strata-label-search"
  >
    <LabelChip
      v-for="id in selectedIds"
      :key="id"
      :name="labelsStore.getLabelById(id)?.name || ''"
      :color="labelsStore.getLabelById(id)?.color"
      removable
      @remove="emit('toggle', id)"
    />
    <button
      v-if="!showInput"
      type="button"
      class="strata-labels__add"
      :aria-label="placeholder || 'Add label'"
      :title="placeholder || 'Add label'"
      data-testid="strata-label-add"
      @click="openInput"
    >
      +
    </button>
    <div
      v-else
      class="strata-labels__box"
    >
      <input
        ref="inputEl"
        v-model="query"
        type="text"
        :placeholder="placeholder || 'Add label...'"
        class="strata-labels__input"
        data-testid="strata-label-input"
        @focus="focused = true"
        @blur="handleBlur"
        @input="active = -1"
        @keydown.enter.prevent="handleEnter"
        @keydown.down.prevent="move(1)"
        @keydown.up.prevent="move(-1)"
        @keydown.escape="showInput = !!autofocus; ($event.target as HTMLInputElement).blur()"
      >
      <div
        v-if="focused && (filteredLabels.length > 0 || !exactMatch)"
        class="strata-labels__menu"
        :class="{ 'strata-labels__menu--up': direction === 'up', 'strata-labels__menu--inline': direction === 'inline' }"
        role="listbox"
        data-testid="strata-label-menu"
      >
        <div
          v-if="!exactMatch && query.trim()"
          class="strata-labels__item strata-labels__item--create"
          role="option"
          data-testid="strata-label-create"
          @mousedown.prevent="handleEnter"
        >
          Create "<strong>{{ query.trim() }}</strong>"
        </div>
        <div
          v-for="(label, i) in filteredLabels"
          :key="label.id"
          class="strata-labels__item"
          :class="{ 'strata-labels__item--active': i === active }"
          role="option"
          :aria-selected="selectedIds.includes(label.id)"
          data-testid="strata-label-option"
          @mousedown.prevent="selectLabel(label.id)"
        >
          <ColorDot :color="label.color" />
          <span class="strata-labels__name">{{ label.name }}</span>
          <i
            v-if="selectedIds.includes(label.id)"
            class="icon icon-checkmark strata-labels__check"
          />
        </div>
      </div>
    </div>
  </div>
</template>

<style lang="scss" scoped>
.strata-labels {
  display:     flex;
  flex-wrap:   wrap;
  align-items: center;
  gap:         var(--dev-space-3);
  min-height:  28px;

  &__add {
    display:         inline-flex;
    align-items:     center;
    justify-content: center;
    width:           28px;
    height:          28px;
    min-height:      0;
    padding:         0;
    border:          1px dashed var(--border);
    border-radius:   var(--r-sm);
    background:      none;
    color:           var(--muted);
    font-size:       16px;
    font-weight:     600;
    line-height:     1;
    cursor:          pointer;

    &:hover {
      border-color: var(--dev-accent);
      color:        var(--dev-accent);
    }
  }

  &__box {
    position:  relative;
    flex:      1;
    min-width: 140px;
    max-width: 320px;
  }

  /* In a sheet the menu is in the box's flow: the chips get a row of their own above it. */
  &--inline &__box {
    flex-basis: 100%;
    max-width:  none;
  }

  &__input {
    width:     100%;
    height:    28px;
    padding:   0 var(--dev-space-4);
    font-size: 13px;
  }

  &__menu {
    position:      absolute;
    top:           100%;
    left:          0;
    right:         0;
    z-index:       30;
    max-height:    220px;
    margin-top:    var(--dev-space-2);
    overflow-y:    auto;
    border:        1px solid var(--dropdown-border);
    border-radius: var(--r-sm);
    background:    var(--dropdown-bg);
    box-shadow:    0 6px 18px rgba(0, 0, 0, 0.18);

    &--up {
      top:           auto;
      bottom:        100%;
      margin-top:    0;
      margin-bottom: var(--dev-space-2);
    }

    &--inline {
      position:   static;
      box-shadow: none;
    }
  }

  &__item {
    display:     flex;
    align-items: center;
    gap:         var(--dev-space-4);
    padding:     8px 12px;
    color:       var(--dropdown-text);
    font-size:   13px;
    cursor:      pointer;

    &:hover, &--active { background: var(--dropdown-hover-bg); }

    &--create { color: var(--dev-accent); }
  }

  &__name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  &__check { color: var(--dev-accent); }
}
</style>
