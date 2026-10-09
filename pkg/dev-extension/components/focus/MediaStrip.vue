<script setup lang="ts">
/**
 * What was recorded, as pictures rather than as a count.
 *
 * It was a pill reading `8 recordings`, and it was pressed to find out what the eight were. The
 * few that say the most are drawn here instead - the fix working, the bug it fixes, see `mediaOf`
 * for how they are chosen - each one a press away from itself at full size, and the rest are
 * behind `Show all`, which opens the viewer on its grid.
 *
 * A thumbnail is a still. Nothing plays on a card: see MediaViewer for why a row of players is a
 * row of things making noise about where you have not looked.
 */
import { computed } from 'vue';
import type { CardMedia } from '../../focus-artifacts';
import AppIcon from './AppIcon.vue';
import { firstFrame, still } from './media';

const props = defineProps<{ items: CardMedia[] }>();

/** `start` is the place in `items` of the one that was pressed; none means all of them. */
const emit = defineEmits<{ (e: 'open', start?: number): void }>();

/** How many are drawn. Four 16:10 stills at the row's height is about a third of a card's width. */
const MOST = 4;

/**
 * The ones to draw, each with its place in `items` so the viewer opens on the one pressed.
 *
 * The chosen ones in the order they were chosen, where anything was chosen. A set nobody ranked -
 * what a reviewer hung on one comment - is taken from the front: it was all attached on purpose.
 */
const shown = computed(() => {
  const pictures = props.items.map((item, at) => ({ item, at })).filter(({ item }) => item.kind !== 'text');
  const chosen = pictures.filter(({ item }) => item.featured).sort((a, b) => (a.item.featured || 0) - (b.item.featured || 0));

  return (chosen.length ? chosen : pictures).slice(0, MOST);
});

const KIND = { image: 'Screenshot', video: 'Recording', text: 'File' } as const;
</script>

<template>
  <div class="ms">
    <!--
      One line of them, and the ones that do not fit are not drawn at all rather than cut in
      half: the box wraps, is one thumbnail tall, and hides what wrapped.
    -->
    <div v-if="shown.length" class="ms__thumbs">
      <button
        v-for="{ item, at } in shown"
        :key="item.src"
        type="button"
        class="ms__thumb"
        :title="`${ KIND[item.kind] }: ${ item.caption || item.label }`"
        @click="emit('open', at)"
      >
        <video
          v-if="item.kind === 'video'"
          class="ms__media"
          :src="firstFrame(item.src)"
          preload="metadata"
          muted
          playsinline
          @loadedmetadata="still"
        />
        <img
          v-else
          class="ms__media"
          :src="item.src"
          :alt="item.caption || item.label"
          loading="lazy"
        >
        <span v-if="item.kind === 'video'" class="ms__play"><AppIcon name="play" :size="10" /></span>
        <!-- What it was recorded for, which is the directory it was written into. -->
        <span v-if="item.dir" class="ms__dir">{{ item.dir }}</span>
      </button>
    </div>

    <button
      v-if="items.length > shown.length"
      type="button"
      class="ms__all"
      :title="`Look through all ${ items.length }: ${ items.map((item) => item.label).join(', ') }`"
      @click="emit('open')"
    >
      <AppIcon name="grid" :size="11" />
      Show all {{ items.length }}
    </button>
  </div>
</template>

<style scoped>
/* On the facts row, as tall as the row: `--shot-h` is declared with the other heights. */
.ms {
  display: flex;
  align-items: center;
  flex: 0 1 auto;
  gap: var(--s2);
  min-width: 0;
}

.ms__thumbs {
  display: flex;
  flex: 0 1 auto;
  flex-wrap: wrap;
  gap: var(--s2);
  height: var(--shot-h);
  /* Never fewer than one: a row with no picture on it is the pill this replaced. */
  min-width: calc(var(--shot-h) * 1.6);
  overflow: hidden;
}

.ms__thumb {
  position: relative;
  flex: 0 0 auto;
  height: var(--shot-h);
  aspect-ratio: 16 / 10;
  padding: 0;
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  /* A recording paints its own background before a frame arrives; see `.shot__frame`. */
  background: var(--ground-deep);
  overflow: hidden;
  cursor: pointer;
  transition: border-color var(--fast) var(--ease-out);
}

.ms__thumb:hover { border-color: var(--kind); }

/* Inside the edge, because the row clips and a ring outside the thumbnail is cut off by it. */
.ms__thumb:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: -2px;
}

.ms__media {
  display: block;
  width: 100%;
  height: 100%;
  /*
   * `cover`, where the viewer's tiles are `contain`. At this size the letterbox is most of the
   * picture, and what tells two of these apart is the directory written on them, not their edges.
   */
  object-fit: cover;
  object-position: top;
}

.ms__play {
  position: absolute;
  inset: var(--s1) var(--s1) auto auto;
  display: grid;
  place-items: center;
  width: 18px;
  height: 18px;
  border-radius: var(--r-pill);
  background: color-mix(in srgb, var(--ground) 72%, transparent);
  color: var(--text);
}

.ms__dir {
  position: absolute;
  inset: auto 0 0 0;
  padding: 2px var(--s1);
  background: color-mix(in srgb, var(--ground) 78%, transparent);
  color: var(--text);
  font-family: var(--mono);
  font-size: var(--t-2xs);
  line-height: 1.2;
  text-align: left;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ms__all {
  display: inline-flex;
  align-items: center;
  flex: 0 0 auto;
  gap: var(--s1);
  height: var(--control-h);
  padding: 0 var(--s3);
  border: 1px solid color-mix(in srgb, var(--kind) 34%, var(--border));
  border-radius: var(--r-pill);
  background: transparent;
  color: var(--kind);
  font: inherit;
  font-size: var(--t-xs);
  line-height: 1;
  white-space: nowrap;
  cursor: pointer;
  transition: background var(--fast), color var(--fast);
}

.ms__all:hover { background: color-mix(in srgb, var(--kind) 12%, transparent); color: var(--text); }
</style>
