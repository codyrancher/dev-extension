<script>
// A status pill: a PR's state, a comment's status, a count. The harness's AppBadge.
export default {
  name: 'PrBadge',

  props: {
    /** neutral, success, warning, error, accent, open, merged, closed. */
    tone: {
      type:    String,
      default: 'neutral',
    },
    title: {
      type:    String,
      default: '',
    },
  },
};
</script>

<template>
  <span
    :class="['prbadge', `prbadge--${ tone }`]"
    :title="title || undefined"
  ><slot /></span>
</template>

<style lang="scss" scoped>
  .prbadge {
    display:        inline-flex;
    align-items:    center;
    gap:            var(--dev-space-1);
    padding:        var(--dev-space-1) var(--dev-space-3);
    border-radius:  12px;
    background:     var(--pr-el);
    color:          var(--pr-muted);
    font-size:      10px;
    font-weight:    600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    white-space:    nowrap;

    &--success, &--open { background: var(--pr-success); color: var(--pr-on-accent); }
    &--warning { background: var(--pr-warning); color: var(--pr-on-accent); }
    &--error, &--closed { background: var(--pr-error); color: var(--pr-on-accent); }
    &--accent, &--merged { background: var(--pr-accent); color: var(--pr-on-accent); }
  }
</style>
