<script setup lang="ts">
/**
 * A label, as a chip: on a note, in search, in the pinned bar, in the filters.
 *
 * Tinted with the label's own colour, mixed toward the page's text so a yellow label still reads
 * on Rancher's white. On a touch screen the × is a long press with a confirmation, as in Strata,
 * because a small × beside a tappable chip is a mis-tap waiting to happen.
 */
import { computed, ref } from 'vue';
import { LONG_PRESS_MS } from '../../strata/colors';
import DevDialog from '../DevDialog.vue';

defineOptions({ inheritAttrs: false });

const props = defineProps<{
  name: string;
  color?: string;
  removable?: boolean;
  variant?: 'default' | 'include' | 'exclude' | 'unlabeled';
}>();

const emit = defineEmits<{ (e: 'click'): void; (e: 'remove'): void }>();

const touch = typeof window !== 'undefined' && 'ontouchstart' in window;
const showConfirm = ref(false);
let longPressTimer: ReturnType<typeof setTimeout> | null = null;

const tint = computed(() => (!props.variant || props.variant === 'default') && props.color ? { '--chip': props.color } : undefined);

function onTouchStart() {
  if (!props.removable) {
    return;
  }
  longPressTimer = setTimeout(() => {
    window.getSelection()?.removeAllRanges();
    showConfirm.value = true;
    longPressTimer = null;
  }, LONG_PRESS_MS);
}

function onTouchEnd() {
  if (longPressTimer) {
    clearTimeout(longPressTimer);
    longPressTimer = null;
  }
}

function confirmRemove() {
  showConfirm.value = false;
  emit('remove');
}
</script>

<template>
  <span
    class="strata-chip"
    :class="`strata-chip--${ variant || 'default' }`"
    :style="tint"
    role="button"
    tabindex="0"
    data-testid="strata-chip"
    v-bind="$attrs"
    @click.stop="emit('click')"
    @keydown.enter.prevent="emit('click')"
    @touchstart.passive="onTouchStart"
    @touchend="onTouchEnd"
    @touchmove="onTouchEnd"
    @contextmenu.prevent
  >
    <svg
      class="strata-chip__icon"
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2.5"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z" /><circle
        cx="7"
        cy="7"
        r="1"
      />
    </svg>
    <template v-if="variant === 'include'">+</template>
    <template v-if="variant === 'exclude'">&minus;</template>
    <span class="strata-chip__name">{{ name }}</span>
    <button
      v-if="removable && !touch"
      type="button"
      class="strata-chip__remove"
      :aria-label="`Remove ${ name }`"
      data-testid="strata-chip-remove"
      @click.stop="emit('remove')"
    >
      &times;
    </button>
    <slot name="after" />
  </span>
  <DevDialog
    v-if="showConfirm"
    :title="`Remove ${ name }?`"
    confirm-label="Remove"
    danger
    @confirm="confirmRemove"
    @cancel="showConfirm = false"
  />
</template>

<style lang="scss" scoped>
.strata-chip {
  --chip: var(--dev-accent);

  display:       inline-flex;
  align-items:   center;
  gap:           4px;
  max-width:     100%;
  height:        28px;
  padding:       0 10px;
  border-radius: var(--r-sm);
  border:        1px solid color-mix(in srgb, var(--chip) 38%, transparent);
  background:    color-mix(in srgb, var(--chip) 14%, transparent);
  color:         color-mix(in srgb, var(--chip) 70%, var(--body-text));
  font-size:     12px;
  font-weight:   500;
  line-height:   1;
  white-space:   nowrap;
  cursor:        pointer;
  user-select:   none;
  transition:    background 0.15s ease, box-shadow 0.15s ease;

  &:hover { background: color-mix(in srgb, var(--chip) 24%, transparent); }
  &:focus-visible { outline: 2px solid var(--dev-accent); outline-offset: 1px; }

  &--include { --chip: var(--success); }
  &--exclude { --chip: var(--error); }

  &--unlabeled {
    border-color: var(--border);
    background:   var(--box-bg);
    color:        var(--muted);
  }

  &__icon { flex-shrink: 0; opacity: 0.65; }
  &__name { overflow: hidden; text-overflow: ellipsis; }

  &__remove {
    min-height:  0;
    height:      auto;
    margin:      0 -4px 0 0;
    padding:     2px 4px;
    border:      0;
    background:  none;
    color:       inherit;
    font-size:   16px;
    line-height: 1;
    opacity:     0.6;
    cursor:      pointer;

    &:hover { opacity: 1; }
  }
}
</style>
