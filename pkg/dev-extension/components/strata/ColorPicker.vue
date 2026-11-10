<script setup lang="ts">
import { LABEL_COLORS } from '../../strata/colors';

defineProps<{ modelValue: string }>();
const emit = defineEmits<{ (e: 'update:modelValue', color: string): void }>();
</script>

<template>
  <div
    class="strata-palette"
    role="radiogroup"
    aria-label="Colour"
  >
    <button
      v-for="c in LABEL_COLORS"
      :key="c"
      type="button"
      role="radio"
      class="strata-palette__swatch"
      :class="{ 'strata-palette__swatch--on': modelValue === c }"
      :aria-checked="modelValue === c"
      :aria-label="c"
      :data-testid="`strata-swatch-${ c.slice(1) }`"
      :style="{ background: c }"
      @click="emit('update:modelValue', c)"
    />
  </div>
</template>

<style lang="scss" scoped>
.strata-palette {
  display:   flex;
  flex-wrap: wrap;
  gap:       var(--dev-space-3);

  &__swatch {
    width:         24px;
    height:        24px;
    min-height:    0;
    padding:       0;
    border:        2px solid transparent;
    border-radius: 50%;
    line-height:   1;
    cursor:        pointer;
    transition:    transform 0.15s ease;

    &:hover { transform: scale(1.15); }

    &--on {
      border-color: var(--body-bg);
      box-shadow:   0 0 0 2px var(--dev-accent);
    }
  }
}
</style>
