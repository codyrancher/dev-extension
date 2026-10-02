<script setup lang="ts">
/**
 * A card, small.
 *
 * Two places want one and they want it for the same reason: the card gallery, where you are
 * judging what a kind of work will look like, and the pinned rail, where you have taken a card
 * out of the deck and want to know it is still there. In both, a drawing of a card that has to
 * be kept in step with the card is wrong within a month - so this is the real component, laid
 * out at the size it lays itself out for, and scaled into whatever room it is given.
 *
 * `blur` is what makes it honest in the rail. A pinned card is a card you are not reading: its
 * detail is stale the moment it is parked, and keeping it true would mean re-reading the pull
 * request to redraw something 124px tall. So the detail is blurred and the two things that do
 * not go stale - what it is, and what it wants - are drawn over the top at a size you can read.
 */
import {
  onBeforeUnmount, onMounted, ref
} from 'vue';
import FocusCard from './FocusCard.vue';
import type { FocusTask } from '../../focus';

const props = defineProps<{
  task: FocusTask;
  /** Blur the card behind the labels, for a miniature nobody is meant to read. */
  blur?: boolean;
}>();

/**
 * The size the card is drawn at before it is shrunk.
 *
 * A card clamps its type against the viewport and lays its footer out as a row of full-size
 * buttons, so a miniature has to be that card at that width - draw it at 200px and it is not a
 * small card, it is a different card.
 */
const DRAWN = { w: 840, h: 520 };

const frame = ref<HTMLElement | null>(null);

/** The scale, measured: this sits in a 345px grid cell in one place and a 180px rail in another. */
function fit() {
  const el = frame.value;

  if (el) {
    el.style.setProperty('--mini-scale', String(el.clientWidth / DRAWN.w));
  }
}

let watching: ResizeObserver | null = null;

onMounted(() => {
  fit();
  watching = new ResizeObserver(fit);
  if (frame.value) {
    watching.observe(frame.value);
  }
});

onBeforeUnmount(() => watching?.disconnect());
</script>

<template>
  <div
    ref="frame"
    class="mini-card"
    :class="[`mini-card--${ task.card.kind }`, { 'mini-card--blur': blur }]"
    :style="{ '--drawn-w': `${ DRAWN.w }px`, '--drawn-h': `${ DRAWN.h }px` }"
  >
    <div class="mini-card__stage" inert>
      <FocusCard :task="task" />
    </div>

    <!-- What does not go stale, over the top, at a size that can be read. -->
    <div
      v-if="blur"
      class="mini-card__label"
    >
      <span class="mini-card__what">{{ task.what }}</span>
      <span class="mini-card__title">{{ task.title || task.needs }}</span>
      <span class="mini-card__needs">{{ task.needs }}</span>
    </div>
  </div>
</template>

<style scoped>
.mini-card {
  position: relative;
  width: 100%;
  /* The drawn card's shape, so this is the card rather than a window onto part of it. A ratio,
     not two lengths: `840px / 520px` is invalid in `aspect-ratio` and is silently dropped. */
  aspect-ratio: 840 / 520;
  border: 1px solid color-mix(in srgb, var(--kind-c) 30%, var(--border));
  border-radius: var(--r-md);
  background: var(--surface-sunk);
  overflow: hidden;
}

.mini-card__stage {
  width: var(--drawn-w);
  height: var(--drawn-h);
  transform: scale(var(--mini-scale, 0.4));
  transform-origin: 0 0;
  pointer-events: none;
}

/* Parked rather than being read: the card is there, the words are legible, the detail is not. */
.mini-card--blur .mini-card__stage {
  filter: blur(2.5px) saturate(0.85);
  opacity: 0.5;
}

.mini-card__label {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
  gap: 1px;
  padding: var(--s2) var(--s3);
  background: linear-gradient(180deg, color-mix(in srgb, var(--surface-sunk) 55%, transparent) 0%, var(--surface-sunk) 62%);
}

.mini-card__what {
  color: var(--kind-c);
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.05em;
  text-transform: uppercase;
}

.mini-card__title {
  color: var(--text);
  font-size: var(--t-sm);
  line-height: 1.25;
  /* Two lines of title and then an ellipsis: the rail is a reminder, not a reading surface. */
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  overflow: hidden;
}

.mini-card__needs {
  color: var(--text-faint);
  font-size: var(--t-xs);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mini-card--review   { --kind-c: var(--kind-review); }
.mini-card--issue    { --kind-c: var(--kind-issue); }
.mini-card--agent    { --kind-c: var(--kind-agent); }
.mini-card--question { --kind-c: var(--kind-question); }
.mini-card--signal   { --kind-c: var(--kind-signal); }
</style>
