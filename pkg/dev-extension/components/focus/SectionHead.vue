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
.sh {
  display: flex;
  align-items: center;
  gap: var(--s3);
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

.sh__count { color: var(--text-muted); font-size: var(--t-sm); }

/*
 * Everything a component puts after the count goes to the right edge. It was `margin-left: auto`
 * on each component's own trailing element, which is the same rule written four times in four
 * files under four names.
 */
.sh > :deep(*:last-child:not(.sh__title):not(.sh__count)) { margin-left: auto; }
</style>
