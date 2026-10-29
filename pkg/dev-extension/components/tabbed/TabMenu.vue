<script>
// The menu on a tab: a caret, and a short list of things to do to that tab.
//
// It exists because a tab had one way to reach anything beyond rename and close: right-click,
// which opened the larger view. Nothing on screen said so, nothing else in the product uses a
// context menu, and a tab that gains a second such action has nowhere to put it. So the actions
// are a list now, opened from a control that can be seen - and right-click opens the same list,
// which is why the host can still call `show` from outside.
//
// Teleported to the body and placed by hand, for exactly the reason SplitButton's menu is: the
// tab row scrolls horizontally, an overflow on one axis clips the other, and no z-index reaches
// out of a clipping ancestor. The arithmetic that keeps it on screen is shared and tested - see
// menu-place.mjs.
import { placeMenu } from '../../menu-place.mjs';

export default {
  name: 'TabMenu',

  props: {
    /** `[{ id, label, icon, what, danger }]` per line. Rows with no id are dropped. */
    items: {
      type:    Array,
      default: () => [],
    },

    ariaLabel: {
      type:    String,
      default: 'Tab actions',
    },

    /**
     * Something chosen from this menu is still running.
     *
     * The caret becomes a spinner and stops opening, because the two actions here take a second
     * or two in the pod and the tab they were asked from is the only place that can say so -
     * a fork pressed twice is two copies of one history and a tab nobody meant.
     */
    busy: {
      type:    Boolean,
      default: false,
    },
  },

  emits: ['select'],

  data() {
    return {
      open: false,
      at:   {
        top: 0, left: 0, maxHeight: 0, above: false,
      },
      /** False for the one frame between rendering the menu and measuring it; see `place`. */
      placed: false,
    };
  },

  computed: {
    rows() {
      return Array.isArray(this.items) ? this.items.filter((item) => item?.id) : [];
    },
  },

  mounted() {
    document.addEventListener('click', this.onDocClick, true);
    document.addEventListener('keydown', this.onKey);
    // Captured: the scroller that moves this control is the tab row, and its scroll does not
    // bubble to the window.
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
    onDocClick(event) {
      if (this.open && !this.$el?.contains(event.target) && !this.$refs.menu?.contains(event.target)) {
        this.open = false;
      }
    },

    onKey(event) {
      if (event.key === 'Escape' && this.open) {
        this.open = false;
      }
    },

    /** Open it, measured after it renders rather than guessed at. Called by the host too. */
    show() {
      if (!this.rows.length || this.busy) {
        return;
      }
      this.placed = false;
      this.open = true;
      this.$nextTick(this.place);
    },

    toggle() {
      if (this.open) {
        this.open = false;

        return;
      }
      this.show();
    },

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

    choose(item) {
      this.open = false;
      this.$emit('select', item.id);
    },
  },
};
</script>

<template>
  <span class="tab-menu">
    <button
      type="button"
      class="tab-menu__caret"
      :class="{ 'tab-menu__caret--open': open }"
      :aria-label="ariaLabel"
      :aria-expanded="open ? 'true' : 'false'"
      :disabled="busy"
      aria-haspopup="menu"
      @click.stop.prevent="toggle"
      @mousedown.stop
      @dblclick.stop
    >
      <i :class="busy ? 'icon icon-spinner icon-spin' : 'icon icon-chevron-down'" />
    </button>

    <Teleport to="body">
      <ul
        v-if="open"
        ref="menu"
        class="tab-menu__list"
        :class="{ 'tab-menu__list--above': at.above }"
        role="menu"
        :style="{
          top: `${ at.top }px`,
          left: `${ at.left }px`,
          maxHeight: at.maxHeight ? `${ at.maxHeight }px` : null,
          visibility: placed ? null : 'hidden',
        }"
      >
        <li
          v-for="item in rows"
          :key="item.id"
        >
          <button
            type="button"
            role="menuitem"
            class="tab-menu__item"
            :class="{ 'tab-menu__item--danger': item.danger }"
            :title="item.what || item.label"
            @click.stop.prevent="choose(item)"
          >
            <i
              class="icon tab-menu__item-icon"
              :class="item.icon || 'icon-dot'"
            />
            <span class="tab-menu__item-label">{{ item.label }}</span>
          </button>
        </li>
      </ul>
    </Teleport>
  </span>
</template>

<style lang="scss" scoped>
.tab-menu {
  display: inline-flex;
}

/*
 * The same 20px glyph as the rename and close controls beside it, so the three read as one set.
 * Positioned by the tab, which reserves the room for them - see ConversationTab.
 */
.tab-menu__caret {
  display:         inline-flex;
  align-items:     center;
  justify-content: center;
  width:           20px;
  height:          20px;
  min-height:      0;
  padding:         0;
  border:          none;
  border-radius:   var(--dev-r-xs);
  background:      none;
  color:           var(--body-text);
  cursor:          pointer;
  opacity:         0.6;

  .icon { font-size: 10px; }

  &:hover,
  &--open { opacity: 1; background: var(--default-hover-bg, var(--body-bg)); }
}

/* On the body, so no scroller can clip it; placed by what was measured on open. The same list
   SplitButton's menu is, because they are the same thing in two places. */
.tab-menu__list {
  position:            fixed;
  z-index:             1000;
  width:               max-content;
  min-width:           170px;
  max-width:           calc(100vw - 16px);
  margin:              0;
  padding:             var(--dev-space-1) 0;
  list-style:          none;
  background:          var(--body-bg);
  border:              1px solid var(--border);
  border-radius:       var(--dev-r-ctl);
  box-shadow:          0 8px 24px rgba(0, 0, 0, .3);
  overflow-y:          auto;
  overscroll-behavior: contain;
}

.tab-menu__list--above {
  box-shadow: 0 -8px 24px rgba(0, 0, 0, .3);
}

.tab-menu__item {
  display:     flex;
  align-items: center;
  gap:         var(--dev-space-3);
  width:       100%;
  min-height:  0;
  padding:     var(--dev-space-2) var(--dev-space-4);
  border:      0;
  background:  transparent;
  text-align:  left;
  white-space: nowrap;
  cursor:      pointer;

  &:hover { background: var(--accent-btn); }
}

.tab-menu__item-icon {
  flex:        0 0 auto;
  color:       var(--muted);
  font-size:   14px;
  line-height: 1;
}

.tab-menu__item:hover .tab-menu__item-icon { color: var(--body-text); }

.tab-menu__item-label {
  color:       var(--body-text);
  font-size:   13px;
  line-height: 18px;
}

.tab-menu__item--danger .tab-menu__item-label { color: var(--error); }
.tab-menu__item--danger .tab-menu__item-icon  { color: var(--error); }
</style>
