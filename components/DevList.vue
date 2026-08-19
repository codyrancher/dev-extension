<script>
// One titled column of rows: a heading with a create control, rows with a state dot and a
// delete, and a line for when there are none.
//
// It exists because the product has two of these columns and they were two different pieces of
// markup. The sidebar's workspaces had a dot, a create and a two-step delete; the conversation
// list beside a workspace had a dot it computed itself, a create button in a different place and
// no delete at all, so a conversation could be opened and never closed. They are the same thing
// and they are now the same component.
//
// The metrics are Rancher's own, kept from the sidebar this was lifted out of: the shell's nav
// rows are 33px tall with a 16px left inset and 14px labels on a 16px line
// (components/nav/Group.vue), and $space-s is its small step. Nothing here is picked to match a
// screenshot.
//
// Not the shell's `nav/Type.vue` or `nav/Group.vue`, and both were tried. Type renders its own
// `<li>`, so a row that needs a dot before the link and a delete after it ends up with an `<li>`
// inside an `<li>`; Group renders its children through Type with no slot between them, so
// neither a dot nor a delete can reach a row at all.
import BrandImage from '@shell/components/BrandImage';
import { colorForState, stateDisplay } from '@shell/plugins/dashboard-store/resource-class';

export default {
  name: 'DevList',

  components: { BrandImage },

  emits: ['select', 'create', 'delete'],

  props: {
    /**
     * The heading. Uppercased by the stylesheet, so pass it in its ordinary case.
     *
     * Empty is allowed and means the column is named by whatever is above it: the heading row
     * stays, because the create control lives in it, and only the words go.
     */
    label: {
      type:    String,
      default: '',
    },

    /** The heading's glyph, from Rancher's icon font. */
    icon: {
      type:    String,
      default: '',
    },

    /**
     * A brand image for the heading instead of a glyph, by file name in the shell's assets.
     *
     * Which is the only way to use Rancher's own mark: it is an SVG rather than a character in
     * the icon font, so there is no class that draws it. BrandImage is what the shell's own
     * header uses, so a Rancher with custom branding gets its logo here too.
     */
    logo: {
      type:    String,
      default: '',
    },

    /**
     * The rows: `{ key, label, state, to }`.
     *
     * `state` is a Rancher state name, so the dot is the same colour it would be in a table.
     * `to` makes the row a link; a row without one is a button and selecting it is an event,
     * which is the difference between a workspace (a page) and a conversation (a pane).
     */
    rows: {
      type:    Array,
      default: () => [],
    },

    /** The key of the row that is selected. */
    current: {
      type:    [String, Number],
      default: '',
    },

    /** Where the heading's create control goes, when it is a link rather than an event. */
    createTo: {
      type:    Object,
      default: null,
    },

    /** What the create control says. No label, no control. */
    createLabel: {
      type:    String,
      default: '',
    },

    /** Whether rows can be deleted. The confirm step is this component's. */
    deletable: {
      type:    Boolean,
      default: false,
    },

    empty: {
      type:    String,
      default: 'None yet',
    },

    /**
     * A word about the heading's state, which colours it. '' is the ordinary case.
     *
     * The sidebar uses it to say that a cluster is running out of room, which is a thing worth
     * seeing without opening anything.
     */
    tone: {
      type:    String,
      default: '',
    },
  },

  data() {
    return {
      // The row a delete has been asked for, so the row can ask before it does it.
      confirming: '',
    };
  },

  methods: {
    /**
     * The dot's colour, from Rancher's own state colours, with one deliberate exception.
     *
     * `colorForState('stopped')` is error red, because in the rest of Rancher a stopped thing is
     * a thing that stopped. Here it is something someone pressed Stop on, which is the ordinary
     * way to leave one, and a red dot next to it says the same thing as the red dot next to a
     * crash loop. Muted is what the nav already uses for "nothing to report".
     */
    dotClass(row) {
      return row.state === 'stopped' ? 'text-muted' : colorForState(row.state);
    },

    stateLabel(row) {
      return stateDisplay(row.state);
    },

    remove(row) {
      this.confirming = '';
      this.$emit('delete', row.key);
    },
  },
};
</script>

