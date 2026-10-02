<script setup lang="ts">
/**
 * One card, in the air.
 *
 * Pinning and unpinning are the same movement in opposite directions - a card on the deck becomes
 * a card in the rail, or the other way round - and neither is a turn of the deck. Nothing is
 * being dealt. They were drawn by the deck's transition anyway, which is why unpinning arrived
 * *behind* the card on top (the forward reading uncovers a card from under the one leaving, on
 * purpose) and why pinning had no animation at all: the deck's turn has no direction that points
 * at the rail.
 *
 * So the card flies instead, over everything: a fixed copy drawn once at the larger of the two
 * boxes and carried between them in one motion. The real card is hidden at both ends while this
 * is in the air - `landing` on FocusDeck, `.pin--flying` in the rail - so there is exactly one of
 * it on the screen at any moment.
 *
 * Driven by the Web Animations API rather than by classes and custom properties. `finished` is a
 * promise that resolves once, which is the whole of why this plays every time: the old version
 * set `--carry-in` on the deck and depended on a transition firing to clear it again, and when
 * the card happened to land on the index that was already showing, no transition fired, the
 * property stayed set, and the next unpin had nowhere to start from.
 */
import { onMounted, ref } from 'vue';
import FocusCard from './FocusCard.vue';
import type { FocusTask } from '../../focus';

/** A rectangle on the screen. DOMRect is one; so is anything measured and kept. */
interface Box { top: number; left: number; width: number; height: number }

const props = defineProps<{
  task: FocusTask;
  from: Box;
  to: Box;
  /**
   * `drop` is a card being put down on the deck: it arrives a little large and settles, the way
   * the deck lays a card back down. `dock` is a card being put away: it goes, and the last of it
   * fades as the blurred miniature it becomes takes over underneath.
   */
  mode: 'drop' | 'dock';
}>();

const emit = defineEmits<{ (e: 'done'): void }>();

const el = ref<HTMLElement | null>(null);

/*
 * Drawn at the larger box and scaled down to the smaller, never the other way round: a card laid
 * out at 164px and magnified is a card whose text was wrapped for 164px. At the deck's size it is
 * laid out once, as the card it really is, and the rail end is that card made small - which is
 * also exactly what the pinned miniature is, so the two match when they hand over.
 */
const big = props.from.width >= props.to.width ? props.from : props.to;

const at = (box: Box, scale = 1) => `translate3d(${
  Math.round(box.left - big.left) }px, ${ Math.round(box.top - big.top) }px, 0) scale(${
  ((box.width / big.width) * scale).toFixed(4) })`;

/* The deck's own curves and durations, so a flight reads as part of the same object. */
const PLACE = 'cubic-bezier(0.16, 0.84, 0.28, 1)';
const AWAY = 'cubic-bezier(0.4, 0.02, 0.22, 1)';

onMounted(() => {
  const node = el.value;

  if (!node || typeof node.animate !== 'function') {
    emit('done');

    return;
  }

  // The settle: a drop overshoots its size by a hair and comes back, which is what makes it land
  // rather than arrive. A dock has nothing to settle into - it is leaving - so it just goes.
  const frames = props.mode === 'drop' ? [
    { transform: at(props.from), opacity: 1 },
    { transform: at(props.to, 1.035), opacity: 1, offset: 0.74 },
    { transform: at(props.to), opacity: 1 },
  ] : [
    { transform: at(props.from), opacity: 1 },
    { transform: at(props.to), opacity: 1, offset: 0.82 },
    { transform: at(props.to), opacity: 0 },
  ];

  const flight = node.animate(frames, {
    duration: props.mode === 'drop' ? 440 : 380,
    easing:   props.mode === 'drop' ? PLACE : AWAY,
    fill:     'forwards',
  });

  flight.finished.catch(() => undefined).then(() => emit('done'));
});
</script>

<template>
  <!-- Over the deck, the rail and the chat bar: this is the only card on the screen right now. -->
  <Teleport to="body">
    <div class="dev-focus flight-layer">
      <div
        ref="el"
        class="flight"
        :class="`flight--${ task.card.kind }`"
        :style="{
          top: `${ big.top }px`,
          left: `${ big.left }px`,
          width: `${ big.width }px`,
          height: `${ big.height }px`,
        }"
        inert
        aria-hidden="true"
      >
        <FocusCard :task="task" />
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
/* A box of nothing that carries the view's tokens to a teleported child. See FocusModal. */
.flight-layer {
  position: fixed;
  inset: 0;
  z-index: 55;
  pointer-events: none;
}

.flight {
  position: fixed;
  /* The animation is written against this corner, so the card scales into its own top left. */
  transform-origin: 0 0;
  will-change: transform, opacity;
}
</style>
