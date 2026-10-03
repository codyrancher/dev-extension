<script setup lang="ts">
/**
 * What is on the branch, for work that has no pull request yet.
 *
 * The question this card asks is whether the work is ready to be shown to somebody, and the
 * commits are how you tell at a glance: six tidy messages is a change somebody can review, and
 * one commit called "wip" is not. So they are listed newest first with their author, because a
 * branch an agent wrote and a branch you wrote want different things from you next.
 */
import { computed } from 'vue';
import SectionHead from './SectionHead.vue';
import type { CardCommit } from '../../focus-artifacts';

const props = withDefaults(defineProps<{
  commits: CardCommit[];
  /** The fact the card's lede already said. See `claimed` in FocusCard. */
  claimed?: string;
  /**
   * When your review was given (ISO), for the card about what has happened since.
   *
   * The review-pushed card's whole subject is the commits that arrived after it, and the list was
   * every commit on the branch with nothing distinguishing them - so the second review was the
   * first review again. Marked rather than filtered: the commits you already read are the context
   * for the ones you have not, and a list that silently drops half of itself is worse than a list
   * that says which half is which.
   */
  since?: string;
}>(), { claimed: '', since: '' });

const at = computed(() => Date.parse(props.since || ''));

/** A commit with no parseable date counts as new, for the reason `fresh` in FocusCard gives. */
const isNew = (commit: CardCommit) => Number.isFinite(at.value) && !(Date.parse(commit.at) <= at.value);

const fresh = computed(() => props.commits.filter(isNew).length);

const when = (at: string) => {
  const ms = Date.now() - Date.parse(at || '');

  if (!Number.isFinite(ms)) {
    return '';
  }
  const hours = Math.round(ms / 3_600_000);

  return hours < 1 ? 'just now' : hours < 48 ? `${ hours }h` : `${ Math.round(hours / 24) }d`;
};
</script>

<template>
  <section class="cm">
    <!--
      No count where the lede is the count: `On the branch · 20 commits` sat 16px under a 36px
      `20 commits`, which is the same sentence twice in one glance.
    -->
    <SectionHead
      :label="since ? 'Since your review' : 'On the branch'"
      :count="claimed === 'commits' || claimed === 'fresh'
        ? (since ? `${ commits.length - fresh } you have read` : '')
        : `${ commits.length } commit${ commits.length === 1 ? '' : 's' }`"
    />

    <ol class="cm__list u-fade-y">
      <li
        v-for="commit in [...commits].reverse()"
        :key="commit.sha"
        class="cm__row"
        :class="{ 'cm__row--new': since && isNew(commit) }"
      >
        <code class="cm__sha">{{ commit.sha }}</code>
        <span class="cm__msg">{{ commit.message }}</span>
        <span class="cm__who">{{ commit.author }}</span>
        <span class="cm__when">{{ when(commit.at) }}</span>
      </li>
    </ol>
  </section>
</template>

<style scoped>
/*
 * The surface, and it says so.
 *
 * It was drawn as a band above whatever surface the card had, and as a flex child of the card's
 * body with no floor it was the thing that gave: measured on the open-pr card, `.cm` was 0px tall
 * against a scrollHeight of 26 and `.cm__list` 589, so a heading announcing twenty commits sat
 * directly on top of the next heading with nothing between them. It is a rung of the surface
 * ladder now rather than a band - see `surface` in FocusCard - so it is either the whole surface
 * or it is not drawn, and a heading over nothing is no longer one of the outcomes.
 */
.cm {
  display: flex;
  flex-direction: column;
  gap: var(--s2);
  flex: 1 1 auto;
  min-height: 0;
  min-width: 0;
}



.cm__list {
  display: flex;
  flex-direction: column;
  gap: 1px;
  flex: 1 1 auto;
  /* Two rows is the least worth drawing a list for; below that the card would rather scroll. */
  min-height: 53px;
  margin: 0;
  /* The fade's own room; see `.u-fade-y` in design/focus.css. */
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
.cm__row {
  flex: 0 0 auto;
  display: grid;
  grid-template-columns: 62px minmax(0, 1fr) auto 34px;
  align-items: center;
  gap: var(--s2);
  min-height: 26px;
  padding: 0 var(--s2);
  border-radius: var(--r-sm);
  font-size: var(--t-sm);
}

.cm__row:hover { background: var(--surface-raised); }

/*
 * What arrived after your review, marked down its edge the way a selection is - the same treatment
 * `.cv__row--picked` gives the lines a comment points at, because it is the same claim.
 */
.cm__row--new {
  background: color-mix(in srgb, var(--kind) 10%, transparent);
  box-shadow: inset 3px 0 0 var(--kind);
}

.cm__row--new .cm__msg { color: var(--text); }
.cm__sha { color: var(--text-faint); font-family: var(--mono); font-size: var(--t-xs); }
.cm__msg { min-width: 0; overflow: hidden; color: var(--text-dim); text-overflow: ellipsis; white-space: nowrap; }
.cm__who { color: var(--text-faint); font-size: var(--t-xs); }
.cm__when { color: var(--text-faint); font-size: var(--t-xs); text-align: right; }
</style>