<template>
  <section class="dev-list">
    <div class="dev-list__head">
      <BrandImage
        v-if="logo"
        class="dev-list__glyph dev-list__logo"
        :file-name="logo"
      />
      <i
        v-else
        class="dev-list__glyph icon"
        :class="icon"
      />
      <span
        class="dev-list__label"
        :class="tone ? `text-${ tone }` : ''"
      >{{ label }}</span>

      <!-- Whatever the heading has to say when the pointer is on it. See the sidebar's clusters. -->
      <div
        v-if="$slots.popover"
        class="dev-list__popover"
      >
        <slot name="popover" />
      </div>
      <!--
        Quiet until the pointer is in the section, or until it is focused, which is the same rule
        the row's delete follows. It keeps its place in the layout either way, so the label does
        not move when it appears, and it stays in the tab order, because hidden-until-hover is
        unusable from a keyboard if it is the only way to create something.
      -->
      <router-link
        v-if="createLabel && createTo"
        v-clean-tooltip="createLabel"
        class="dev-list__control dev-list__control--bordered dev-list__reveal"
        :aria-label="createLabel"
        :to="createTo"
      >
        <i class="icon icon-plus" />
      </router-link>
      <button
        v-else-if="createLabel"
        v-clean-tooltip="createLabel"
        type="button"
        class="dev-list__control dev-list__control--bordered dev-list__reveal"
        :aria-label="createLabel"
        @click="$emit('create')"
      >
        <i class="icon icon-plus" />
      </button>
    </div>

    <ul>
      <li
        v-for="row in rows"
        :key="row.key"
        :class="{ 'dev-list__row--current': row.key === current }"
        class="dev-list__row"
      >
        <!--
          The state class goes on the wrapper and the glyph reads it back through currentColor,
          which is what lets the stylesheet adjust it for the theme without knowing which state
          it is. See the __dot rule.
        -->
        <component
          :is="row.to ? 'router-link' : 'button'"
          class="dev-list__link"
          :to="row.to"
          :type="row.to ? null : 'button'"
          @click="row.to ? null : $emit('select', row.key)"
        >
          <span
            v-clean-tooltip="stateLabel(row)"
            class="dev-list__glyph dev-list__dot"
            :class="dotClass(row)"
          ><i class="icon icon-dot" /></span>
          <span class="dev-list__name">{{ row.label }}</span>
        </component>
        <template v-if="deletable">
          <button
            v-if="confirming !== row.key"
            v-clean-tooltip="`Delete ${ row.label }`"
            type="button"
            class="dev-list__control dev-list__reveal dev-list__delete"
            :aria-label="`Delete ${ row.label }`"
            @click="confirming = row.key"
          >
            <i class="icon icon-trash" />
          </button>
          <button
            v-else
            v-clean-tooltip="`Confirm deleting ${ row.label }`"
            type="button"
            class="dev-list__control dev-list__delete dev-list__delete--confirm"
            :aria-label="`Confirm deleting ${ row.label }`"
            @click="remove(row)"
          >
            <i class="icon icon-checkmark" />
          </button>
        </template>
      </li>

      <li
        v-if="!rows.length"
        class="dev-list__empty"
      >
        {{ empty }}
      </li>
    </ul>
  </section>
</template>

