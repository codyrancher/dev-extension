<script setup lang="ts">
/**
 * Work nobody has taken, as a thing you choose from.
 *
 * This is the one card that is not about something waiting on you - it is for when nothing is,
 * which is exactly when "what should I do next" is the question. So it is a list rather than a
 * single subject: thirty open issues nobody has picked up, with the three things that decide
 * whether one is worth taking.
 *
 * Those three, and why them. **Age**, because an issue filed this week is one somebody still
 * cares about and a two-year-old one usually is not. **Its labels**, because that is how this
 * repository says what part of the product it is and whether it is a bug or a request.
 * **How much has been said on it**, which is the cheapest signal there is of whether it is
 * specified well enough to start: a bug with nine replies has been argued about, one with none
 * may well be a sentence nobody can act on.
 *
 * Picking one assigns it to you on GitHub and starts the fix, which is the whole point - the
 * alternative is three tabs and a workspace you have to name.
 */
import { computed, nextTick, ref } from 'vue';
import AppButton from './AppButton.vue';
import SectionHead from './SectionHead.vue';
import { issueTags } from '../../focus-artifacts';
import type { PoolIssue } from '../../focus-artifacts';

const props = defineProps<{ pool: PoolIssue[]; busy?: boolean }>();

const emit = defineEmits<{
  (e: 'take', issue: PoolIssue): void;
  (e: 'ask', issue: PoolIssue): void;
}>();

/**
 * Which one is open for a closer look. One at a time; this is a list, not thirty cards.
 *
 * **None, on arrival.** It was `ref(0)`, so the first row auto-expanded - and its `.pick__more`
 * (the labels, "Take it and start", "Is it worth doing?", "On GitHub") takes 115px of the list's
 * 135px. Measured: 100 `.pick` rows in the DOM, 1 expanded, and exactly one row whose box fell
 * inside `.pool__list`. The card for choosing work offered one choice and a sliver of the next.
 * Five 30px rows fit the list closed; opening one is a decision somebody makes.
 */
const openOn = ref<number | null>(null);

/**
 * Open it, and make sure it is still on screen once it is 115px taller.
 *
 * Expanding the last visible row pushes its own controls below the fade without this - which is
 * the fault the auto-expand was hiding by only ever opening the row at the top.
 */
function openAt(n: number, event: MouseEvent) {
  openOn.value = openOn.value === n ? null : n;
  if (openOn.value === n) {
    const row = (event.currentTarget as HTMLElement)?.parentElement;

    nextTick(() => row?.scrollIntoView({ block: 'nearest' }));
  }
}

/**
 * What the labels say, minus the noise. Shared with the card about a single issue - see
 * `issueTags` in focus-artifacts.ts; it was a copy of this.
 */
const tags = issueTags;

const shown = computed(() => props.pool);
</script>

<template>
  <section class="pool">
    <!--
      No count: the card's 36px lede is this list's length, 150px above, and `30 open` under `30
      nobody has taken` is one number earning its place twice.
    -->
    <SectionHead label="Nobody has taken these">
      <span class="pool__hint">Newest first</span>
    </SectionHead>

    <ol class="pool__list u-fade-y">
      <li
        v-for="(issue, n) in shown"
        :key="issue.number"
        class="pick"
        :class="{ 'pick--on': n === openOn }"
      >
        <button type="button" class="pick__row" :aria-expanded="n === openOn" @click="openAt(n, $event)">
          <span class="pick__no">#{{ issue.number }}</span>
          <span class="pick__title">{{ issue.title }}</span>
          <span class="pick__age">{{ issue.age }}d</span>
          <span
            class="u-badge pick__talk"
            :class="{ 'pick__talk--quiet': !issue.comments }"
            :title="issue.comments ? `${ issue.comments } comments` : 'Nobody has replied to it'"
          >{{ issue.comments }}</span>
        </button>

        <div v-if="n === openOn" class="pick__more">
          <span v-for="tag in tags(issue)" :key="tag" class="u-badge">{{ tag }}</span>
          <span v-if="!tags(issue).length" class="pick__untagged">no labels</span>

          <AppButton
            variant="kind"
            size="sm"
            icon-after="arrow-right"
            :busy="busy"
            class="pick__take"
            @click="emit('take', issue)"
          >Take it and start</AppButton>
          <AppButton variant="quiet" size="sm" icon="sparkle" @click="emit('ask', issue)">
            Is it worth doing?
          </AppButton>
          <a class="pick__link" :href="issue.url" target="_blank" rel="noopener">On GitHub</a>
        </div>
      </li>
    </ol>
  </section>
