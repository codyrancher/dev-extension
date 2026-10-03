<script setup lang="ts">
/**
 * Every bump nobody has looked at, as one list.
 *
 * Eleven of the deck's thirty-six turns were dependency bumps, and nine of them measured
 * byte-identical geometry - the same head, the same body, the same four buttons, `Merge it /
 * Open the pull request / Is it safe? / Later` - with two pairs that were literally the same
 * bump twice. Turning the same card nine times is how a queue teaches people to stop turning it.
 *
 * So the bumps are built the way the pool of unassigned issues already was: one card, one row
 * each, and the decision on the row. Three things decide a bump and all three fit on a line -
 * which package, the jump, and whether the build is green - and the fourth column is the press.
 * A row is 30px, so eleven of them fit in the body's 290px with the header, and the whole thing
 * is read in one go instead of nine.
 *
 * Every number here comes off the bot's own pull request list and nothing else. That is not an
 * accident of plumbing: the single bump card drew its byline from that list and its check badge
 * from the pull request's check runs, so ten of the eleven showed two different failing counts at
 * once - "6 checks failing" next to "1 failing, 44 passed" - under a button offering to merge.
 */
import { computed } from 'vue';
import AppButton from './AppButton.vue';
import AppIcon from './AppIcon.vue';
import SectionHead from './SectionHead.vue';
import type { BumpRow } from '../../focus-artifacts';

const props = defineProps<{
  bumps: BumpRow[];
  busy?: boolean;
  /**
   * The fact the card's 36px lede already said. See `claimed` in FocusCard.
   *
   * The lede is `0 of 9 ready to merge`; this head read `9 bumps · 1 green, 1 of them major` under
   * it, and the summary above it read `1 green, 8 not`. CardCommits and CardPool have both dropped
   * their count this way; this was the third list that had not been told.
   */
  claimed?: string;
}>();

const emit = defineEmits<{
  (e: 'merge', row: BumpRow): void;
  (e: 'ask', row: BumpRow): void;
}>();

const green = computed(() => props.bumps.filter((row) => row.state === 'green'));

/**
 * What the primary button will actually take, which is not every green one.
 *
 * The single-bump card has always said "crosses a major - a major version can change or remove
 * what this repository uses, worth reading the changelog before merging", and this card merged a
 * pile without reading. On the live pile the one green row was `ts-node 8.10.2 → 10.9.2`, a major,
 * and it was exactly what "Merge the green ones" merged. See `mergeTheGreenOnes` in Focus.vue,
 * which skips them for the same reason and says which it skipped.
 */
const safe = computed(() => green.value.filter((row) => !row.major));

/** What the row's dot is saying, in words, for the title attribute and for a screen reader. */
function says(row: BumpRow): string {
  if (row.state === 'green') {
    return 'the build is green';
  }

  return row.state === 'failing' ? `${ row.failing } failing` : 'still running';
}
</script>

<template>
  <section class="bumps">
    <!--
      No count where the lede is the count: `0 of 9 ready to merge` says how many there are.

      The hint stays, and it is the one framing of the nine that the lede cannot give: how many are
      green, and how many of *those* cross a major - which is the whole reason the lede says 0 when
      two other lines on the card said 1.
    -->
    <SectionHead
      label="Dependency bumps"
      icon="tasks"
      :count="claimed === 'bumps' ? '' : `${ bumps.length } bumps`"
    >
      <span class="bumps__hint">
        {{ green.length }} green<template v-if="green.length > safe.length">, {{ green.length - safe.length }} of them major</template>
      </span>
    </SectionHead>

    <ol class="bumps__list u-fade-y">
      <li
        v-for="row in bumps"
        :key="row.number"
        class="bump"
        :title="`${ row.package } ${ row.from || '?' } → ${ row.to || '?' }${ row.major ? ' (crosses a major)' : '' }`"
      >
        <span class="bump__dot" :class="`bump__dot--${ row.state }`" :title="says(row)" />
        <span class="bump__pkg">{{ row.package }}</span>
        <!--
          Three cells, because one of them is a glyph the eye scans down the list.

          It was a single span - `{{ from }} -> {{ to }}` - in an `auto` grid track, so the track
          was as wide as the longest pair and the span was right-aligned inside the row: measured
          down one list, the arrow's left edge was at 583, 536, 536, 542 and 556. Five x positions
          over nine rows for the one character that says what a bump is. `from` right-aligned, the
          arrow centred in its own 14px track, `to` left-aligned: one arrow column, nine rows.
        -->
        <span class="bump__from">{{ row.from || '?' }}</span>
        <span class="bump__arrow" aria-hidden="true">→</span>
        <span class="bump__to">{{ row.to || '?' }}</span>
        <!-- The deciding fact, on the row that is acted on without reading. -->
        <span class="bump__major">{{ row.major ? 'major' : '' }}</span>
        <span class="bump__age">{{ row.age }}d</span>

        <!-- Which pull request it is: the thing that was missing when two cards said the same
             package and the same two versions. -->
        <a class="bump__no" :href="row.url" target="_blank" rel="noopener" :title="`Open #${ row.number }`">#{{ row.number }}</a>

        <!--
          `ghost`, not `kind`.
          
          The card's own 44px primary is the bulk merge (see focus.ts, which promotes it the moment
          anything is actually mergeable), and two things in the card's hue on one surface is two
          primaries. This is the per-row version of that act and it reads as one.
        -->
        <AppButton
          v-if="row.state === 'green'"
          variant="ghost"
          size="sm"
          :busy="busy"
          @click="emit('merge', row)"
        >Merge</AppButton>
        <AppButton
          v-else
          variant="quiet"
          size="sm"
          icon="sparkle"
          :title="says(row)"
          @click="emit('ask', row)"
        >{{ row.state === 'failing' ? `${ row.failing } failing` : 'running' }}</AppButton>
      </li>
    </ol>
  </section>
