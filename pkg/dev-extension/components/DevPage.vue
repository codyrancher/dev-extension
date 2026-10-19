<script>
/**
 * The frame every page of this product sits in.
 *
 * The older pages each wrote this out: a root with `padding: var(--dev-inset)` and
 * `overflow-y: auto`, then a `header` holding an `h1` and a `.subheader`. Three new pages -
 * Tools, Artifacts, Issue tracker - wrote their own instead, and got it wrong in the one way
 * that is immediately visible: their content sat flush against the left edge while every older
 * page was inset.
 *
 * So the frame is a component rather than a convention. A convention is a thing each new page
 * has to be told; this is a thing a new page gets by using it.
 *
 * The inset is `--dev-inset`, which the mobile stylesheet narrows (design/mobile.css), so a page
 * built on this is responsive without knowing that.
 */
export default {
  name: 'DevPage',

  props: {
    /** The h1. */
    title: {
      type:     String,
      required: true,
    },
    /** The line under it, in the muted colour every other page uses for this. */
    lede: {
      type:    String,
      default: '',
    },
    /**
     * Whether the page scrolls itself.
     *
     * On for a page that is a list, which is most of them. Off for one that manages its own
     * scrolling regions - the deck does, and a second scroller around it is the trap that
     * `.detail__scroll` already documents.
     */
    scroll: {
      type:    Boolean,
      default: true,
    },
  },
};
</script>

<template>
  <div
    class="dev-page"
    :class="{ 'dev-page--scroll': scroll }"
  >
    <header class="dev-page__head">
      <h1>{{ title }}</h1>
      <p
        v-if="lede || $slots.lede"
        class="subheader dev-page__lede"
      >
        <slot name="lede">{{ lede }}</slot>
      </p>
      <!-- Anything that belongs on the title row: a Refresh, a filter, a count. -->
      <div
        v-if="$slots.actions"
        class="dev-page__actions"
      >
        <slot name="actions" />
      </div>
    </header>

    <slot />
  </div>
</template>

<style lang="scss" scoped>
.dev-page {
  padding: var(--dev-inset);
}

.dev-page--scroll {
  overflow-y: auto;
}

/*
 * The title row, matching what the older pages write by hand: the lede takes the slack so
 * anything in `actions` sits at the right-hand end.
 */
.dev-page__head {
  display:       flex;
  align-items:   center;
  gap:           var(--dev-space-4);
  margin-bottom: var(--dev-space-5);
  flex-wrap:     wrap;

  h1 {
    margin-bottom: 0;
  }
}

.dev-page__lede {
  flex:   1 1 auto;
  margin: 0;
  color:  var(--muted);
}

.dev-page__actions {
  display:     flex;
  align-items: center;
  gap:         var(--dev-space-2);
  margin-left: auto;
}
</style>
