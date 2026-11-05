<script>
// Every dialog in the product, whichever view it opens over.
//
// A view opened over the page rather than instead of it: the rail keeps the conversation and the
// evidence where they are, and the Review, PR, Browser and Share views come up in front of them,
// closed by the button, the veil or Esc. Confirmations, forms, the file and artifact viewers and
// the Focus view's settings, prose and whole-file dialogs are all this too.
//
// There were fourteen of these. Five used this; the rest each had a veil, a panel, a close
// button and an Escape listener of their own, at seven different z-indexes, three of which
// closed on Escape together when one was opened over another. On a phone they were a box
// floating in a 94vw margin with its own rounded corners, on a screen with no room to spare.
// Now there is one, and on a phone it is the screen.
import { holdOverlay, releaseOverlay } from './focus/overlay';

/**
 * The dialogs that are open, oldest first.
 *
 * Escape and Tab belong to the one on top. Every dialog listens on the window, so without this
 * a confirmation opened over the artifact viewer closed both on one keypress - the question and
 * the thing it was asking about.
 */
const stack = [];

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
     *   auto   - as tall as its content, up to 86vh, and 560px wide. Forms, confirmations,
     *            anything that is a handful of rows. The default, because it is the safe one:
     *            too small shows a scrollbar, too big shows a void.
     *   medium - 720px, as tall as its content: prose, a list, a longer form.
     *   wide   - 1040px by up to 760px, fixed: something with a column of its own beside the
     *            content - settings with their sections, a run history, a skill's text.
     *   large  - the window, for the things that are a view rather than a dialog: a diff, a
     *            pull request, a browser, a terminal, a file.
     *   full   - every pixel, with no panel edge: a gallery of screenshots and recordings,
     *            where the frame is the thing being looked at.
     *
     * Whatever it is, on a phone (760px and narrower, the product's one breakpoint) it is the
     * whole screen.
     */
    size: {
      type:      String,
      default:   'auto',
      validator: (v) => ['auto', 'medium', 'wide', 'large', 'full'].includes(v),
    },

    /**
     * In the Focus view's own look rather than the dashboard's.
     *
     * Its tokens - palette, spacing, type - are declared on `.dev-focus`, and a dialog moved to
     * the end of the document is outside that element. So the class travels with it, and with
     * it the frosted veil and the larger radius that view's dialogs have.
     */
    focus: {
      type:    Boolean,
      default: false,
    },

    /**
     * Padding round the content. Forms and prose want it; a view - a terminal, a diff, an
     * image - draws its own edges and fills the box. `null` is "what the size suggests": padded
     * for auto and medium, flush for the rest.
     */
    padded: {
      type:    Boolean,
      default: null,
    },

    /** Whether a click on the veil closes. Off for a form that would lose what was typed. */
    dismissible: {
      type:    Boolean,
      default: true,
    },
  },

  /**
   * `close`, with why: 'escape', 'veil' or 'button'. A caller that treats them alike ignores it;
   * the media viewer goes back to its grid on Escape rather than out.
   */
  emits: ['close'],

  computed: {
    flush() {
      return this.padded === null ? !['auto', 'medium'].includes(this.size) : !this.padded;
    },
  },

  mounted() {
    /*
     * Escape closes, and Tab stays inside.
     *
     * A dialog that does not hold focus is a dialog only for people who can see it. Three
     * things are what `aria-modal` promises on this element's behalf: focus moves in, Tab
     * cycles within, and focus goes back where it came from.
     */
    stack.push(this);
    // The Focus deck turns on the window's arrow keys and wheel; while a dialog is up they are
    // the dialog's.
    holdOverlay();
    this.returnTo = document.activeElement;
    this.onKey = (e) => {
      if (stack[stack.length - 1] !== this) {
        return;
      }
      if (e.key === 'Escape') {
        /*
         * Not when a terminal or an editor has the caret. Escape is what interrupts Claude in a
         * conversation popped out into one of these, and what leaves a completion list in an
         * editor; closing the dialog round it took the conversation away instead. The close
         * button is still there.
         */
        if (e.target?.closest?.('.xterm, .CodeMirror, .cm-editor')) {
          return;
        }
        // Capture phase, and stopped: the deck and the page under this have Escape bindings of
        // their own, and the keypress was this dialog's.
        e.stopPropagation();
        this.$emit('close', 'escape');

        return;
      }
      if (e.key === 'Tab') {
        this.keepTab(e);
      }
    };
    window.addEventListener('keydown', this.onKey, true);
    // After paint, because the panel and everything in it has to exist to be focused. The
    // panel itself takes focus when it holds nothing focusable, which is why it has tabindex.
    this.$nextTick(() => {
      const first = this.focusable()[0] || this.$refs.panel;

      first?.focus?.({ preventScroll: true });
    });
  },

  beforeUnmount() {
    const at = stack.indexOf(this);

    if (at >= 0) {
      stack.splice(at, 1);
    }
    releaseOverlay();
    window.removeEventListener('keydown', this.onKey, true);
    /*
     * Back where it came from, if that is still somewhere.
     *
     * A button that opened a modal is often removed by what the modal did - approving a pull
     * request takes its own button away - so the element may no longer be in the document.
     */
    if (this.returnTo?.isConnected) {
      this.returnTo.focus?.({ preventScroll: true });
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
      } else if (!e.shiftKey && (on === last || !this.$refs.panel?.contains(on))) {
        e.preventDefault();
        first.focus();
      }
    },

    onVeil() {
      if (this.dismissible) {
        this.$emit('close', 'veil');
      }
    },
  },
};
</script>

