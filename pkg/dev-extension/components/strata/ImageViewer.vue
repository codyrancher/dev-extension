<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue';

// A picture at full size over everything: fitted first, then wheel or pinch to zoom at the
// pointer and drag to pan. A clean tap, Esc or the × closes it. Kept from Strata as it was.
const props = defineProps<{ src: string }>();
const emit = defineEmits<{ (e: 'close'): void }>();

const viewerEl = ref<HTMLElement | null>(null);
const imgEl = ref<HTMLImageElement | null>(null);
const scale = ref(1);
const translateX = ref(0);
const translateY = ref(0);
let fitScale = 1;

// Start contain-fitted: maximize width or height depending on the aspect
// ratios of the image and the viewport.
function fitImage() {
  const img = imgEl.value;
  const viewer = viewerEl.value;
  if (!img || !viewer || !img.naturalWidth || !img.naturalHeight) return;
  const r = viewer.getBoundingClientRect();
  fitScale = Math.min(r.width / img.naturalWidth, r.height / img.naturalHeight);
  scale.value = fitScale;
  translateX.value = 0;
  translateY.value = 0;
}

// Unified pointer-based gestures: one pointer pans, two pinch-zoom (anchored
// at the pinch midpoint) while also panning with the midpoint.
const pointers = new Map<number, { x: number; y: number }>();
let pinchStartDist = 0;
let pinchStartScale = 1;
let downX = 0;
let downY = 0;
let moved = false;

function viewerCenter(): { x: number; y: number } {
  const r = viewerEl.value?.getBoundingClientRect();
  if (!r) return { x: window.innerWidth / 2, y: window.innerHeight / 2 };
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

// Scale so the image point currently under (px, py) stays under it
function zoomAt(px: number, py: number, newScale: number) {
  newScale = Math.max(Math.min(0.1, fitScale), Math.min(10, newScale));
  const c = viewerCenter();
  const ratio = newScale / scale.value;
  translateX.value = px - c.x - ratio * (px - c.x - translateX.value);
  translateY.value = py - c.y - ratio * (py - c.y - translateY.value);
  scale.value = newScale;
}

// Mac trackpads fire wheel events far more often than a notched mouse wheel,
// so a fixed per-event step zooms way too fast there — halve it on Macs.
// (MacIntel + multi-touch is an iPad, which zooms via pinch, not wheel.)
const isMac = /Mac/.test(navigator.platform) && navigator.maxTouchPoints <= 1;
const wheelStep = isMac ? 0.05 : 0.1;

function onWheel(e: WheelEvent) {
  const factor = e.deltaY > 0 ? 1 - wheelStep : 1 + wheelStep;
  zoomAt(e.clientX, e.clientY, scale.value * factor);
}

function onPointerDown(e: PointerEvent) {
  (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pointers.size === 1) {
    downX = e.clientX;
    downY = e.clientY;
    moved = false;
  } else if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    pinchStartDist = Math.hypot(a.x - b.x, a.y - b.y);
    pinchStartScale = scale.value;
  }
}

function onPointerMove(e: PointerEvent) {
  const prev = pointers.get(e.pointerId);
  if (!prev) return;
  const cur = { x: e.clientX, y: e.clientY };

  if (pointers.size === 1) {
    translateX.value += cur.x - prev.x;
    translateY.value += cur.y - prev.y;
  } else if (pointers.size === 2) {
    const other = [...pointers.entries()].find(([id]) => id !== e.pointerId)?.[1];
    if (other) {
      // Pan with the midpoint, zoom by the distance ratio around the midpoint
      const mid = { x: (cur.x + other.x) / 2, y: (cur.y + other.y) / 2 };
      translateX.value += (cur.x - prev.x) / 2;
      translateY.value += (cur.y - prev.y) / 2;
      const dist = Math.hypot(cur.x - other.x, cur.y - other.y);
      if (pinchStartDist > 0) {
        zoomAt(mid.x, mid.y, pinchStartScale * (dist / pinchStartDist));
      }
    }
  }

  pointers.set(e.pointerId, cur);
  if (Math.hypot(e.clientX - downX, e.clientY - downY) > 6) moved = true;
}

function onPointerUp(e: PointerEvent) {
  pointers.delete(e.pointerId);
  if (pointers.size < 2) pinchStartDist = 0;
}

function onTap() {
  // Only a clean tap (no drag/pinch) closes the viewer
  if (!moved && pointers.size === 0) emit('close');
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') emit('close');
}

onMounted(() => document.addEventListener('keydown', onKeydown));
onUnmounted(() => document.removeEventListener('keydown', onKeydown));
</script>

<template>
  <Teleport to="body">
    <div
      ref="viewerEl"
      class="strata-viewer"
      data-testid="strata-image-viewer"
      @wheel.prevent="onWheel"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointercancel="onPointerUp"
      @click="onTap"
    >
      <button
        type="button"
        class="strata-viewer__close"
        aria-label="Close"
        data-testid="strata-image-viewer-close"
        @pointerdown.stop
        @click.stop="emit('close')"
      >
        <i class="icon icon-close" />
      </button>
      <img
        ref="imgEl"
        :src="props.src"
        alt=""
        draggable="false"
        :style="{
          transform: `translate(${ translateX }px, ${ translateY }px) scale(${ scale })`,
          pointerEvents: 'none',
          willChange: 'transform'
        }"
        @load="fitImage"
      >
    </div>
  </Teleport>
</template>

<style lang="scss" scoped>
.strata-viewer {
  position:            fixed;
  inset:               0;
  z-index:             1300;
  display:             flex;
  align-items:         center;
  justify-content:     center;
  background:          rgba(0, 0, 0, 0.9);
  cursor:              grab;
  touch-action:        none;
  overscroll-behavior: contain;

  &:active { cursor: grabbing; }

  img {
    max-width:         none;
    max-height:        none;
    user-select:       none;
    -webkit-user-drag: none;
  }

  &__close {
    position:        fixed;
    top:             calc(var(--dev-space-5) + env(safe-area-inset-top, 0px));
    right:           var(--dev-space-5);
    z-index:         1;
    display:         flex;
    align-items:     center;
    justify-content: center;
    width:           40px;
    height:          40px;
    min-height:      0;
    padding:         0;
    border:          0;
    border-radius:   50%;
    background:      rgba(255, 255, 255, 0.15);
    color:           #fff;
    font-size:       18px;
    line-height:     1;
    cursor:          pointer;

    &:hover { background: rgba(255, 255, 255, 0.25); }
  }
}
</style>
