<script>
// The heading on a section of the nav: a glyph, the section's name, and the control that makes
// another one of whatever is in it.
//
// There were two of these - the workspace list drew its own, the Ranchers section drew another -
// and they disagreed about the things you notice side by side: the glyph's colour, whether the
// `+` had a border, and whether it was there at all before you moved the pointer over it. This
// is the Ranchers one, which is the one that reads better: the `+` is always visible, bordered,
// and in the same place in every section, so making a thing is never a matter of finding where
// the control hides.
//
// The rule above a section is not this component's: it depends on what the section sits under,
// not on what it is, so a section that needs one draws it itself.
import BrandImage from '@shell/components/BrandImage';

export default {
  name: 'NavHead',

  components: { BrandImage },

  props: {
    /** The section's name. Empty draws the row with only its glyph and its control. */
    label: {
      type:    String,
      default: '',
    },
    /** The glyph, from Rancher's icon font. */
    icon: {
      type:    String,
      default: '',
    },
    /** A brand image instead of a glyph, by file name. */
    logo: {
      type:    String,
      default: '',
    },
    /** A Rancher text tone for the label, for a section that is saying something. */
    tone: {
      type:    String,
      default: '',
    },
    /** What the create control says. No label, no control. */
    createLabel: {
      type:    String,
      default: '',
    },
    /** Where create goes, when it is somewhere rather than something. */
    createTo: {
      type:    [String, Object],
      default: null,
    },
  },

  emits: ['create'],
};
</script>

<template>
  <div class="dev-nav-head">
    <BrandImage
      v-if="logo"
      class="dev-nav-head__glyph dev-nav-head__logo"
      :file-name="logo"
    />
    <i
      v-else-if="icon"
      class="dev-nav-head__glyph icon"
      :class="icon"
    />
    <span
      class="dev-nav-head__label"
      :class="tone ? `text-${ tone }` : ''"
    >{{ label }}</span>
    <!-- Anything the section wants between its name and its create control. -->
    <slot />
    <component
      :is="createTo ? 'router-link' : 'button'"
      v-if="createLabel"
      class="dev-nav-head__add"
      :to="createTo"
      :type="createTo ? null : 'button'"
      :title="createLabel"
      :aria-label="createLabel"
      @click="createTo ? null : $emit('create')"
    >+</component>
  </div>
</template>

<style lang="scss" scoped>
  .dev-nav-head {
    display:     flex;
    align-items: center;
    // The same row box as everything else in the column. See NavRow and design/tokens.css.
    height:      var(--dev-row);
    padding:     0 var(--dev-space-3) 0 var(--dev-inset);

    // The glyph's slot is the inset wide, so every name in the column starts at the same x.
    &__glyph {
      flex:         0 0 var(--dev-inset);
      width:        var(--dev-inset);
      margin-right: var(--dev-space-3);
      color:        var(--dev-accent);
      font-size:    14px;
    }

    &__logo {
      height:     14px;
      object-fit: contain;
    }

    &__label {
      flex:            1 1 auto;
      min-width:       0;
      overflow:        hidden;
      color:           var(--body-text);
      font-size:       12px;
      font-weight:     600;
      letter-spacing:  0.05em;
      text-transform:  uppercase;
      text-overflow:   ellipsis;
      white-space:     nowrap;
      text-decoration: none;
    }

    // Always there, rather than appearing when the pointer is in the section: a control you
    // have to hover to find is one you have to know about already. A square with a border,
    // because it is a thing to press and the heading beside it is not.
    &__add {
      flex:            0 0 auto;
      margin-left:     var(--dev-space-3);
      display:         inline-flex;
      align-items:     center;
      justify-content: center;
      width:           20px;
      height:          20px;
      min-height:      0;
      padding:         0;
      border:          1px solid var(--border);
      border-radius:   4px;
      background:      transparent;
      color:           var(--muted);
      font-size:       15px;
      font-weight:     400;
      line-height:     1;
      text-decoration: none;
      cursor:          pointer;

      &:hover {
        color:           var(--dev-accent);
        border-color:    var(--dev-accent);
        text-decoration: none;
      }
    }
  }
</style>
