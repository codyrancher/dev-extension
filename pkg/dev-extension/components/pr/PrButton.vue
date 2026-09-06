<script>
// The review panel's button: the harness's AppButton, in Rancher's colours.
//
// The panel is a port of the harness's, and the harness had one button with a `variant` for
// what it means and a `size` for the row it sits in. Kept as one component here for the same
// reason it was one there: the panel has forty of these and a control that is styled forty
// times is styled forty ways. Rancher's own RcButton has three variants and two sizes, neither
// set of which is this one, and a diff's inline controls want the 22px row the shell's buttons
// do not have.
export default {
  name: 'PrButton',

  props: {
    /** What the button means: default, primary, danger, ghost, accent, success. */
    variant: {
      type:    String,
      default: 'default',
    },
    /** The row it sits in: mini, sm, md. */
    size: {
      type:    String,
      default: 'md',
    },
    disabled: {
      type:    Boolean,
      default: false,
    },
    title: {
      type:    String,
      default: '',
    },
    type: {
      type:    String,
      default: 'button',
    },
  },
};
</script>

<template>
  <button
    :type="type"
    :class="['prb', `prb--${ variant }`, `prb--${ size }`]"
    :disabled="disabled"
    :title="title || undefined"
  >
    <slot />
  </button>
</template>

<style lang="scss" scoped>
  .prb {
    display:         inline-flex;
    align-items:     center;
    justify-content: center;
    gap:             var(--dev-space-2);
    border:          1px solid transparent;
    border-radius:   var(--border-radius);
    background:      var(--pr-el);
    color:           var(--pr-text);
    font-family:     inherit;
    font-weight:     500;
    line-height:     1;
    cursor:          pointer;
    white-space:     nowrap;
    transition:      background 0.15s, color 0.15s;

    &:hover:not(:disabled) { background: var(--pr-el-hover); }
    &:disabled { opacity: 0.5; cursor: default; }

    &--mini {
      height:        22px;
      padding:       0 var(--dev-space-3);
      font-size:     12px;
      font-weight:   400;
      color:         var(--pr-muted);
    }

    &--sm {
      height:    28px;
      padding:   0 var(--dev-space-4);
      font-size: 12px;
    }

    &--md {
      height:    32px;
      padding:   0 var(--dev-space-5);
      font-size: 13px;
    }

    &--primary { background: var(--pr-accent); color: var(--pr-on-accent); }
    &--primary:hover:not(:disabled) { filter: brightness(1.08); }

    &--accent { background: var(--pr-accent-fill); color: var(--pr-text); border-color: var(--pr-accent); }
    &--accent:hover:not(:disabled) { background: var(--pr-accent); color: var(--pr-on-accent); }

    &--success { background: var(--pr-success-fill); color: var(--pr-success); }
    &--success:hover:not(:disabled) { filter: brightness(1.15); }

    &--danger { background: var(--pr-error); color: var(--pr-on-accent); }
    &--danger:hover:not(:disabled) { filter: brightness(1.15); }

    &--ghost { background: transparent; color: var(--pr-muted); }
    &--ghost:hover:not(:disabled) { background: var(--pr-el); color: var(--pr-text); }

    &--mini.prb--danger { background: var(--pr-el); color: var(--pr-error); }
    &--mini.prb--danger:hover:not(:disabled) { background: var(--pr-error-fill); }
    &--mini.prb--accent { background: var(--pr-el); color: var(--pr-accent); border-color: transparent; }
    &--mini.prb--accent:hover:not(:disabled) { background: var(--pr-accent-fill); color: var(--pr-text); }
    &--mini.prb--primary { background: var(--pr-accent-fill); color: var(--pr-text); }
    &--mini.prb--success { background: var(--pr-el); color: var(--pr-success); }
  }
</style>
