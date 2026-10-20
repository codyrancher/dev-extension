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
 * `options` is `[{ id, label, what }]`. The first is the default unless `value` names another.
 * What it emits is the id, never the index - a list that grows in the middle should not quietly
 * change what the button does.
 */
export default {
  name: 'SplitButton',

  props: {
    /** `[{ id, label, what }]`, the default first. */
    options: {
      type:     Array,
      required: true,
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
    return { open: false };
  },

  computed: {
    chosen() {
      return this.options.find((option) => option.id === this.value) || this.options[0] || {};
    },
  },

  mounted() {
    document.addEventListener('click', this.onDocClick, true);
    document.addEventListener('keydown', this.onKey);
  },

  beforeUnmount() {
    document.removeEventListener('click', this.onDocClick, true);
    document.removeEventListener('keydown', this.onKey);
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
      type="button"
      class="split-btn__more"
      :disabled="disabled"
      :aria-label="`${ label || 'More' }: other options`"
      :aria-expanded="open ? 'true' : 'false'"
      aria-haspopup="menu"
      @click="open = !open"
    >
      <i :class="open ? 'icon icon-chevron-up' : 'icon icon-chevron-down'" />
    </button>

    <ul
      v-if="open"
      class="split-btn__menu"
      role="menu"
    >
      <li
        v-for="option in options"
        :key="option.id"
      >
        <button
          type="button"
          role="menuitem"
          class="split-btn__item"
          :class="{ 'split-btn__item--on': option.id === chosen.id }"
          @click="pick(option.id)"
        >
          <span class="split-btn__item-label">{{ option.label }}</span>
          <span
            v-if="option.what"
            class="split-btn__item-what"
          >{{ option.what }}</span>
        </button>
      </li>
    </ul>
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
  min-width:                   22px;
  border-radius:               var(--border-radius) 0 0 var(--border-radius);
  border-right-width:          0;
  font-size:                   15px;
}

.split-btn__more {
  border-radius: 0 var(--border-radius) var(--border-radius) 0;
  font-size:     10px;
}

.split-btn__menu {
  position:      absolute;
  top:           calc(100% + 4px);
  right:         0;
  z-index:       100;
  min-width:     220px;
  margin:        0;
  padding:       var(--dev-space-2) 0;
  list-style:    none;
  background:    var(--body-bg);
  border:        1px solid var(--border);
  border-radius: var(--border-radius);
  box-shadow:    0 8px 24px rgba(0, 0, 0, .3);
}

.split-btn__item {
  display:        flex;
  flex-direction: column;
  gap:            2px;
  width:          100%;
  padding:        var(--dev-space-3) var(--dev-space-4);
  min-height:     0;
  border:         0;
  background:     transparent;
  text-align:     left;
  cursor:         pointer;

  &:hover { background: var(--accent-btn); }
}

.split-btn__item-label { color: var(--body-text); font-size: 13px; }
.split-btn__item--on .split-btn__item-label { font-weight: 700; }
.split-btn__item-what { color: var(--muted); font-size: 11px; }
</style>
