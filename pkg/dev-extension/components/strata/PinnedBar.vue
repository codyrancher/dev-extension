<script setup lang="ts">
import { ref, computed, onBeforeUnmount } from 'vue';
import { useHostRouter } from '../../strata/router';
import { useNotesStore, useLabelsStore } from '../../strata/stores';
import LabelChip from './LabelChip.vue';
import { LONG_PRESS_MS } from '../../strata/colors';
import {
  DEV_PRODUCT, BLANK_CLUSTER, STRATA_NOTE_ROUTE, STRATA_LABEL_ROUTE
} from '../../config/constants';

// The pinned notes and labels, in their pinned order. A click opens one; holding one picks it up
// to drag to a new place, and the new order is kept. Kept from Strata as it was.

interface PinnedItem {
  type: 'note' | 'label';
  id: string;
  pin_order: number;
}

const router = useHostRouter();
const notesStore = useNotesStore();
const labelsStore = useLabelsStore();

const held = ref(false);
const dragFrom = ref(-1);
const dropTo = ref(-1);
const pointerX = ref(0);
const pointerY = ref(0);
const grabOffsetX = ref(0);
const grabOffsetY = ref(0);
let holdTimer: ReturnType<typeof setTimeout> | null = null;
let didDrag = false;
let itemRects: DOMRect[] = [];
const itemsEl = ref<HTMLElement | null>(null);

const items = computed<PinnedItem[]>(() => {
  const all: PinnedItem[] = [];
  for (const n of notesStore.pinnedNotes) {
    all.push({ type: 'note', id: n.id, pin_order: n.pin_order || 0 });
  }
  for (const l of labelsStore.pinnedLabels) {
    all.push({ type: 'label', id: l.id, pin_order: l.pin_order || 0 });
  }
  all.sort((a, b) => a.pin_order - b.pin_order);
  return all;
});

function getTitle(item: PinnedItem): string {
  if (item.type === 'note') return notesStore.getNoteById(item.id)?.title || 'Untitled';
  return labelsStore.getLabelById(item.id)?.name || '';
}

function getColor(item: PinnedItem): string | undefined {
  if (item.type === 'label') return labelsStore.getLabelById(item.id)?.color;
  return undefined;
}

const previewOrder = computed<PinnedItem[]>(() => {
  if (!held.value || dragFrom.value < 0 || dropTo.value < 0 || dragFrom.value === dropTo.value) {
    return items.value;
  }
  const arr = [...items.value];
  const [moved] = arr.splice(dragFrom.value, 1);
  arr.splice(dropTo.value, 0, moved);
  return arr;
});

const draggedItem = computed(() =>
  dragFrom.value >= 0 ? items.value[dragFrom.value] : null
);

function handleClick(item: PinnedItem) {
  if (didDrag) { didDrag = false; return; }
  router.push({
    name:   item.type === 'note' ? STRATA_NOTE_ROUTE : STRATA_LABEL_ROUTE,
    params: { product: DEV_PRODUCT, cluster: BLANK_CLUSTER, id: item.id },
  });
}

function snapshotRects() {
  const container = itemsEl.value;
  if (!container) return;
  const els = Array.from(container.children) as HTMLElement[];
  itemRects = els.map(el => el.getBoundingClientRect());
}

function calcDropSlot(x: number): number {
  if (itemRects.length === 0) return 0;
  for (let i = 0; i < itemRects.length; i++) {
    const center = itemRects[i].left + itemRects[i].width / 2;
    if (x < center) return i;
  }
  return itemRects.length - 1;
}

function onPointerDown(e: PointerEvent, idx: number) {
  didDrag = false;
  pointerX.value = e.clientX;
  pointerY.value = e.clientY;
  const target = e.currentTarget as HTMLElement;
  const rect = target.getBoundingClientRect();
  grabOffsetX.value = e.clientX - rect.left - rect.width / 2;
  grabOffsetY.value = e.clientY - rect.top - rect.height / 2;

  clearHold();
  // A press let go of before it counts as a hold is a click: the timer must not outlive it, or
  // it fires later, picks the item up with nobody holding it, and the next click anywhere -
  // on the page the click opened - drops it at the front.
  window.addEventListener('pointerup', clearHold, { once: true });
  window.addEventListener('pointercancel', clearHold, { once: true });
  holdTimer = setTimeout(() => {
    holdTimer = null;
    if (!itemsEl.value) {
      return;
    }
    snapshotRects();
    held.value = true;
    dragFrom.value = idx;
    dropTo.value = idx;
    didDrag = true;
    window.addEventListener('pointermove', onWindowMove);
    window.addEventListener('pointerup', onWindowUp);
    window.addEventListener('pointercancel', onWindowCancel);
  }, LONG_PRESS_MS);
}

function clearHold() {
  if (holdTimer) {
    clearTimeout(holdTimer);
    holdTimer = null;
  }
}

/** A drag the browser took away (a scroll, a system gesture) ends where it started. */
function onWindowCancel() {
  dragFrom.value = -1;
  onWindowUp();
}

onBeforeUnmount(() => {
  clearHold();
  window.removeEventListener('pointerup', clearHold);
  window.removeEventListener('pointercancel', clearHold);
  window.removeEventListener('pointermove', onWindowMove);
  window.removeEventListener('pointerup', onWindowUp);
  window.removeEventListener('pointercancel', onWindowCancel);
  held.value = false;
});

