<script>
// Things in a line, one gap apart.
//
// The horizontal half of Stack, and it exists for the same reason: a row of controls is the
// most common thing in this product and every one of them was choosing its own gap, its own
// alignment and its own answer to "which of these takes the leftover width".
//
// `spread` is worth naming rather than leaving to `justify-content`, because what people
// actually want is almost always one of three things: everything at the start, everything at
// the start with one thing pushed to the end, or the two ends apart. `justify` covers the
// first and third; the second is what `<Spacer />` inside a Row is for.
import { SPACE, spaceVar } from './tokens';

export default {
  name: 'Row',

  props: {
    /** A step on the space scale: 1 (hairline) to 6 (between blocks). */
    gap: {
      type:      [String, Number],
      default:   4,
      validator: (value) => SPACE.includes(Number(value)),
    },

    align: {
      type:      String,
      default:   'center',
      validator: (value) => ['stretch', 'start', 'center', 'end', 'baseline'].includes(value),
    },

    justify: {
      type:      String,
      default:   'start',
      validator: (value) => ['start', 'center', 'end', 'between'].includes(value),
    },

    /** Let the line wrap. Off by default: a toolbar that wraps is usually a toolbar too small. */
    wrap: {
      type:    Boolean,
      default: false,
    },

    /** Fill the parent's remaining space rather than being as wide as the contents. */
    fill: {
      type:    Boolean,
      default: false,
    },
  },

  computed: {
    style() {
      const justify = {
        start: 'flex-start', center: 'center', end: 'flex-end', between: 'space-between'
      }[this.justify];
      const align = {
        stretch: 'stretch', start: 'flex-start', center: 'center', end: 'flex-end', baseline: 'baseline'
      }[this.align];

      return {
        gap:            spaceVar(this.gap),
        justifyContent: justify,
        alignItems:     align,
        flexWrap:       this.wrap ? 'wrap' : 'nowrap',
      };
    },
  },
};
</script>

<template>
  <div
    class="row"
    :class="{ 'row--fill': fill }"
    :style="style"
  >
    <slot />
  </div>
</template>

<style lang="scss" scoped>
.row {
  display:   flex;
  // The horizontal twin of Stack's `min-height: 0`, and needed as often: without it a long
  // name or a wide table inside a Row makes the Row wider than its parent instead of
  // ellipsising or scrolling.
  min-width: 0;

  &--fill {
    flex: 1 1 auto;
  }
}
</style>
