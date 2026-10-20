<script>
/**
 * One bordered block in a page's body.
 *
 * Tools and Artifacts both drew this - a bordered, rounded box with the same padding and
 * background - and both spelled it slightly differently. It is the second thing a new page
 * reaches for after the frame, so it is here rather than in each of them.
 */
export default {
  name: 'DevCard',

  props: {
    /** Drawn quieter, for a block that is context rather than a thing to act on. */
    subdued: {
      type:    Boolean,
      default: false,
    },
  },
};
</script>

<template>
  <section
    class="dev-card"
    :class="{ 'dev-card--subdued': subdued }"
  >
    <header
      v-if="$slots.head"
      class="dev-card__head"
    >
      <slot name="head" />
    </header>
    <slot />
  </section>
</template>

<style lang="scss" scoped>
.dev-card {
  margin:        0 0 var(--dev-space-4);
  padding:       var(--dev-space-3);
  border:        1px solid var(--border);
  border-radius: var(--r-sm);
  background:    var(--box-bg);
}

.dev-card--subdued {
  background: transparent;
}

.dev-card__head {
  display:     flex;
  align-items: center;
  gap:         var(--dev-space-2);
  flex-wrap:   wrap;
}
</style>
