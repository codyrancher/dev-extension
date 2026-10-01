<script>
// One row of the nav: a status dot, a name with a line under it, and whatever goes on the end.
//
// Two lists in this product draw rows of this shape - the workspaces and the Ranchers - and
// they were two different shapes: different heights, different insets, the dot in a slot of one
// width here and no slot at all there. A row that is two pixels shorter than the row above it
// is a difference nobody can name and everybody sees, so the shape is one component and the
// numbers it uses are tokens (--dev-row, --dev-row-tall, --dev-row-glyph) rather than this
// file's own opinion.
//
// `tall` is about the second line rather than about the content: a row that will have a detail
// line keeps the height for it from the moment it appears, so the name does not jump down when
// the status finally loads.
export default {
  name: 'NavRow',

  props: {
    /** What the row is: a div, or a link/button when the whole row is pressable. */
    tag: {
      type:    String,
      default: 'div',
    },
    /** Passed through when `tag` is a router-link. */
    to: {
      type:    [String, Object],
      default: null,
    },
    /** Keep the height for a second line, whether or not there is one yet. */
    tall: {
      type:    Boolean,
      default: false,
    },
    /** Drawn as the current row. */
    current: {
      type:    Boolean,
      default: false,
    },
  },
};
</script>

<template>
  <component
    :is="tag"
    class="dev-nav-row"
    :class="{ 'dev-nav-row--tall': tall, 'dev-nav-row--current': current, 'dev-nav-row--pressable': tag !== 'div' }"
    :to="to"
    :type="tag === 'button' ? 'button' : null"
  >
    <span class="dev-nav-row__glyph"><slot name="glyph" /></span>
    <span class="dev-nav-row__text">
      <span class="dev-nav-row__name"><slot name="name" /></span>
      <span
        v-if="tall || $slots.detail"
        class="dev-nav-row__detail"
      ><slot name="detail" /></span>
    </span>
    <span
      v-if="$slots.trail"
      class="dev-nav-row__trail"
    ><slot name="trail" /></span>
  </component>
</template>

<style lang="scss" scoped>
  .dev-nav-row {
    display:         flex;
    align-items:     center;
    box-sizing:      border-box;
    width:           100%;
    min-height:      var(--dev-row);
    margin:          0;
    padding:         0 var(--dev-space-3) 0 var(--dev-inset);
    border:          none;
    background:      transparent;
    color:           var(--body-text);
    font-family:     inherit;
    font-size:       14px;
    line-height:     16px;
    text-align:      left;
    text-decoration: none;

    &--tall { min-height: var(--dev-row-tall); }

    &--pressable {
      appearance: none;
      cursor:     pointer;

      &:hover,
      &:focus { text-decoration: none; }
    }

    &--current { font-weight: 600; }

    // The dot's slot, the same width as the inset so the names line up with everything else
    // drawn to this column.
    &__glyph {
      flex:         0 0 var(--dev-row-glyph);
      width:        var(--dev-row-glyph);
      margin-right: var(--dev-space-3);
      text-align:   left;

      .icon-dot { font-size: 8px; line-height: 1; }
    }

    &__text {
      display:        flex;
      flex-direction: column;
      flex:           1 1 auto;
      min-width:      0;
      line-height:    1.25;
    }

    &__name {
      overflow:      hidden;
      text-overflow: ellipsis;
      white-space:   nowrap;
    }

    &__detail {
      display:       flex;
      align-items:   center;
      gap:           5px;
      min-height:    13px;
      overflow:      hidden;
      text-overflow: ellipsis;
      white-space:   nowrap;
      color:         var(--muted);
      font-size:     11px;
      line-height:   1;
    }

    &__trail {
      display:     flex;
      align-items: center;
      flex:        0 0 auto;
      gap:         2px;
    }
  }
</style>
