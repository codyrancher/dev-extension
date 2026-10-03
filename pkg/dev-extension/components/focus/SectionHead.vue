<script setup lang="ts">
/**
 * The line that names a part of a card.
 *
 * Six components had grown their own copy of this - the pool, the reviewers, the commits, the
 * comments, the change set and the pass - and all six copies were the same five declarations:
 * an icon at 14px, six pixels of gap, the card's hue, small, 620. Six copies of a thing that is
 * meant to look identical is six chances for it to stop looking identical, and that drift is
 * exactly what reads as "off" on a card without anybody being able to say why.
 *
 * So: the title on the left, a count beside it in the quiet colour, and whatever the component
 * wants on the right through the default slot - a hint, a warning, a number that matters.
 */
import AppIcon from './AppIcon.vue';
import type { IconName } from './icons';

withDefaults(defineProps<{
  label: string;
  icon?: IconName;
  /** A plain count in the muted colour, beside the title: "8 comments", "42 open". */
  count?: string;
}>(), { icon: 'tasks', count: '' });
</script>

<template>
  <header class="sh">
    <span class="sh__title">
      <AppIcon :name="icon" :size="14" />
      {{ label }}
    </span>
    <span v-if="count" class="sh__count">{{ count }}</span>
    <slot />
  </header>
</template>

<style scoped>
/*
 * Never the thing that shrinks.
 *
 * `focus.css` resets every semantic element in this view - `header { min-height: 0 }` among them,
 * because the shell draws a bare `header` as its own 48px page header - and that reset defeats the
 * flex automatic minimum size of this `<header>` as an item of the `.fx` / `.pool` / `.card__said`
 * columns. So when the body overflowed, the head was what gave: measured across a 26-card walk,
 * `.sh` came out 0px on five heads, 1px, 3.3px, 5px, 5.4px, 7.7px and 12px on seven more, against
 * 19.5px where it rendered. `align-items: center` on a collapsed row then puts the children above
 * it - the advisory's severity pill sat 13px above its own head's top edge - so "The advisory" and
 * a `HIGH` badge drew with their top halves sliced off by the body's clip edge.
 *
 * `flex: 0 0 auto` is the fix, and it is the same fix the note row, the file tree, the pool row and
 * the card's own header all carry: a flex child with no `flex-shrink: 0` in a bounded parent is
 * squeezed below its content and paints over its neighbour. The `min-height` keeps a head holding a
 * 26px pill at the pill's height.
 *
 * **And one line, not a wrap.** The wrap was there for the one head whose labels made it 42.5px,
 * which treated the symptom: a head that can grow does grow, and every pixel it takes comes off
 * the surface under it. Measured, `.sh` was 26px on 11 cards and 42px on the two start-fix cards
 * whose issue has four labels - so the issue's own words got 78px there against 93px next door,
 * for no reason but a label. The head is 26px on every card now and what does not fit in it is
 * the content's problem to cut; see `.marks` in IssueMarks, which fades.
 */
.sh {
  display: flex;
  align-items: center;
  flex: 0 0 auto;
  flex-wrap: nowrap;
  gap: var(--s3);
  /*
   * `min-height`, not `height`: the head is 26px on every card that puts a label or a pill in it,
   * which is all but two, and those two put a 32px control in it - and `--control-h` is 32 because
   * 26 is below the floor for anything you press. Clipping the control to keep the number tidy
   * would be the wrong way round. What `nowrap` above stops is the 42px case, which was a wrap.
   */
  min-height: var(--pill-h);
  min-width: 0;
}

.sh__title {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex: 0 0 auto;
  color: var(--kind);
  font-size: var(--t-sm);
  font-weight: 620;
}

.sh__count { flex: 0 0 auto; color: var(--text-muted); font-size: var(--t-sm); white-space: nowrap; }

/*
 * Everything a component puts after the count goes to the right edge. It was `margin-left: auto`
 * on each component's own trailing element, which is the same rule written four times in four
 * files under four names.
 */
.sh > :deep(*:last-child:not(.sh__title):not(.sh__count)) {
  margin-left: auto;
  /* Shrinkable, because the row no longer wraps: a trailing hint or a row of labels gives way
     rather than making the head taller. */
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
