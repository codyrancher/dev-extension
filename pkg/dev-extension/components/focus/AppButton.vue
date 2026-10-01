<script setup lang="ts">
/**
 * The button, in four weights.
 *
 * `primary` is the one thing a card wants you to do and there is never more than one on screen;
 * `ghost` is everything else a card offers; `quiet` is for a row of controls that should read as
 * furniture; `kind` borrows the current card's hue, which is how a card's own actions stay part
 * of the card rather than part of the app.
 */
import AppIcon from './AppIcon.vue';
import type { IconName } from './icons';

withDefaults(defineProps<{
  variant?: 'primary' | 'ghost' | 'quiet' | 'kind';
  size?: 'sm' | 'md' | 'lg';
  icon?: IconName;
  iconAfter?: IconName;
  busy?: boolean;
  block?: boolean;
}>(), { variant: 'ghost', size: 'md', busy: false, block: false });
</script>

<template>
  <button
    type="button"
    class="btn"
    :class="[`btn--${ variant }`, `btn--${ size }`, { 'btn--block': block, 'btn--busy': busy }]"
    :disabled="busy"
  >
    <AppIcon v-if="busy" name="spinner" :size="size === 'lg' ? 18 : 16" />
    <AppIcon v-else-if="icon" :name="icon" :size="size === 'lg' ? 18 : 16" />
    <span class="btn__label"><slot /></span>
    <AppIcon v-if="iconAfter && !busy" :name="iconAfter" :size="size === 'lg' ? 18 : 16" class="btn__after" />
  </button>
</template>

<style scoped>
.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--s2);
  border: 1px solid transparent;
  border-radius: var(--r-pill);
  background: transparent;
  font-weight: 560;
  letter-spacing: -0.01em;
  white-space: nowrap;
  cursor: pointer;
  transition:
    background var(--fast) var(--ease-out),
    border-color var(--fast) var(--ease-out),
    color var(--fast) var(--ease-out),
    transform var(--fast) var(--ease-spring),
    box-shadow var(--base) var(--ease-out);
}

.btn:active:not(:disabled) { transform: translateY(1px) scale(0.985); }
.btn:disabled { cursor: default; opacity: 0.75; }

.btn--sm { height: 30px; padding: 0 var(--s3); font-size: var(--t-sm); }
.btn--md { height: 38px; padding: 0 var(--s4); font-size: var(--t-sm); }
.btn--lg { height: 48px; padding: 0 var(--s5); font-size: var(--t-md); }
.btn--block { width: 100%; }

.btn--primary {
  background: var(--accent);
  color: #08101f;
  box-shadow: 0 10px 24px -12px var(--accent), var(--shadow-1);
}

.btn--primary:hover:not(:disabled) {
  background: var(--accent-hover);
  box-shadow: 0 14px 30px -12px var(--accent-hover);
}

/* The card's own colour, set by whichever card is on top (see TaskCard). */
.btn--kind {
  background: var(--kind);
  color: #0d0f16;
  box-shadow: 0 10px 26px -14px var(--kind), var(--shadow-1);
}

.btn--kind:hover:not(:disabled) { filter: brightness(1.07); box-shadow: 0 16px 34px -14px var(--kind); }

.btn--ghost {
  border-color: var(--border-strong);
  background: rgba(255, 255, 255, 0.02);
  color: var(--text-dim);
}

.btn--ghost:hover:not(:disabled) {
  border-color: var(--text-muted);
  background: rgba(255, 255, 255, 0.05);
  color: var(--text);
}

.btn--quiet { color: var(--text-muted); }
.btn--quiet:hover:not(:disabled) { background: rgba(255, 255, 255, 0.05); color: var(--text); }

.btn--busy .btn__label { opacity: 0.8; }
.btn__after { opacity: 0.7; transition: transform var(--base) var(--ease-out); }
.btn:hover .btn__after { transform: translateX(2px); }
</style>
