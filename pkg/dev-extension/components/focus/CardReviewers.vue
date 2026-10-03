<script setup lang="ts">
/**
 * Who should look at this, with the asking on the row.
 *
 * The state a pull request of yours gets stuck in most quietly: open, green, and nobody asked -
 * so nothing is happening to it and nothing ever will. GitHub shows this as an empty space in the
 * sidebar, which is easy to not see for a week, or for the 928 days the live deck's worst one has
 * been sitting there.
 *
 * **It used to end in an apology.** Measured: 98px of content in a 195px body, the last 72px of it
 * the sentence "Nobody has commented on it either, so there is no obvious person to ask. Open it on
 * GitHub and pick from the reviewers it suggests", under a footer whose primary button was "Open it
 * on GitHub". A surface that restates the button under it is worth less than no surface, and the
 * card whose entire job is "who should review this" could only ever tell you to go and do it
 * somewhere else. `reviewersOf` builds candidates that can exist on this card's own kind of work
 * now; what is left here is to put the press on the row beside the reason.
 *
 * So, in this order and nothing else: who to ask, one press each; then who has it already. Not the
 * diff - you are not reviewing it, you are finding a reviewer - and how long it has been open is
 * the card's lede, set at 36px by FocusCard, rather than a pill in the corner.
 */
import { computed } from 'vue';
import AppButton from './AppButton.vue';
import AppIcon from './AppIcon.vue';
import SectionHead from './SectionHead.vue';
import type { Reviewers } from '../../focus-artifacts';

const props = defineProps<{ reviewers: Reviewers; busy?: boolean }>();

const emit = defineEmits<{ (e: 'ask', who: string): void }>();

const silent = computed(() => props.reviewers.asked.filter((who) => !props.reviewers.approved.includes(who)));
const nobody = computed(() => !props.reviewers.asked.length && !props.reviewers.approved.length);

/**
 * What the head says instead of a paragraph.
 *
 * The one fact the removed sentence was carrying - that nothing has happened to this yet - said in
 * four words beside the title rather than in seventy under it.
 */
const standing = computed(() => {
  if (!nobody.value) {
    return '';
  }

  return props.reviewers.suggested.length ? 'nobody asked yet' : 'nobody asked, nobody has commented';
});
</script>

<template>
  <section class="rv">
    <SectionHead label="Who to ask" icon="tasks" :count="standing" />

    <!-- The useful half: who, why them, and the press. One row each, nothing else on it. -->
    <ul
      v-if="reviewers.suggested.length"
      class="rv__list u-fade-y"
      :class="{ 'rv__list--few': reviewers.suggested.length < 3 }"
    >
      <li v-for="candidate in reviewers.suggested" :key="candidate.who" class="who-row">
        <span class="who-row__who">
          <span class="who-row__name">{{ candidate.who }}</span>
          <span class="who-row__why">{{ candidate.why }}</span>
        </span>
        <AppButton
          variant="ghost"
          size="sm"
          :busy="busy"
          :title="`Ask ${ candidate.who } for a review`"
          @click="emit('ask', candidate.who)"
        >Ask</AppButton>
      </li>
    </ul>

    <!-- Who has it already. Asked-and-silent is the middle group and the one that matters: an
         approver is done with it, and somebody asked four days ago who has said nothing is the
         reason this is not merged. -->
    <div v-if="reviewers.approved.length" class="rv__group">
      <span class="rv__label">Approved</span>
      <span v-for="who in reviewers.approved" :key="who" class="u-pill who who--yes">
        <AppIcon name="check" :size="11" />{{ who }}
      </span>
    </div>

    <div v-if="silent.length" class="rv__group">
      <span class="rv__label">Asked, no answer</span>
      <span v-for="who in silent" :key="who" class="u-pill who who--waiting">{{ who }}</span>
    </div>
  </section>
</template>

<style scoped>
.rv {
  display: flex;
  flex-direction: column;
  gap: var(--s3);
  flex: 1 1 auto;
  min-height: 0;
  min-width: 0;
}

/*
 * The rows take the room, and the room is the point: the body was 195px tall with 98px of content
 * in it, so a third of this card was nothing at all with the footer's rule 98px below the last line
 * of text.
 */
.rv__list {
  display: flex;
  flex-direction: column;
  gap: var(--s1);
  flex: 1 1 auto;
  min-height: 0;
  margin: 0;
  /* The fade's own room; see `.u-fade-y` in design/focus.css. */
  padding: 0 var(--s2) var(--s5) 0;
  list-style: none;
  overflow: hidden auto;
}

/*
 * Two or fewer: the rows take the room rather than leaving a hole under them.
 *
 * Measured on the live card: two candidates in a 173px surface is 2x44 + 26 of head + the gaps =
 * 110px, and the remaining ~63px was an unexplained gap between the last reviewer and the footer's
 * rule - `.rv__list` is `flex: 1 1 auto` with nothing to fill it. The row grows, and `why` - the
 * reason to ask somebody, which is the actual information on this card and was its quietest line
 * at 11px ellipsised - gets two lines of it.
 */
.rv__list--few .who-row { min-height: 56px; }

.rv__list--few .who-row__why {
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  font-size: var(--t-sm);
  line-height: 1.4;
  white-space: normal;
}

/* Never squeezed: the one bug this view has had in four costumes. See SectionHead. */
.who-row {
  display: flex;
  align-items: center;
  flex: 0 0 auto;
  gap: var(--s3);
  min-height: 44px;
  padding: 0 var(--s2) 0 var(--s3);
  border-radius: var(--r-sm);
  background: var(--surface-sunk);
}

.who-row:hover { background: var(--surface-raised); }

.who-row__who { display: flex; flex-direction: column; gap: 2px; flex: 1 1 auto; min-width: 0; }

.who-row__name {
  color: var(--text);
  font-size: var(--t-md);
  font-weight: 560;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Why them, which is the half that makes the row a decision rather than a name. */
.who-row__why {
  color: var(--text-muted);
  font-size: var(--t-xs);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.rv__group {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  flex: 0 0 auto;
  gap: var(--s2);
  min-width: 0;
}

.rv__label {
  min-width: 11ch;
  color: var(--text-faint);
  font-size: var(--t-xs);
}

/* `.u-pill` carries the box; a reviewer chip is a border and a name. It was 24px and 10px of
   padding - a fourth height and a sixth padding for "a small rounded label". */
.who {
  border: 1px solid var(--border);
  color: var(--text-dim);
}

.who--yes { border-color: color-mix(in srgb, var(--success) 38%, transparent); color: var(--success); }
.who--waiting { border-style: dashed; color: var(--text-muted); }
</style>
