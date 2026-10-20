<script>
/**
 * One press for the usual thing, a caret for the others.
 *
 * A conversation is held with a CLI, and the choice is made when it is created: the pane runs
 * that program for as long as it lives, so there is no changing it afterwards. A plain button
 * would have to mean one of them and send you to Settings for the rest; a menu would make
 * every new conversation a two-step decision when it is the same answer nearly every time.
 * So: the button is the default, and the caret beside it is where the rest live.
 *
 * `options` is `[{ id, label, icon, what }]`. The first is the default unless `value` names
 * another. What it emits is the id, never the index - a list that grows in the middle should not
 * quietly change what the button does.
 *
 * The menu is one row per choice: the glyph and the name. `what` is the row's tooltip and is not
 * drawn, because a menu that explains each choice in a sentence is a page, and this opens under
 * a 22px button next to the thing being added.
 */
import { placeMenu } from '../menu-place.mjs';

export default {
  name: 'SplitButton',

  props: {
    /**
     * `[{ id, label, icon, what }]`, the default first.
     *
     * Defaulted rather than required, and read defensively below: a host that passes nothing -
     * or passes a list that failed to import, which is how this component first shipped - gets
     * a plain button that still does the usual thing. A control that throws while rendering
     * disappears entirely, which is a worse answer to a missing list than a missing caret.
     */
    options: {
      type:    Array,
      default: () => [],
    },
    /** Which option the main press runs; the first when empty. */
    value: {
      type:    String,
      default: '',
    },
    /** The main press's accessible name; each option's own label is used in the menu. */
    label: {
      type:    String,
      default: '',
    },
    disabled: {
      type:    Boolean,
      default: false,
    },
    /**
     * A class for the main half.
     *
     * The host styles the button, not the wrapper: a host class with a width on it - the tab
     * row's 28px, say - applied to the wrapper squeezes two buttons into one button's box,
     * which inside a scroller clips them out of sight entirely. So the wrapper only ever
     * carries layout, and anything that makes the press look like the host's other controls
     * goes here.
     */
    mainClass: {
      type:    String,
      default: '',
    },
  },

  emits: ['pick'],

  data() {
    return {
      open: false,
      /**
       * Where the menu is drawn, in viewport coordinates.
       *
       * The menu is teleported to the body and positioned, rather than placed under the button
       * in the normal way, because the hosts that need it most are the ones that clip it: the
       * drawer's tab row scrolls horizontally (`overflow-x: auto`), and an overflow on one axis
       * clips the other, so a menu dropping out of that row was cut off at the row's edge. No
       * `z-index` reaches out of a clipping ancestor, so the menu has to leave it.
       *
       * Which also means nothing keeps it on screen, so `placeMenu` works out the corner from
       * the two rectangles - see menu-place.mjs. `placed` is false for the one frame between
       * rendering the menu and measuring it: it has to be in the document to have a size, and
       * drawing it at a guessed position first is a visible jump.
       */
      at: {
        top: 0, left: 0, maxHeight: 0, above: false,
      },
      placed: false,
    };
  },

  computed: {
    choices() {
      return Array.isArray(this.options) ? this.options.filter((option) => option?.id) : [];
    },

    chosen() {
      return this.choices.find((option) => option.id === this.value) || this.choices[0] || {};
    },
  },

  mounted() {
    document.addEventListener('click', this.onDocClick, true);
    document.addEventListener('keydown', this.onKey);
    // Captured, because the scroller that moves the button is usually an inner one (the tab
    // row) and a scroll event on it does not bubble to the window.
    window.addEventListener('scroll', this.place, true);
    window.addEventListener('resize', this.place);
  },

  beforeUnmount() {
    document.removeEventListener('click', this.onDocClick, true);
    document.removeEventListener('keydown', this.onKey);
    window.removeEventListener('scroll', this.place, true);
    window.removeEventListener('resize', this.place);
  },

  methods: {
    /**
     * A click anywhere else shuts the menu.
     *
     * Captured on the document rather than behind an overlay, because an overlay would eat the
     * first click on whatever the person actually wanted next - the same reasoning as the
     * wordmark menu in DevShell.
     */
    onDocClick(event) {
      if (this.open && !this.$el?.contains(event.target)) {
        this.open = false;
      }
    },

    onKey(event) {
      if (event.key === 'Escape' && this.open) {
        this.open = false;
      }
    },

    pick(id) {
      this.open = false;
      this.$emit('pick', id);
    },

    /**
     * Put the menu where it fits, from what both rectangles actually measure.
     *
     * Called when it opens, and again on any scroll or resize while it is open: the menu is
     * fixed to the viewport and the button is not, so anything that moves the button leaves the
     * menu behind. Cheap enough to run on those events - two `getBoundingClientRect`s and the
     * arithmetic in menu-place.mjs - and the alternative, closing the menu on scroll, takes the
     * menu away from somebody who only nudged a trackpad.
     */
    place() {
      if (!this.open) {
        return;
      }
      const anchor = this.$el?.getBoundingClientRect?.();
      const menu = this.$refs.menu?.getBoundingClientRect?.();

      if (!anchor || !menu) {
        return;
      }

      this.at = placeMenu(anchor, menu, { width: window.innerWidth, height: window.innerHeight });
      this.placed = true;
    },

    /** Open it where the control is, measured after it renders rather than guessed. */
    toggle() {
      if (this.open) {
        this.open = false;

        return;
      }
      this.placed = false;
      this.open = true;
      // One tick: the menu has to be in the document before it has a width to place by.
      this.$nextTick(this.place);
    },
  },
};
</script>