<style lang="scss" scoped>
  $row-height: 33px;
  $rail: 16px;      // the left inset, and the width of the icon slot
  // The scale, not a number of this file's own. See design/tokens.css.
  $gap: var(--dev-space-3);
  $control: 22px;   // the right-hand control, the same box in both kinds of row

  .dev-list {
    // The rule between two stacked lists, and only between them. It used to be a border on every
    // heading, which is the same thing as long as a list is one of several in a column: on its
    // own, under something that already draws a line (a tab strip, a page header), it is a second
    // line a pixel below the first.
    & + & {
      border-top: 1px solid var(--nav-border, var(--border));
    }

    ul {
      margin:     0;
      padding:    0;
      list-style: none;
    }

    // The two kinds of row are the same box: same height, same insets, same three columns.
    // A div rather than a <header> element, because the shell styles bare HEADERs globally and
    // one of those rules is a 48px height.
    &__head,
    &__row {
      display:       flex;
      align-items:   center;
      box-sizing:    border-box;
      width:         100%;
      height:        $row-height;
      margin:        0;
      padding:       0 $gap 0 $rail;
    }

    &__head {
      // The mark, boxed to the same rail everything else in the column lines up on.
      .dev-list__logo {
        height:     14px;
        object-fit: contain;
      }

      .dev-list__glyph {
        color:     var(--primary);
        font-size: 14px;
      }
    }

    // The left rail: the section's icon and a row's state dot are the same box, so they share
    // one vertical line, and the labels after them share another.
    &__glyph {
      flex:         0 0 $rail;
      width:        $rail;
      margin-right: $gap;
      text-align:   left;
    }

    &__label {
      flex:            1 1 auto;
      min-width:       0;
      overflow:        hidden;
      color:           var(--muted);
      font-size:       12px;
      font-weight:     600;
      letter-spacing:  0.05em;
      text-transform:  uppercase;
      text-overflow:   ellipsis;
      white-space:     nowrap;
      // A section heading is not a link and must not pick one's underline up from anywhere.
      text-decoration: none;
    }

    // One colour for every name, whatever state it is in: a stopped workspace is still one whose
    // name you are trying to read. State is the dot's job and only the dot's.
    //
    // The reset is here rather than only on the link, because a row without a route is a BUTTON
    // and the shell gives every one of those a border, a background and a 40px minimum height.
    &__link {
      display:         flex;
      align-items:     center;
      flex:            1 1 auto;
      min-width:       0;
      height:          100%;
      min-height:      0;
      margin:          0;
      padding:         0;
      border:          none;
      background:      transparent;
      color:           var(--body-text);
      font-family:     inherit;
      font-size:       14px;
      line-height:     16px;
      text-align:      left;
      text-decoration: none;
      appearance:      none;
      cursor:          pointer;

      &:hover,
      &:focus {
        text-decoration: none;
      }
    }

    &__row {
      .icon-dot {
        font-size:   8px;
        line-height: 1;
      }

      &:hover {
        background: var(--nav-hover, var(--accent-btn));
      }

      // Selected is a background and a weight, not a colour. Rancher's own nav pairs
      // --active-nav with --on-active, but only the second is defined in every theme here, and
      // taking one without the other is how a selected row ends up white on white.
      &--current {
        background: var(--nav-hover, var(--accent-btn));

        .dev-list__link {
          font-weight: 600;
        }
      }
    }

    // The state dot, pulled toward the body text until it is legible on the body background.
    //
    // Rancher's state colours are not theme-aware: --success is rgb(0, 112, 50) in both themes,
    // and only the background moves, so on the dark nav it measures 2.36:1 where a graphical
    // object needs 3:1. --error and --primary have the same problem. There is no token to switch
    // to either: the click-badge family is white for error and info in both themes, and the gauge
    // colours are a different vocabulary.
    //
    // So the state colour is kept and mixed toward --body-text, which is the one colour each
    // theme guarantees against its own background. In dark that lightens it, in light it deepens
    // it, and the direction is right in both without this file knowing which theme it is in or
    // inventing a colour of its own. A browser without color-mix ignores the declaration and gets
    // the state colour unchanged, which is where this started.
    // currentColor in a `color` declaration is the inherited value, so this is the state colour
    // the span carries (text-success and the rest) mixed toward the theme's body text, rather
    // than a second copy of Rancher's palette written out here.
    &__dot .icon-dot {
      color: color-mix(in srgb, currentColor, var(--body-text) 45%);
    }

    // The name, truncated rather than wrapped: a row is one line and a workspace name can be
    // forty characters. It shrinks before the control does, so a long name never runs under it.
    &__name {
      overflow:      hidden;
      text-overflow: ellipsis;
      white-space:   nowrap;
    }

    // The right-hand control of either row: one box, one column, one place.
    //
    // `min-height` as well as `height`, because one of the shell's global BUTTON rules sets a
    // 40px minimum and a minimum beats a height. Without it the row's delete is a 22x40 box
    // against the section's 22x22 plus, and the two rails stop lining up.
    &__control {
      display:         flex;
      align-items:     center;
      justify-content: center;
      flex:            0 0 $control;
      width:           $control;
      height:          $control;
      min-height:      $control;
      padding:         0;
      border:          none;
      border-radius:   var(--border-radius);
      background:      transparent;
      color:           var(--muted);
      cursor:          pointer;

      .icon {
        font-size: 12px;
      }
    }

    // The create control, outlined so it reads as a button rather than as another row icon.
    //
    // Both colours here are foreground tokens rather than --primary and --border, and that is
    // the point: --primary on the nav background is 2.93:1 in dark, and --border is about 1.4:1
    // in both themes, which is a control nobody can see with a glyph nobody can read. --muted
    // and --body-text are the two colours this nav already uses for text, so they are legible on
    // it by construction.
    &__control--bordered {
      border: 1px solid var(--muted);
      color:  var(--body-text);

      &:hover {
        background: var(--nav-hover, var(--accent-btn));
      }
    }

    // Quiet until you are on the thing it acts on, and always there for a keyboard. Opacity
    // rather than display, so the row's layout is the same whether it is showing or not.
    &__reveal {
      opacity: 0;

      &:focus-visible {
        opacity: 1;
      }
    }

    // The heading for the create control, the row for that row's delete: each control appears
    // when the pointer is on the thing it acts on.
    //
    // Hovering the whole list is what this used to be, and it read differently in the two places
    // this component is used. In the sidebar a list is as tall as its rows, so "the list" and
    // "near the heading" are the same place; in the conversations column it fills a 210px column,
    // so the create control was showing whenever the pointer was anywhere in that column, which
    // is to say always.
    &__head:hover &__reveal,
    &__row:hover &__reveal {
      opacity: 1;
    }

    &__delete {
      &:hover,
      &:focus-visible {
        opacity: 1;
        color:   var(--error);
      }

      &--confirm {
        opacity: 1;
        color:   var(--error);
      }
    }

    // A panel under the heading, shown while the pointer is on it. Absolute, so it does not
    // move the rows underneath, and above them, so it is not clipped by the next section.
    &__popover {
      position:      absolute;
      top:           100%;
      left:          0;
      z-index:       10;
      display:       none;
      // As wide as it needs and no wider than the column: absolutely positioned or not, a panel
      // wider than its scroll container gives that container a horizontal scrollbar, which in a
      // sidebar is a bar under the workspaces that scrolls nothing anybody wants.
      width:         max-content;
      max-width:     100%;
      padding:       var(--dev-space-3) var(--dev-space-4);
      border:        1px solid var(--border);
      border-radius: var(--border-radius);
      background:    var(--body-bg);
      box-shadow:    0 2px 8px rgba(0, 0, 0, 0.2);
    }

    &__head {
      position: relative;

      &:hover .dev-list__popover {
        display: block;
      }
    }

    &__empty {
      padding:   0 $gap ($gap / 2) calc(#{$rail} + #{$rail} + #{$gap});
      color:     var(--muted);
      font-size: 12px;
    }
  }
</style>
