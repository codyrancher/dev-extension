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
 * request to redraw something 102px tall. So it is blurred - the shape of the card, its hue and
 * its weight, with none of the words claiming to be current.
 *
 * It carried its title and what it wanted, unblurred, over the top. They are gone: at this size
 * a line of text is a grey smear with a serif on it, and the card's own colour and shape say
 * which one it is faster than four words do. The name is on the button's title for anyone who
 * wants it spelled out.
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

/*
 * Parked rather than being read.
 *
 * Enough blur that no word in it claims to be current, and enough of the card left that it is
 * recognisably a card: its hue at the edges, its title block, the row of buttons along the
 * bottom. Brighter than it was, now that nothing is drawn over it.
 */
.mini-card--blur .mini-card__stage {
  filter: blur(2.2px) saturate(0.9);
  opacity: 0.72;
}





.mini-card--review   { --kind-c: var(--kind-review); }
.mini-card--issue    { --kind-c: var(--kind-issue); }
.mini-card--agent    { --kind-c: var(--kind-agent); }
.mini-card--question { --kind-c: var(--kind-question); }
.mini-card--signal   { --kind-c: var(--kind-signal); }
</style>
