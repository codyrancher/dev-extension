<script setup lang="ts">
/**
 * The failing checks, by name, with what each one said and a link to its run.
 *
 * Two places want exactly this list and they wanted it at two sizes: the badge on the facts line
 * opens it in a popover, and the card whose entire subject is a red build has it as its surface.
 * It was only ever the popover, written inside CardChecks - so on the red-pr card the one thing
 * the card exists for could be read in a 26px popover and nowhere else, while the 173px surface
 * showed "What it changed, first 40 of 45 files": a diff you cannot work out three red e2e suites
 * from. Same list, same rows, one file.
 *
 * The names and their own one-line reports are already on the card - `ciOf` fetches up to six,
 * each with its `detail` and a run url - so nothing here costs a request.
 */
import SectionHead from './SectionHead.vue';
import AppIcon from './AppIcon.vue';
import type { CardCheck } from '../../focus-artifacts';

const props = withDefaults(defineProps<{
  /** The failures with names. Capped at six by `ciOf`; `failing` is how many there really are. */
  checks: CardCheck[];
  failing: number;
  /** Taking the room, as a card's surface, rather than sizing to its content in a popover. */
  surface?: boolean;
  /** The fact the card's 36px lede already said. See `claimed` in FocusCard. */
  claimed?: string;
}>(), { surface: false, claimed: '' });

/**
 * `of {failing}`, because the names are capped at six and the count is not: a card whose build has
 * nine failures used to open onto six rows headed `6`. And nothing at all where the card's lede
 * has already said the number - which is every red-pr card, whose lede is `6 of 46 checks failing`.
 */
const count = () => {
  if (props.checks.length < props.failing) {
    return `first ${ props.checks.length } of ${ props.failing }`;
  }

  return props.claimed === 'checks' ? '' : String(props.failing);
};
</script>

<template>
  <section class="cl" :class="{ 'cl--surface': surface }">
    <SectionHead label="Failing checks" icon="cross" :count="count()" />

    <div class="cl__list" :class="{ 'u-fade-y': surface }">
      <component
        :is="check.url ? 'a' : 'div'"
        v-for="check in checks"
        :key="check.name"
        class="cl__row"
        :href="check.url || undefined"
        :target="check.url ? '_blank' : undefined"
        :rel="check.url ? 'noopener' : undefined"
      >
        <span class="cl__name">{{ check.name }}</span>
        <AppIcon v-if="check.url" name="arrow-right" :size="12" class="cl__go" />
        <span v-if="check.detail" class="cl__why">{{ check.detail }}</span>
      </component>
    </div>
  </section>
</template>

<style scoped>
.cl {
  display: flex;
  flex-direction: column;
  gap: var(--s2);
  min-width: 0;
  min-height: 0;
}

/* As a surface it takes the room it is given; see the budget on `.card__body`. */
.cl--surface { flex: 1 1 auto; }

.cl__list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-height: 0;
  min-width: 0;
}

/* Scrolled rather than squeezed, and faded at the cut: six rows of two lines do not fit 276px. */
.cl--surface .cl__list {
  flex: 1 1 auto;
  /* The fade's own room; see `.u-fade-y` in design/focus.css. */
  padding: 0 var(--s2) var(--s5) 0;
  overflow: hidden auto;
}

/*
 * Never squeezed - the one bug this view has had in five costumes. A flex item in a bounded
 * column shrinks below its content by default, so a two-line row draws over the row beneath it.
 */
.cl__row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: baseline;
  flex: 0 0 auto;
  gap: 2px var(--s2);
  min-height: 30px;
  padding: var(--s2);
  border-radius: var(--r-sm);
  color: var(--text-dim);
  text-decoration: none;
}

a.cl__row { cursor: pointer; }
a.cl__row:hover { background: var(--surface-raised); color: var(--text); }

.cl__name {
  font-family: var(--mono);
  font-size: var(--t-xs);
  overflow-wrap: anywhere;
}

/* What it reported, which is the half that says whether it is yours. */
.cl__why {
  grid-column: 1 / -1;
  color: var(--text-faint);
  font-size: var(--t-xs);
  line-height: 1.45;
}

.cl__go { flex: 0 0 auto; color: var(--text-faint); }
</style>
