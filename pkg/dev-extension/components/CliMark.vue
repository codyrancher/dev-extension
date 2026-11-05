<script>
/**
 * One provider's mark, inline.
 *
 * A `<svg>` rather than a font glyph because these are logos: Rancher's icon font has a generic
 * "ai" and a generic "gemini", and a tab strip holding conversations with two different
 * providers is exactly where the real marks earn their place. The path comes from the caller
 * (agent-clis.mjs owns which mark belongs to which CLI), so nothing here knows about any CLI.
 *
 * `currentColor` and no colour of its own: a mark sits in a row that already has a colour and a
 * dimming rule, and a logo that ignores both is a logo that fights the row it is in.
 */
export default {
  name: 'CliMark',

  props: {
    /** `{ label, path }`, as agent-clis.mjs holds them. Nothing is drawn without one. */
    mark: {
      type:    Object,
      default: null,
    },
    size: {
      type:    Number,
      default: 12,
    },
    /**
     * What the agent behind it is doing, when the mark is also standing for that (a conversation
     * tab colours it by state). Added to the tooltip and the accessible name, because the SVG's
     * own `<title>` is what a hover shows - a `title` attribute on it is never seen.
     */
    status: {
      type:    String,
      default: '',
    },
  },

  computed: {
    /*
     * Not `name`, which it was for one release: the shell's Vue resolved `name` in the template to
     * something of its own, and the tooltip read "Claude · [object Object]".
     */
    tip() {
      return this.status ? `${ this.mark.label } · ${ this.status }` : this.mark.label;
    },
  },
};
</script>

<template>
  <svg
    v-if="mark && mark.path"
    class="cli-mark"
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    role="img"
    :aria-label="tip"
    focusable="false"
  >
    <title>{{ tip }}</title>
    <path
      :d="mark.path"
      fill="currentColor"
    />
  </svg>
</template>

<style lang="scss" scoped>
.cli-mark {
  display:        inline-block;
  flex:           0 0 auto;
  /* Sits on the text's baseline rather than on the line box's bottom, which is what makes a
     12px mark beside 13px text look placed rather than dropped in. */
  vertical-align: -0.125em;
}
</style>
