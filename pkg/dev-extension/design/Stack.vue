<script>
// Things in a column, one gap apart.
//
// The point is not that `display: flex; flex-direction: column` is hard to write. It is that
// writing it in thirty components means choosing the gap thirty times, and the gap is the thing
// that was never the same twice. Here it is a token name, so the only gaps that exist are the
// ones on the scale.
//
// `grow` is the other half of the same problem: a flex child's default is to shrink, which is
// what squeezed a fixed-height row down to its content twice in this codebase before anyone
// noticed. A Stack says which of its children takes the leftover room, and the rest keep the
// size they asked for.
import { SPACE, spaceVar } from './tokens';

export default {
  name: 'Stack',

  props: {
    /** A step on the space scale: 1 (hairline) to 6 (between blocks). */
    gap: {
      type:      [String, Number],
      default:   4,
      validator: (value) => SPACE.includes(Number(value)),
    },

    /** Fill the parent rather than being as tall as the contents. */
    fill: {
      type:    Boolean,
      default: false,
    },

    align: {
      type:      String,
      default:   'stretch',
      validator: (value) => ['stretch', 'start', 'center', 'end'].includes(value),
    },
  },

  computed: {
    style() {
      return { gap: spaceVar(this.gap), alignItems: this.align };
    },
  },
};
</script>

<template>
  <div
    class="stack"
    :class="{ 'stack--fill': fill }"
    :style="style"
  >
    <slot />
  </div>
</template>

<style lang="scss" scoped>
.stack {
  display:        flex;
  flex-direction: column;
  // A flex container that is itself a flex child, which most of these are: without this its
  // children can push it past its parent instead of scrolling inside it.
  min-height:     0;

  &--fill {
    flex: 1 1 auto;
  }
}
</style>
