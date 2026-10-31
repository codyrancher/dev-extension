<script>
// A view opened over the page rather than instead of it: the rail keeps the conversation and
// the evidence where they are, and the Review, PR, Browser and Share views come up in front of
// them, sized to the window, closed by the button or Esc.
export default {
  name: 'DevModal',

  props: {
    title: {
      type:    String,
      default: '',
    },

    /**
     * How big the panel is, which is a question about what is in it.
     *
     * It used to be one size - `min(94vw, 1500px)` by `92vh` - because the first things opened
     * this way were a diff, a pull request, a browser and a terminal, and all four want the
     * window. Then forms started using it, and a four-field form in a 1500x92vh box is four
     * fields across the top of the screen and a void beneath them, with the buttons stranded
     * at the far left. That is what "Create a Rancher" looked like.
     *
     *   auto   - as tall as its content, up to 86vh, and 560px wide. Forms, confirmations,
     *            anything that is a handful of rows. The default, because it is the safe one:
     *            too small shows a scrollbar, too big shows a void.
     *   medium - 720px, for a panel with prose or a list in it.
     *   large  - the window, for the things that are a view rather than a dialog.
     */
    size: {
      type:      String,
      default:   'auto',
      validator: (v) => ['auto', 'medium', 'large'].includes(v),
    },
  },

  emits: ['close'],

  mounted() {
    /*
     * Escape closes, and Tab stays inside.
     *
     * A dialog that does not hold focus is a dialog only for people who can see it. Opening
     * one with a keyboard used to leave the caret wherever it was on the page behind, so the
     * next Tab went into a form you could no longer see, under a panel you could not reach by
     * tabbing - and the close button was somewhere after every link on the page.
     *
     * Three things fix that, and they are the ones `aria-modal` promises on this element's
     * behalf: focus moves in, Tab cycles within, and focus goes back where it came from.
     */
    this.returnTo = document.activeElement;
    this.onKey = (e) => {
      if (e.key === 'Escape') {
        this.$emit('close');

        return;
      }
      if (e.key === 'Tab') {
        this.keepTab(e);
      }
    };
    window.addEventListener('keydown', this.onKey);
    // After paint, because the panel and everything in it has to exist to be focused. The
    // panel itself takes focus when it holds nothing focusable, which is why it has tabindex.
    this.$nextTick(() => {
      const first = this.focusable()[0] || this.$refs.panel;

      first?.focus?.();
    });
  },

  beforeUnmount() {
    window.removeEventListener('keydown', this.onKey);
    /*
     * Back where it came from, if that is still somewhere.
     *
     * A button that opened a modal is often removed by what the modal did - approving a pull
     * request takes its own button away - so the element may no longer be in the document.
     * Focusing a detached node silently moves focus to the body, which is the same place it
     * would have gone anyway, but `isConnected` says so rather than relying on that.
     */
    if (this.returnTo?.isConnected) {
      this.returnTo.focus?.();
    }
  },

  methods: {
    /** Everything inside the panel a person can Tab to, in document order. */
    focusable() {
      const panel = this.$refs.panel;

      if (!panel) {
        return [];
      }

      return [...panel.querySelectorAll(
        'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )].filter((el) => el.offsetParent !== null || el === document.activeElement);
    },

    /** Tab at either end of the dialog wraps to the other, rather than leaving it. */
    keepTab(e) {
      const stops = this.focusable();

      if (!stops.length) {
        // Nothing to move between: hold the panel rather than letting Tab escape the dialog.
        e.preventDefault();
        this.$refs.panel?.focus?.();

        return;
      }

      const first = stops[0];
      const last = stops[stops.length - 1];
      const on = document.activeElement;

      if (e.shiftKey && (on === first || !this.$refs.panel?.contains(on))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && on === last) {
        e.preventDefault();
        first.focus();
      }
    },
  },
};
</script>

<template>
  <Teleport to="body">
    <div
      class="dev-modal"
      @click.self="$emit('close')"
    >
      <!--
        `role` and `aria-modal` on the PANEL, not the backdrop. The backdrop is the thing you
        click to dismiss; the dialog is the box. `aria-modal` is what tells a screen reader the
        rest of the page is not available, and it is only honest because of the focus handling
        above - claiming it without that is how a dialog announces itself as modal and then
        lets Tab wander off behind it.
      -->
      <div
        ref="panel"
        class="dev-modal__panel"
        :class="`dev-modal__panel--${ size }`"
        role="dialog"
        aria-modal="true"
        :aria-label="title || 'Dialog'"
        tabindex="-1"
      >
        <div class="dev-modal__head">
          <span class="dev-modal__title">{{ title }}</span>
          <button
            type="button"
            class="btn role-tertiary btn-sm"
            aria-label="Close"
            @click="$emit('close')"
          >
            <i class="icon icon-close" />
          </button>
        </div>
        <div class="dev-modal__body">
          <slot />
        </div>
        <!--
          What the dialog does, in one row at the bottom.

          Right-aligned, and the thing it is for is the LAST of them - the furthest right, where
          a dialog's answer is. It was wherever the form's markup happened to leave it, which on
          the Approve panel was bottom-LEFT, under twenty rows of attachments, with Approve to
          the left of Cancel. Pinned outside the scroller, so the answer is on screen whatever
          the body is doing.

          A `footer` nobody passes draws nothing: a dialog that only shows something has no row.
        -->
        <div
          v-if="$slots.footer"
          class="dev-modal__foot"
        >
          <slot name="footer" />
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style lang="scss" scoped>
.dev-modal {
  position:        fixed;
  inset:           0;
  z-index:         1200;
  display:         flex;
  align-items:     center;
  justify-content: center;
  background:      rgba(0, 0, 0, .55);

  &__panel {
    display:        flex;
    flex-direction: column;
    background:     var(--body-bg);
    border:         1px solid var(--border);
    border-radius:  var(--r-md);
    box-shadow:     0 10px 40px rgba(0, 0, 0, .4);
    overflow:       hidden;

    // As tall as what is in it, with a ceiling so a long one scrolls rather than running off
    // the screen. `94vw` under the fixed widths is the phone and the split pane: a 560px panel
    // on a 420px window is a panel with its right-hand side missing.
    &--auto,
    &--medium {
      max-height: 86vh;
    }

    &--auto   { width: min(var(--dev-modal-sm), 94vw); }
    &--medium { width: min(var(--dev-modal), 94vw); }

    // The window, for the things that are a view: a diff, a pull request, a browser, a terminal.
    // They size themselves to what they are given, so they are given everything.
    &--large {
      width:  min(94vw, 1500px);
      height: 92vh;
    }
  }

  &__head {
    display:         flex;
    align-items:     center;
    justify-content: space-between;
    gap:             var(--dev-space-3);
    flex:            0 0 auto;
    padding:         12px 12px 12px 20px;
    border-bottom:   1px solid var(--border);
  }

  &__title {
    font-size:   15px;
    font-weight: 700;
  }

  &__body {
    flex:       1 1 auto;
    min-height: 0;
    display:    flex;
    flex-direction: column;
    overflow:   auto;
  }

  /*
   * A view's content is the panel; a dialog's content sits in it.
   *
   * The stretch and the zero padding belong to the first kind - a terminal or a diff fills the
   * box and draws its own edges. Applied to the second they are what put a form's buttons at
   * the top-left of an empty screen: the first child was stretched to the full height and the
   * rest had nowhere to go.
   */
  &__panel--large &__body > * {
    flex:       1 1 auto;
    min-height: 0;
  }

  &__panel--auto &__body,
  &__panel--medium &__body {
    padding: 20px;
    gap:     16px;
  }

  /*
   * The action row. Right-aligned, with the primary last - see the slot's own comment.
   *
   * `row-reverse` rather than `flex-end`, so the ORDER the buttons are written in is the order
   * they are read in: a dialog's markup says the answer first - `<RcButton>Approve</RcButton>`
   * then Cancel - the way the code that runs it reads, and the row puts the answer on the
   * right where the eye ends up. Writing them backwards to get them drawn forwards is a thing
   * every one of these footers would have had to remember.
   */
  &__foot {
    display:         flex;
    flex-direction:  row-reverse;
    justify-content: flex-start;
    align-items:     center;
    gap:             var(--dev-space-4);
    flex:            0 0 auto;
    padding:         12px 20px;
    border-top:      1px solid var(--border);
  }

  /*
   * Anything the footer puts on the LEFT - a count, a warning, a destructive action that is not
   * the dialog's answer - goes last in the markup with this class on it, and the gap between it
   * and the buttons is the whole width of the row.
   */
  &__foot :deep(.dev-modal__foot-aside) { margin-right: auto; }
}
</style>
