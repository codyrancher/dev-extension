<script setup lang="ts">
/**
 * The button, in four weights.
 *
 * `primary` is the one thing a card wants you to do and there is never more than one on screen;
 * `ghost` is everything else a card offers; `quiet` is for a row of controls that should read as
 * furniture; `kind` borrows the current card's hue, which is how a card's own actions stay part
 * of the card rather than part of the app.
 */
import AppIcon from './AppIcon.vue';
import type { IconName } from './icons';

withDefaults(defineProps<{
  variant?: 'primary' | 'ghost' | 'quiet' | 'kind';
  size?: 'sm' | 'md' | 'lg';
  icon?: IconName;
  iconAfter?: IconName;
  busy?: boolean;
  block?: boolean;
}>(), { variant: 'ghost', size: 'md', busy: false, block: false });
</script>

<template>
  <button
    type="button"
    class="btn"
    :class="[`btn--${ variant }`, `btn--${ size }`, { 'btn--block': block, 'btn--busy': busy }]"
    :disabled="busy"
  >
    <AppIcon v-if="busy" name="spinner" :size="size === 'lg' ? 18 : 16" />
    <AppIcon v-else-if="icon" :name="icon" :size="size === 'lg' ? 18 : 16" />
    <span class="btn__label"><slot /></span>
    <AppIcon v-if="iconAfter && !busy" :name="iconAfter" :size="size === 'lg' ? 18 : 16" class="btn__after" />
  </button>
</template>

<style scoped>
.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--s2);
  border: 1px solid transparent;
  border-radius: var(--r-pill);
  background: transparent;
  font-weight: 560;
  letter-spacing: -0.01em;
  white-space: nowrap;
  cursor: pointer;
  transition:
    background var(--fast) var(--ease-out),
    border-color var(--fast) var(--ease-out),
    color var(--fast) var(--ease-out),
    transform var(--fast) var(--ease-spring),
    box-shadow var(--base) var(--ease-out);
}

.btn:active:not(:disabled) { transform: translateY(1px) scale(0.985); }
.btn:disabled { cursor: default; opacity: 0.75; }

/*
 * Two heights, and one exception.
 *
 * It was 30 / 38 / 48, and with the card's own 24px chip row, its 26px label pills and its 30px
 * provenance controls that made five heights for "a small rounded thing" on a single card - the
 * footer alone measured [48, 38, 38, 30] on one row. `sm` and `md` are the same height now and
 * differ in padding and in weight of colour, which is what was supposed to be telling them apart;
 * `lg` is the one primary a card is allowed, so it is the one thing that is a different size.
 *
 * A height rather than padding, for `lg` too: it was `padding: 0 var(--s5)` over a `--t-md` line,
 * so the same primary resolved to 48px on the deck's first eleven cards and 47px on the last
 * fifteen, from nothing but which glyphs were in the label.
 */
.btn--sm { height: var(--control-h); padding: 0 var(--s3); font-size: var(--t-sm); }
.btn--md { height: var(--control-h); padding: 0 var(--s4); font-size: var(--t-sm); }
.btn--lg { height: var(--primary-h); padding: 0 var(--s5); font-size: var(--t-md); }
.btn--block { width: 100%; }

/*
 * Ink on a filled button is the fill's, not the page's.
 *
 * It was `#08101f` here and `#0d0f16` below - this view's dark ground, written out by hand - and
 * then `var(--ground)`, which followed the page. That is the wrong relationship, and on the light
 * theme it inverted both of these buttons: measured in `body.theme-light`, `.btn--kind` came out
 * rgb(244,246,251) on rgb(127,215,196) = 1.56:1 on the issue hue and ~1.3:1 on the agent hue, so
 * every card's primary was a near-white ghost on a pastel. `--ink-on-kind` is declared once in
 * design/focus.css and is the same in both themes, because the hue is.
 */
.btn--primary {
  background: var(--accent);
  color: var(--ink-on-kind);
  box-shadow: 0 10px 24px -12px var(--accent), var(--shadow-1);
}

.btn--primary:hover:not(:disabled) {
  background: var(--accent-hover);
  box-shadow: 0 14px 30px -12px var(--accent-hover);
}

/* The card's own colour, set by whichever card is on top (see TaskCard). */
.btn--kind {
  background: var(--kind);
  color: var(--ink-on-kind);
  box-shadow: 0 10px 26px -14px var(--kind), var(--shadow-1);
}

.btn--kind:hover:not(:disabled) { filter: brightness(1.07); box-shadow: 0 16px 34px -14px var(--kind); }

/*
 * The lift under a ghost, mixed from the text colour rather than written as white.
 *
 * `rgba(255, 255, 255, 0.02)` is a wash that only exists on a dark ground: on the light theme it
 * was white at 2% over white, so a ghost button had a border and no face, and its hover did
 * nothing at all. Mixed from `--text` it is a dark wash there and the same pale one here.
 */
.btn--ghost {
  border-color: var(--border-strong);
  background: color-mix(in srgb, var(--text) 3%, transparent);
  color: var(--text-dim);
}

.btn--ghost:hover:not(:disabled) {
  border-color: var(--text-muted);
  background: color-mix(in srgb, var(--text) 7%, transparent);
  color: var(--text);
}

/*
 * `--text-dim`, not `--text-muted`.
 *
 * Measured on the card's ground, `--text-muted` is rgb(111, 120, 151) = 4.02:1 against a 4.5:1
 * requirement for 13px text - and `quiet` is a variant for things you press. The footer ran four
 * contrast levels across one 61px row that also carries a primary at full strength; this is still
 * the quietest button in the view, and it is now readable.
 */
.btn--quiet { color: var(--text-dim); }
.btn--quiet:hover:not(:disabled) { background: color-mix(in srgb, var(--text) 7%, transparent); color: var(--text); }

/*
 * The label is what gives when a row is too narrow.
 *
 * `white-space: nowrap` on `.btn` meant nothing in a footer could shrink, so with four controls
 * on the row the sum - 242 + 187 + 195 + 58 plus three gaps plus `Later`'s 16px margin = 734 in
 * 688 - was paid by whatever was last, and `Later` is last. Measured, its right edge was 955-983
 * against a card content edge of 938 and a border at 962, so `overflow: hidden` on `.card` ate up
 * to 21px of the one way out of a card: three screenshots show the word as "Late".
 *
 * A button is still one line; the line can lose its tail. See `.card__foot`, which is what makes
 * these shrinkable in the first place.
 */
.btn__label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.btn--busy .btn__label { opacity: 0.8; }
.btn__after { opacity: 0.7; transition: transform var(--base) var(--ease-out); }
.btn:hover .btn__after { transform: translateX(2px); }
</style>
