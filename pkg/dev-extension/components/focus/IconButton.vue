<script setup lang="ts">
/** A round control with one icon in it: the chat bar's two ends, a card's dismiss. */
import AppIcon from './AppIcon.vue';
import type { IconName } from './icons';

withDefaults(defineProps<{ name: IconName; label: string; size?: number; active?: boolean }>(), {
  size: 42,
  active: false,
});
</script>

<template>
  <button
    type="button"
    class="icon-btn"
    :class="{ 'icon-btn--active': active }"
    :style="{ width: `${ size }px`, height: `${ size }px` }"
    :title="label"
    :aria-label="label"
    :aria-pressed="active"
  >
    <AppIcon :name="name" :size="Math.round(size * 0.44)" />
  </button>
</template>

<style scoped>
.icon-btn {
  display: grid;
  place-items: center;
  border: 1px solid var(--border);
  border-radius: var(--r-pill);
  background: var(--surface-raised);
  color: var(--text-dim);
  cursor: pointer;
  transition:
    background var(--fast) var(--ease-out),
    border-color var(--fast) var(--ease-out),
    color var(--fast) var(--ease-out),
    transform var(--base) var(--ease-spring);
}

.icon-btn:hover {
  border-color: var(--border-strong);
  color: var(--text);
  transform: translateY(-1px);
}

.icon-btn:active { transform: translateY(0) scale(0.95); }

.icon-btn--active {
  border-color: var(--accent);
  background: var(--accent-wash);
  color: var(--accent);
}
</style>
