<script>
// A bordered box with a fixed head and a body that scrolls.
//
// Four places in this product had grown their own version of this - the commits list, the file
// tree, the file view, the log window - and they disagreed about the padding, the header
// background and whether the header scrolled away with the content. The header not scrolling is
// the part worth having: the name of what you are looking at is least useful at the moment you
// have scrolled far enough to forget it.
import { SPACE, spaceVar } from './tokens';

export default {
  name: 'Panel',

  props: {
    /** Shown in the head. A panel with no title and no `head` slot has no head at all. */
    title: {
      type:    String,
      default: '',
    },

    /** Padding inside the body, as a step on the space scale. */
    pad: {
      type:      [String, Number],
      default:   4,
      validator: (value) => SPACE.includes(Number(value)),
    },

    /** Take the leftover height of the column this is in, and scroll inside it. */
    fill: {
      type:    Boolean,
      default: false,
    },
  },

  computed: {
    bodyStyle() {
      return { padding: spaceVar(this.pad) };
    },
  },
};
</script>

<template>
  <div
    class="panel"
    :class="{ 'panel--fill': fill }"
  >
    <div
      v-if="title || $slots.head"
      class="panel__head"
    >
      <slot name="head">
        {{ title }}
      </slot>
    </div>
    <div
      class="panel__body"
      :style="bodyStyle"
    >
      <slot />
    </div>
  </div>
</template>

<style lang="scss" scoped>
.panel {
  display:        flex;
  flex-direction: column;
  min-height:     0;
  border:         1px solid var(--border);
  border-radius:  var(--border-radius);
  background:     var(--body-bg);
  // So the head's own background does not square off the corners it sits in.
  overflow:       hidden;

  &--fill {
    flex: 1 1 auto;
  }

  &__head {
    flex:          0 0 auto;
    padding:       var(--dev-space-3) var(--dev-space-4);
    border-bottom: 1px solid var(--border);
    background:    var(--accent-btn);
    color:         var(--muted);
    font-size:     11px;
    overflow:      hidden;
    text-overflow: ellipsis;
    white-space:   nowrap;
  }

  &__body {
    flex:       1 1 auto;
    min-height: 0;
    overflow:   auto;
  }
}
</style>