<template>
  <Teleport to="body">
    <div
      class="dev-modal"
      :class="{ 'dev-focus': focus, 'dev-modal--focus': focus, [`dev-modal--${ size }`]: true }"
      @click.self="onVeil"
    >
      <!--
        `role` and `aria-modal` on the PANEL, not the veil. The veil is the thing you click to
        dismiss; the dialog is the box.
      -->
      <div
        ref="panel"
        class="dev-modal__panel"
        :class="{ 'dev-modal__panel--flush': flush }"
        role="dialog"
        aria-modal="true"
        :aria-label="title || 'Dialog'"
        tabindex="-1"
      >
        <!--
          One header for every dialog: what it is on the left, anything it wants to say or offer
          about itself after that, and the way out in the same corner on all of them.
        -->
        <div class="dev-modal__head">
          <div class="dev-modal__title">
            <slot name="title">
              {{ title }}
            </slot>
          </div>
          <div
            v-if="$slots.head"
            class="dev-modal__extra"
          >
            <slot name="head" />
          </div>
          <button
            type="button"
            class="dev-modal__close"
            aria-label="Close"
            title="Close (Esc)"
            @click="$emit('close', 'button')"
          >
            <svg
              viewBox="0 0 16 16"
              width="16"
              height="16"
              aria-hidden="true"
            ><path
              d="M4 4l8 8M12 4l-8 8"
              stroke="currentColor"
              stroke-width="1.6"
              stroke-linecap="round"
              fill="none"
            /></svg>
          </button>
        </div>
        <div class="dev-modal__body">
          <slot />
        </div>
        <!--
          What the dialog does, in one row at the bottom: right-aligned, with the thing it is for
          the furthest right, where a dialog's answer is. Pinned outside the scroller, so the
          answer is on screen whatever the body is doing. A dialog that only shows something
          passes no footer and draws no row.
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
  // The dashboard's look. The Focus view's is the same names pointed at its own tokens, below.
  --dm-bg:      var(--body-bg);
  --dm-text:    var(--body-text);
  --dm-muted:   var(--muted);
  --dm-border:  var(--border);
  --dm-edge:    var(--border);
  --dm-head:    transparent;
  --dm-radius:  var(--r-md);
  --dm-shadow:  0 10px 40px rgba(0, 0, 0, .4);
  --dm-veil:    rgba(0, 0, 0, .55);
  --dm-blur:    none;
  --dm-full-bg: rgba(0, 0, 0, .86);

  position:        fixed;
  inset:           0;
  // Above Rancher's header, its side nav and the docked agent panel (900); below the menus a
  // dialog's own controls open (SMenu 2000, the reviewer picker 3100), and above everything
  // else of ours. One number for all of them: a dialog opened over another is later in the
  // document, so it is on top without needing a bigger one.
  z-index:         1200;
  display:         flex;
  align-items:     center;
  justify-content: center;
  background:      var(--dm-veil);
  backdrop-filter: var(--dm-blur);
  color:           var(--dm-text);
  animation:       dev-modal-veil .16s ease-out;

  &--focus {
    --dm-bg:      var(--surface);
    --dm-text:    var(--text);
    --dm-muted:   var(--text-muted);
    --dm-border:  var(--border);
    --dm-edge:    var(--border-strong);
    --dm-head:    var(--surface-sunk);
    --dm-radius:  var(--r-xl);
    --dm-shadow:  var(--shadow-3);
    --dm-veil:    rgba(6, 8, 14, .62);
    --dm-blur:    blur(4px);
    --dm-full-bg: color-mix(in srgb, var(--ground-deep) 88%, transparent);

    font-family: var(--font);
  }

  &__panel {
    display:        flex;
    flex-direction: column;
    max-width:      94vw;
    background:     var(--dm-bg);
    color:          var(--dm-text);
    border:         1px solid var(--dm-edge);
    border-radius:  var(--dm-radius);
    box-shadow:     var(--dm-shadow);
    overflow:       hidden;
    outline:        none;
    animation:      dev-modal-in .2s cubic-bezier(.2, .8, .2, 1);
  }

  // As tall as what is in it, with a ceiling so a long one scrolls rather than running off.
  &--auto &__panel,
  &--medium &__panel { max-height: 86vh; }

  &--auto &__panel   { width: var(--dev-modal-sm); }
  &--medium &__panel { width: var(--dev-modal); }

  &--wide &__panel {
    width:  1040px;
    height: min(760px, 86vh);
  }

  &--large &__panel {
    width:  1500px;
    height: 92vh;
  }

  // The frame is what is being looked at: no panel, no edge, the whole window.
  &--full &__panel {
    width:         100%;
    max-width:     none;
    height:        100%;
    border:        0;
    border-radius: 0;
    box-shadow:    none;
    background:    var(--dm-full-bg);
  }

  &--full {
    background:      transparent;
    backdrop-filter: blur(14px);
  }

  &__head {
    display:     flex;
    align-items: center;
    gap:         12px;
    flex:        0 0 auto;
    min-width:   0;
    padding:     10px 12px 10px 20px;
    border-bottom: 1px solid var(--dm-border);
    background:  var(--dm-head);
  }

  &--full &__head { background: transparent; border-bottom: 0; }

  &__title {
    display:       flex;
    align-items:   center;
    gap:           10px;
    flex:          1 1 auto;
    min-width:     0;
    overflow:      hidden;
    font-size:     15px;
    font-weight:   700;
    text-overflow: ellipsis;
    white-space:   nowrap;
  }

  &__extra {
    display:     flex;
    align-items: center;
    gap:         8px;
    flex:        0 1 auto;
    min-width:   0;
  }

  // One close control, the same size and place in every dialog. Written out in full rather
  // than with the shell's `.btn`, because the Focus view resets every button and the dashboard
  // sizes every one - a class that looks right in one view is 40px tall or invisible in the other.
  &__close {
    display:         inline-flex;
    align-items:     center;
    justify-content: center;
    flex:            0 0 auto;
    width:           32px;
    height:          32px;
    min-height:      0;
    padding:         0;
    border:          1px solid var(--dm-border);
    border-radius:   999px;
    background:      transparent;
    color:           var(--dm-muted);
    cursor:          pointer;

    &:hover { color: var(--dm-text); border-color: var(--dm-edge); }
  }

  &__body {
    flex:           1 1 auto;
    min-height:     0;
    display:        flex;
    flex-direction: column;
    overflow:       auto;
    padding:        20px;
    gap:            16px;
  }

  /*
   * A view's content is the panel; a dialog's content sits in it.
   *
   * A view - a terminal, a diff, an image - draws its own edges, so it gets no padding. Its
   * content stretches itself (`flex: 1 1 auto; min-height: 0` on its own root): a rule here
   * would not reach it, because a slot's elements carry the scope of the component that wrote
   * them, not of this one.
   */
  &__panel--flush &__body {
    padding: 0;
    gap:     0;
  }

  /*
   * The action row, with the primary last. `row-reverse` rather than `flex-end`, so the order
   * the buttons are written in - the answer first, then Cancel, the way the code reads - is the
   * order they are read in, with the answer on the right where the eye ends up.
   */
  &__foot {
    display:         flex;
    flex-direction:  row-reverse;
    justify-content: flex-start;
    align-items:     center;
    flex-wrap:       wrap;
    gap:             12px;
    flex:            0 0 auto;
    padding:         12px 20px;
    border-top:      1px solid var(--dm-border);
    background:      var(--dm-head);
  }

  // Anything the footer puts on the LEFT - a count, a warning - goes last with this class.
  &__foot :deep(.dev-modal__foot-aside) { margin-right: auto; }

  /*
   * A phone: the screen.
   *
   * A dialog in a 94vw margin on a 390px screen is 366px of form inside 24px of dimmed page that
   * cannot be used for anything, with corners rounded on a box the size of the window. So every
   * size takes the whole of it, clear of the notch and the home bar, and the veil has nothing
   * left to show.
   */
  @media (max-width: 760px) {
    & { align-items: stretch; }

    &__panel,
    &--auto &__panel,
    &--medium &__panel,
    &--wide &__panel,
    &--large &__panel {
      width:         100%;
      max-width:     none;
      height:        100%;
      max-height:    none;
      border:        0;
      border-radius: 0;
      box-shadow:    none;
      animation:     dev-modal-up .22s cubic-bezier(.2, .8, .2, 1);
    }

    &__head {
      padding:     calc(8px + env(safe-area-inset-top, 0px)) 8px 8px 16px;
      min-height:  52px;
    }

    &__close { width: 40px; height: 40px; }

    // A row of controls scrolls sideways rather than pushing the close button off the screen.
    &__extra { overflow-x: auto; scrollbar-width: none; }

    &__body { padding: 16px; }
    &__panel--flush &__body { padding: 0; }

    &__foot { padding: 10px 16px calc(10px + env(safe-area-inset-bottom, 0px)); }

    // With no footer the body is the last thing on the screen, so it keeps clear of the home bar.
    &__body:last-child { padding-bottom: calc(16px + env(safe-area-inset-bottom, 0px)); }
    &__panel--flush &__body:last-child { padding-bottom: env(safe-area-inset-bottom, 0px); }
  }
}

@keyframes dev-modal-veil { from { opacity: 0; } }
@keyframes dev-modal-in { from { opacity: 0; transform: translateY(6px) scale(.985); } }
@keyframes dev-modal-up { from { opacity: 0; transform: translateY(24px); } }

@media (prefers-reduced-motion: reduce) {
  .dev-modal,
  .dev-modal__panel { animation: none !important; }
}
</style>

<style lang="scss">
/*
 * What a dialog's controls open lands on top of it.
 *
 * The shell appends a select's options and a tooltip to the body at its own z-indexes, 55 and
 * 57 - built for its own modals at 53 - so inside one of these they opened behind the panel: a
 * select that showed nothing when clicked, in the import dialog that is three of them.
 */
body > .vs__dropdown-menu,
.v-popper__popper {
  z-index: 1300 !important;
}
</style>
