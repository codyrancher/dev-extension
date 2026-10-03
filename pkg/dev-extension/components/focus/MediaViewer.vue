<script setup lang="ts">
/**
 * The full view of a thumbnail.
 *
 * On a card, media is small on purpose - it is evidence, not the point - so the thumbnail has
 * to open into something you can actually read: an image you can zoom into and drag around, a
 * video you can scrub. Everything the card holds is in here, so moving between the three shots
 * an agent attached does not mean closing one and finding the next.
 *
 * Zoom follows the pointer rather than the centre, because the thing you want to look at is
 * under the cursor, and dragging is only enabled once there is somewhere to drag to.
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { CardMedia } from '../../focus-artifacts';
import IconButton from './IconButton.vue';
import { holdOverlay, releaseOverlay } from './overlay';

const props = defineProps<{ items: CardMedia[]; start?: number }>();
const emit = defineEmits<{ (e: 'close'): void }>();

const at = ref(props.start ?? 0);
const item = computed(() => props.items[at.value]);

const scale = ref(1);
const x = ref(0);
const y = ref(0);
const stage = ref<HTMLElement>();
const dragging = ref(false);
let from = { x: 0, y: 0, ox: 0, oy: 0 };

const MIN = 1;
const MAX = 6;

function reset() {
  scale.value = 1;
  x.value = 0;
  y.value = 0;
}

function go(step: 1 | -1) {
  at.value = (at.value + step + props.items.length) % props.items.length;
}

watch(at, reset);

/** Zoom about a point, so what is under the cursor stays under the cursor. */
function zoomAt(factor: number, clientX?: number, clientY?: number) {
  const next = Math.min(MAX, Math.max(MIN, scale.value * factor));
  const box = stage.value?.getBoundingClientRect();

  if (box && clientX !== undefined && clientY !== undefined) {
    const px = clientX - box.left - box.width / 2;
    const py = clientY - box.top - box.height / 2;
    const ratio = next / scale.value;

    x.value = px - (px - x.value) * ratio;
    y.value = py - (py - y.value) * ratio;
  }
  scale.value = next;
  if (next === MIN) {
    x.value = 0;
    y.value = 0;
  }
}

function onWheel(event: WheelEvent) {
  event.preventDefault();
  zoomAt(event.deltaY < 0 ? 1.18 : 1 / 1.18, event.clientX, event.clientY);
}

function onDown(event: PointerEvent) {
  if (scale.value === MIN) {
    return;
  }
  dragging.value = true;
  from = { x: event.clientX, y: event.clientY, ox: x.value, oy: y.value };
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
}

function onMove(event: PointerEvent) {
  if (!dragging.value) {
    return;
  }
  x.value = from.ox + (event.clientX - from.x);
  y.value = from.oy + (event.clientY - from.y);
}

const onUp = () => { dragging.value = false; };

function onKey(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    emit('close');
  }
  if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
    event.preventDefault();
    go(1);
  }
  if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
    event.preventDefault();
    go(-1);
  }
  if (event.key === '0') {
    reset();
  }
}

/*
 * The deck also listens on the window, and it turns on the arrow keys. While this is open the
 * arrows belong to the pictures, so the deck is told to keep its hands down.
 */
onMounted(() => {
  holdOverlay();
  window.addEventListener('keydown', onKey);
});

onBeforeUnmount(() => {
  releaseOverlay();
  window.removeEventListener('keydown', onKey);
});
</script>