function onPointerLeave() {
  if (holdTimer && !held.value) { clearTimeout(holdTimer); holdTimer = null; }
}

function onWindowMove(e: PointerEvent) {
  if (!held.value) return;
  pointerX.value = e.clientX;
  pointerY.value = e.clientY;
  dropTo.value = calcDropSlot(e.clientX);
}

function onWindowUp() {
  window.removeEventListener('pointermove', onWindowMove);
  window.removeEventListener('pointerup', onWindowUp);
  window.removeEventListener('pointercancel', onWindowCancel);
  if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
  if (held.value && dragFrom.value >= 0 && dropTo.value >= 0 && dragFrom.value !== dropTo.value) {
    commitReorder(dragFrom.value, dropTo.value);
  }
  held.value = false;
  dragFrom.value = -1;
  dropTo.value = -1;
}

async function commitReorder(from: number, to: number) {
  const arr = [...items.value];
  const [moved] = arr.splice(from, 1);
  arr.splice(to, 0, moved);

  arr.forEach((item, i) => {
    if (item.type === 'note') {
      notesStore.setPinOrder(item.id, i);
    } else {
      labelsStore.setPinOrder(item.id, i);
    }
  });
}

function isGhost(item: PinnedItem): boolean {
  return held.value && !!draggedItem.value &&
    item.id === draggedItem.value.id && item.type === draggedItem.value.type;
}
</script>

<template>
  <div
    v-if="items.length > 0"
    class="strata-pinned"
    data-testid="strata-pinned"
  >
    <div
      ref="itemsEl"
      class="strata-pinned__items"
    >
      <template
        v-for="item in previewOrder"
        :key="item.type + '-' + item.id"
      >
        <LabelChip
          v-if="item.type === 'label'"
          :name="getTitle(item)"
          :color="getColor(item)"
          :class="{ 'strata-pinned--ghost': isGhost(item) }"
          data-testid="strata-pinned-label"
          @click="handleClick(item)"
          @pointerdown="onPointerDown($event, items.indexOf(item))"
          @pointerleave="onPointerLeave"
          @contextmenu.prevent
        />
        <span
          v-else
          class="strata-pinned__note"
          :class="{ 'strata-pinned--ghost': isGhost(item) }"
          role="link"
          tabindex="0"
          data-testid="strata-pinned-note"
          @click="handleClick(item)"
          @keydown.enter="handleClick(item)"
          @pointerdown="onPointerDown($event, items.indexOf(item))"
          @pointerleave="onPointerLeave"
          @contextmenu.prevent
        >
          <i class="icon icon-file strata-pinned__icon" />
          {{ getTitle(item) }}
        </span>
      </template>
    </div>

    <template v-if="held && draggedItem">
      <LabelChip
        v-if="draggedItem.type === 'label'"
        :name="getTitle(draggedItem)"
        :color="getColor(draggedItem)"
        class="strata-pinned--floating"
        :style="{ left: (pointerX - grabOffsetX) + 'px', top: (pointerY - grabOffsetY) + 'px' }"
      />
      <span
        v-else
        class="strata-pinned__note strata-pinned--floating"
        :style="{ left: (pointerX - grabOffsetX) + 'px', top: (pointerY - grabOffsetY) + 'px' }"
      >
        <i class="icon icon-file strata-pinned__icon" />
        {{ getTitle(draggedItem) }}
      </span>
    </template>
  </div>
</template>

<style lang="scss" scoped>
.strata-pinned {
  position: relative;

  &__items {
    display:     flex;
    flex-wrap:   wrap;
    align-items: center;
    gap:         var(--dev-space-3);
    user-select: none;

    :deep(.strata-chip) { touch-action: none; }
  }

  &__note {
    display:       inline-flex;
    align-items:   center;
    gap:           6px;
    max-width:     100%;
    height:        28px;
    padding:       0 10px;
    border:        1px solid var(--border);
    border-radius: var(--r-sm);
    background:    var(--box-bg);
    color:         var(--body-text);
    font-size:     12px;
    font-weight:   500;
    white-space:   nowrap;
    cursor:        pointer;
    user-select:   none;
    touch-action:  none;

    &:hover, &:focus-visible { border-color: var(--dev-accent); outline: none; }

    /*
     * The product gives everything with role=button a 44px touch height on a phone
     * (design/mobile.css), which takes the label chips here; a note is a link, so it stayed
     * 28px and the bar had two heights in one row.
     */
    @media (max-width: 760px) { height: 44px; }
  }

  &__icon { color: var(--muted); font-size: 12px; }

  /* Through :deep: on a LabelChip these land on a root this component's scope does not mark. */
  :deep(.strata-pinned--ghost) {
    opacity:        0.25;
    pointer-events: none;
  }

  :deep(.strata-pinned--floating) {
    position:       fixed;
    z-index:        1000;
    transform:      translate(-50%, -50%) rotate(4deg) scale(1.05);
    pointer-events: none;
    box-shadow:     0 6px 20px rgba(0, 0, 0, 0.35);
  }
}
</style>
