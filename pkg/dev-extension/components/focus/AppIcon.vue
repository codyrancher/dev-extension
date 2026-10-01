<script setup lang="ts">
/**
 * Every icon in the app, as one component.
 *
 * Inline paths rather than a font or a sprite: there are a dozen, they inherit `currentColor`,
 * and a mockup should not load a webfont to draw a cog. `size` is a number, so a caller never
 * has to think in em.
 */
import { filledIcons, iconPaths } from './icons';
import type { IconName } from './icons';

const props = withDefaults(defineProps<{ name: IconName; size?: number }>(), { size: 18 });
</script>

<template>
  <svg
    class="icon"
    :class="{ 'icon--spin': props.name === 'spinner' }"
    :width="props.size"
    :height="props.size"
    viewBox="0 0 20 20"
    :fill="filledIcons.includes(props.name) ? 'currentColor' : 'none'"
    stroke="currentColor"
    :stroke-width="filledIcons.includes(props.name) ? 0 : 1.7"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    <path :d="iconPaths[props.name]" />
  </svg>
</template>

<style scoped>
.icon {
  display: block;
  flex: none;
}

.icon--spin {
  animation: icon-spin 900ms linear infinite;
  transform-origin: 50% 50%;
}

@keyframes icon-spin {
  to { transform: rotate(360deg); }
}
</style>