<template>
  <div class="split-btn">
    <button
      type="button"
      class="split-btn__main"
      :class="mainClass"
      :disabled="disabled"
      :aria-label="label || chosen.label"
      :title="chosen.what || chosen.label"
      @click="pick(chosen.id)"
    >
      <slot>+</slot>
    </button>
    <button
      v-if="choices.length > 1"
      type="button"
      class="split-btn__more"
      :disabled="disabled"
      :aria-label="`${ label || 'More' }: other options`"
      :aria-expanded="open ? 'true' : 'false'"
      aria-haspopup="menu"
      @click="toggle"
    >
      <i :class="open ? 'icon icon-chevron-up' : 'icon icon-chevron-down'" />
    </button>

    <Teleport to="body">
      <ul
        v-if="open"
        ref="menu"
        class="split-btn__menu"
        :class="{ 'split-btn__menu--above': at.above }"
        role="menu"
        :style="{
          top: `${ at.top }px`,
          left: `${ at.left }px`,
          maxHeight: at.maxHeight ? `${ at.maxHeight }px` : null,
          visibility: placed ? null : 'hidden',
        }"
      >
        <li
          v-for="option in choices"
          :key="option.id"
        >
          <button
            type="button"
            role="menuitem"
            class="split-btn__item"
            :class="{ 'split-btn__item--on': option.id === chosen.id }"
            :title="option.what || option.label"
            @click="pick(option.id)"
          >
            <i
              class="icon split-btn__item-icon"
              :class="option.icon || 'icon-dot'"
            />
            <span class="split-btn__item-label">{{ option.label }}</span>
          </button>
        </li>
      </ul>
    </Teleport>
  </div>
</template>

<style lang="scss" scoped>
.split-btn {
  position:    relative;
  display:     inline-flex;
  align-items: stretch;
}

.split-btn__main,
.split-btn__more {
  display:         inline-flex;
  align-items:     center;
  justify-content: center;
  min-height:      0;
  padding:         0 var(--dev-space-2);
  border:          1px solid var(--border);
  background:      transparent;
  color:           var(--muted);
  font:            inherit;
  line-height:     1;
  cursor:          pointer;

  &:hover:not(:disabled) { color: var(--link); border-color: var(--link); }
  &:disabled { opacity: .5; cursor: default; }
}

/* One control, so the halves meet: the radius is on the outside edges only. */
.split-btn__main {
  min-width:          22px;
  border-radius:      var(--dev-r-ctl) 0 0 var(--dev-r-ctl);
  border-right-width: 0;
  font-size:          15px;

  /* With nothing to choose between there is no caret, so the press is the whole control. */
  &:only-child {
    border-radius:      var(--dev-r-ctl);
    border-right-width: 1px;
  }
}

.split-btn__more {
  border-radius: 0 var(--dev-r-ctl) var(--dev-r-ctl) 0;
  font-size:     10px;
}

/*
 * On the body, so no scroller can clip it; placed by the coordinates measured on open.
 *
 * Sized by its longest row rather than by a width of its own: a menu of two names was 220px
 * wide and three lines tall per choice, which is a panel where a list was wanted. The sentence
 * about each choice is in the row's `title` now, where it costs nothing to the person who
 * already knows which one they want.
 */
.split-btn__menu {
  position:      fixed;
  z-index:       1000;
  width:         max-content;
  min-width:     140px;
  margin:        0;
  padding:       var(--dev-space-1) 0;
  list-style:    none;
  background:    var(--body-bg);
  border:        1px solid var(--border);
  border-radius: var(--dev-r-ctl);
  box-shadow:    0 8px 24px rgba(0, 0, 0, .3);
  /* Only ever reached when `maxHeight` is set, which is a menu too tall for the window either
     way up. `overscroll-behavior` keeps that scroll out of the page behind it. */
  overflow-y:          auto;
  overscroll-behavior: contain;
  /* A menu wider than the window is placed at the left edge; this is what stops it running off
     the right one. */
  max-width: calc(100vw - 16px);
}

/* Flipped above the button: the shadow falls the other way, or the menu looks as though it is
   hanging from nothing. */
.split-btn__menu--above {
  box-shadow: 0 -8px 24px rgba(0, 0, 0, .3);
}

/* One row: a glyph, a name, and nothing else. */
.split-btn__item {
  display:     flex;
  align-items: center;
  gap:         var(--dev-space-3);
  width:       100%;
  padding:     var(--dev-space-2) var(--dev-space-4);
  min-height:  0;
  border:      0;
  background:  transparent;
  text-align:  left;
  white-space: nowrap;
  cursor:      pointer;

  &:hover { background: var(--accent-btn); }
}

.split-btn__item-icon {
  flex: 0 0 auto;
  /* Dimmer than the name, so the row reads as a word with a mark beside it rather than as two
     things of equal weight - and brightened with the rest of the row on hover. */
  color:     var(--muted);
  font-size: 14px;
  line-height: 1;
}

.split-btn__item:hover .split-btn__item-icon { color: var(--body-text); }

.split-btn__item-label { color: var(--body-text); font-size: 13px; line-height: 18px; }
.split-btn__item--on .split-btn__item-label { font-weight: 700; }
</style>