</template>

<style scoped>
.pool {
  /*
   * The width of the issue number column, named once.
   *
   * It is also the indent of the row that opens underneath, and it was the literal 62 twice -
   * so the grid and the indent could drift apart by anybody changing one of them.
   */
  --pick-no: 62px;
  display: flex;
  flex-direction: column;
  gap: var(--s3);
  flex: 1 1 auto;
  min-height: 0;
}



.pool__hint { margin-left: auto; color: var(--text-faint); font-size: var(--t-xs); }

.pool__list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-height: 0;
  margin: 0;
  /* The fade's own room; see `.u-fade-y` in design/focus.css. The fourth row of this list was
     bisected horizontally at the body's bottom edge, which reads as a rendering fault. */
  padding: 0 var(--s2) var(--s5) 0;
  list-style: none;
  overflow-y: auto;
}

/*
 * Never squeezed.
 *
 * A flex item shrinks by default, and a scrolling column of forty of them hands each one less
 * height than its content needs - so the rows collapse into each other and their text draws over
 * the row below, which is what the file tree was doing. Pinning the row is what makes the column
 * scroll instead of compressing. The same mistake, and the same fix, as the card's own header.
 */
.pick {
  flex: 0 0 auto;
  border-radius: var(--r-sm);
}
.pick--on { background: color-mix(in srgb, var(--kind) 8%, transparent); }

.pick__row {
  display: grid;
  grid-template-columns: var(--pick-no) minmax(0, 1fr) 38px 30px;
  align-items: center;
  gap: var(--s2);
  width: 100%;
  /* 30px: the smallest a row can be and still be a hit target rather than a line of text. */
  min-height: 30px;
  padding: 0 var(--s2);
  border: 0;
  border-radius: var(--r-sm);
  background: none;
  color: var(--text-dim);
  font: inherit;
  font-size: var(--t-sm);
  text-align: left;
  cursor: pointer;
}

.pick__row:hover { background: var(--surface-raised); color: var(--text); }

.pick__no { color: var(--text-faint); font-family: var(--mono); font-size: var(--t-xs); }

.pick__title {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.pick--on .pick__title { color: var(--text); font-weight: 600; }
.pick__age { color: var(--text-faint); font-size: var(--t-xs); text-align: right; font-variant-numeric: tabular-nums; }

/*
 * A badge, and nothing of its own but the centring.
 *
 * It was `.u-badge`'s whole declaration list copied out - the height, the radius, the surface,
 * the colour, the size - minus the weight and the letter-spacing, so the comment count on a pool
 * row was a badge a little lighter than every other badge on the deck. focus.css says badges are
 * one thing; this was the one place that said otherwise.
 */
.pick__talk {
  justify-content: center;
  min-width: 22px;
  font-variant-numeric: tabular-nums;
}

/* Nothing said on it: possibly unspecified, which is worth seeing before taking it. */
.pick__talk--quiet { background: transparent; color: var(--text-faint); }

.pick__more {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--s2);
  padding: var(--s2) var(--s2) var(--s3) calc(var(--pick-no) + var(--s2));
}

.pick__untagged { color: var(--text-faint); font-size: var(--t-xs); font-style: italic; }
.pick__take { margin-left: auto; }
.pick__link { color: var(--text-muted); font-size: var(--t-xs); text-decoration: none; }
.pick__link:hover { color: var(--text); text-decoration: underline; }
</style>
