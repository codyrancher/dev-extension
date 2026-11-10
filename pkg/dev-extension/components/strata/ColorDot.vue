<script setup lang="ts">
withDefaults(defineProps<{ color: string; size?: 'sm' | 'md' | 'lg' }>(), { size: 'md' });
</script>

<template>
  <span
    class="strata-dot"
    :class="`strata-dot--${ size }`"
    :style="{ background: color }"
  />
</template>

<style lang="scss" scoped>
.strata-dot {
  display:       inline-block;
  flex-shrink:   0;
  border-radius: 50%;

  &--sm { width: 7px; height: 7px; }
  &--md { width: 10px; height: 10px; }
  &--lg { width: 14px; height: 14px; }
}
</style>