</template>

<style scoped>
/* The surface takes the room it is given; see the budget on `.card__body`. */
.bumps {
  display: flex;
  flex-direction: column;
  gap: var(--s3);
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
}

.bumps__hint { margin-left: auto; color: var(--text-faint); font-size: var(--t-xs); }

.bumps__list {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-height: 0;
  margin: 0;
  /* The fade's own room; see `.u-fade-y` in design/focus.css. The ninth row of this list was
     bisected horizontally at the body's bottom edge with nothing to say there was a tenth. */
  padding: 0 var(--s2) var(--s5) 0;
  list-style: none;
  overflow: hidden auto;
}

/*
 * Never squeezed: a flex item in a scrolling column shrinks below its content by default, which
 * is the one bug this view has had in four costumes - the card header, the footer, the file tree,
 * the pool. The column scrolls; the row keeps its height.
 */
.bump {
  display: grid;
  /*
   * dot | package | from | -> | to | major | age | # | the press
   *
   * Fixed tracks for the three jump cells and for the button, not `fr` and `auto`.
   *
   * Each row is its own grid, so an `fr` resolves against what that row's `auto` tracks took - and
   * the trailing track holds either `Merge` (64px) or `6 failing` (82px). Measured with `1fr`
   * cells: the arrow's left edge was 537 on the one green row and 510 on the other eight, which is
   * the same misalignment one step smaller. A column somebody scans down is a column.
   */
  grid-template-columns: 8px minmax(0, 1fr) 72px 14px 72px 44px 30px 48px 88px;
  align-items: center;
  gap: var(--s2);
  flex: 0 0 auto;
  min-height: 30px;
  padding: 0 var(--s2);
  border-radius: var(--r-sm);
  color: var(--text-dim);
  font-size: var(--t-sm);
}

.bump:hover { background: var(--surface-raised); }

.bump__dot {
  width: 8px;
  height: 8px;
  border-radius: var(--r-pill);
  background: var(--text-faint);
}

.bump__dot--green { background: var(--success); }
.bump__dot--failing { background: var(--danger); }
.bump__dot--pending { background: var(--warning); }

.bump__pkg {
  min-width: 0;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.bump__from,
.bump__arrow,
.bump__to {
  min-width: 0;
  overflow: hidden;
  color: var(--text-muted);
  font-family: var(--mono);
  font-size: var(--t-xs);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.bump__from { text-align: right; }
.bump__arrow { color: var(--text-faint); text-align: center; }
.bump__to { color: var(--text-dim); text-align: left; }

/* A column of its own rather than a suffix on the jump, so the word lines up down the list and a
   pile with one major in it can be read without reading the versions. */
.bump__major { color: var(--danger); font-size: var(--t-xs); font-weight: 650; }

.bump__age { color: var(--text-faint); font-size: var(--t-xs); text-align: right; font-variant-numeric: tabular-nums; }

.bump__no {
  display: inline-flex;
  align-items: center;
  justify-content: flex-end;
  /* The row's own height: it is a link people press, and a 17px target in a 30px row is a miss. */
  height: 30px;
  color: var(--text-faint);
  font-family: var(--mono);
  font-size: var(--t-xs);
  text-align: right;
  text-decoration: none;
}

.bump__no:hover { color: var(--text); text-decoration: underline; }
</style>
