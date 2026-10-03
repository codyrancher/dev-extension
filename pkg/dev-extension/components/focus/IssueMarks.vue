<script setup lang="ts">
/**
 * The four facts that decide whether an issue is worth starting, on one line.
 *
 * Which area of the dashboard it is (its labels), how old it is, how much has been said on it,
 * and whether somebody already has it. CardPool drew exactly these for every issue it offers,
 * and the card about a *single* issue drew none of them - so the browsing card was richer than
 * the one asking you to commit a workspace to the thing. Both read this now.
 *
 * The tag cleaning is shared too (`issueTags`): this repository labels nearly everything
 * `kind/bug` and `area/...`, and the area is the useful half.
 */
import { computed } from 'vue';
import { issueTags } from '../../focus-artifacts';
import type { PoolIssue } from '../../focus-artifacts';

const props = defineProps<{
  issue: PoolIssue;
  /**
   * The fact the card's lede already said. See `claimed` in FocusCard.
   *
   * On the start-fix cards the lede is the wait, so `1039d old` here was the third printing of
   * one number - under a header badge reading `waiting 1417 days` and a lede reading `1417 days
   * waiting`.
   */
  claimed?: string;
}>();

const tags = computed(() => issueTags(props.issue));
</script>

<template>
  <span class="marks u-fade-x">
    <span v-for="tag in tags" :key="tag" class="u-badge">{{ tag }}</span>
    <span v-if="!tags.length" class="marks__none">no labels</span>

    <span v-if="claimed !== 'waited'" class="marks__fact">{{ issue.age }}d old</span>
    <span class="marks__fact">
      {{ issue.comments || 'no' }} {{ issue.comments === 1 ? 'comment' : 'comments' }}
    </span>
    <!--
      Somebody *else* already has it: the one fact that makes "start the fix" the wrong button.

      It drew whenever `issue.assignee` was set, and these cards are built from the viewer's own
      assigned issues - so it said "codyrancher has it" on 6 of 6 of them, in `--warning`, to the
      person it was naming. `readArtifacts` takes the reader out of the list now (see `assignee` on
      PoolIssue); what is left is the case worth the colour, and "also" is why.
    -->
    <span v-if="issue.assignee" class="marks__taken">
      {{ issue.assignee }} {{ issue.mine ? 'also has it' : 'has it' }}
    </span>
  </span>
</template>

<style scoped>
/*
 * One line, cut with a fade rather than wrapped.
 *
 * These labels live in a SectionHead, and on the two start-fix cards whose issue carries four of
 * them (`bug eks QA/manual-tests …`) they wrapped the head to 42px against 26px everywhere else -
 * so the surface under it dropped from 93px to 78px, and two cards of the same kind gave the
 * issue's own words 16% less room than their neighbours because somebody had added a label. A
 * head's height is not the content's business.
 */
.marks {
  display: inline-flex;
  flex-wrap: nowrap;
  align-items: center;
  gap: var(--s2);
  /* The fade's own room; see `.u-fade-x` in design/focus.css. */
  padding-right: var(--s5);
  min-width: 0;
  overflow: hidden;
}

/*
 * Never squeezed - the one bug this view has had in four costumes, this time sideways.
 *
 * `flex-wrap: nowrap` on the row above stops the row wrapping; it does nothing about an item
 * being shrunk narrower than its own words. These three are text, so `flex-shrink: 1` made them
 * narrow and the text inside them wrapped instead: measured on the start-fix card, `.marks__fact`
 * came back 33px tall and `codyrancher has it` 50px - three lines of 11px text - which made the
 * SectionHead holding them 50px against 26px everywhere else, and took 24px off the issue's own
 * words. Pinned, the row overflows and `u-fade-x` says so, which is what the fade is for.
 */
.marks > * { flex: 0 0 auto; white-space: nowrap; }

.marks__fact { color: var(--text-faint); font-size: var(--t-xs); font-variant-numeric: tabular-nums; }
.marks__none { color: var(--text-faint); font-size: var(--t-xs); font-style: italic; }
.marks__taken { color: var(--warning); font-size: var(--t-xs); font-weight: 600; }
</style>