<template>
  <div class="viewer" @click.self="emit('close')">
    <header class="viewer__bar" @click.stop>
      <span class="viewer__label">{{ item.label }}</span>
      <span v-if="items.length > 1" class="viewer__count">{{ at + 1 }} of {{ items.length }}</span>

      <span class="viewer__tools">
        <template v-if="item.kind === 'image'">
          <IconButton name="minus" label="Zoom out" :size="34" @click="zoomAt(1 / 1.4)" />
          <span class="viewer__scale">{{ Math.round(scale * 100) }}%</span>
          <IconButton name="plus" label="Zoom in" :size="34" @click="zoomAt(1.4)" />
          <IconButton name="expand" label="Fit to the window" :size="34" @click="reset" />
        </template>
        <IconButton name="cross" label="Close" :size="34" @click="emit('close')" />
      </span>
    </header>

    <div
      ref="stage"
      class="viewer__stage"
      :class="{ 'viewer__stage--grab': scale > 1, 'viewer__stage--held': dragging }"
      @click.self="emit('close')"
      @wheel.prevent="item.kind === 'image' ? onWheel($event) : undefined"
    >
      <img
        v-if="item.kind === 'image'"
        :src="item.src"
        :alt="item.label"
        class="viewer__img"
        :style="{ transform: `translate(${ x }px, ${ y }px) scale(${ scale })`, transition: dragging ? 'none' : undefined }"
        draggable="false"
        @pointerdown="onDown"
        @pointermove="onMove"
        @pointerup="onUp"
        @pointercancel="onUp"
        @dblclick="scale > 1 ? reset() : zoomAt(2.4, $event.clientX, $event.clientY)"
      >

      <video
        v-else
        :src="item.src"
        class="viewer__video"
        controls
        autoplay
        loop
        playsinline
      />
    </div>

    <footer class="viewer__foot" @click.stop>
      <IconButton v-if="items.length > 1" name="chevron-left" label="Previous" :size="34" @click="go(-1)" />
      <p class="viewer__caption">{{ item.caption || item.label }}</p>
      <IconButton v-if="items.length > 1" name="chevron-right" label="Next" :size="34" @click="go(1)" />
    </footer>
  </div>
</template>

<style scoped>
.viewer {
  position: fixed;
  inset: 0;
  z-index: 80;
  display: grid;
  grid-template-rows: auto minmax(0, 1fr) auto;
  gap: var(--s3);
  padding: var(--s4) clamp(var(--s4), 3vw, var(--s6)) var(--s5);
  background: color-mix(in srgb, var(--ground-deep) 88%, transparent);
  backdrop-filter: blur(14px);
  animation: viewer-in var(--base) var(--ease-out);
}

@keyframes viewer-in {
  from { opacity: 0; backdrop-filter: blur(0); }
}

.viewer__bar {
  display: flex;
  align-items: center;
  gap: var(--s3);
  min-width: 0;
}

.viewer__label {
  color: var(--text);
  font-size: var(--t-lg);
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.viewer__count { color: var(--text-muted); font-size: var(--t-sm); }
.viewer__tools { display: flex; align-items: center; gap: var(--s2); margin-left: auto; }
.viewer__scale { min-width: 4ch; color: var(--text-dim); font-size: var(--t-sm); text-align: center; }

.viewer__stage {
  display: grid;
  place-items: center;
  min-height: 0;
  overflow: hidden;
  border-radius: var(--r-lg);
}

.viewer__stage--grab { cursor: grab; }
.viewer__stage--held { cursor: grabbing; }

.viewer__img {
  max-width: 100%;
  max-height: 100%;
  border-radius: var(--r-md);
  box-shadow: var(--shadow-3);
  transform-origin: 50% 50%;
  transition: transform var(--base) var(--ease-out);
  user-select: none;
  -webkit-user-drag: none;
}

.viewer__video {
  max-width: 100%;
  max-height: 100%;
  border-radius: var(--r-md);
  /* The deepest ground, not a literal black: this view has a light theme and the letterbox
     around a portrait recording was the one part of the viewer that did not know. */
  background: var(--ground-deep);
  box-shadow: var(--shadow-3);
}

.viewer__foot {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--s4);
}

.viewer__caption {
  max-width: 78ch;
  color: var(--text-dim);
  font-size: var(--t-sm);
  line-height: 1.5;
  text-align: center;
}

@media (max-width: 860px) {
  .viewer { padding: var(--s3); }
  .viewer__label { font-size: var(--t-md); }
}
</style>
