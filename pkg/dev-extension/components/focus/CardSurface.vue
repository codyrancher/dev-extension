<script setup lang="ts">
/**
 * The eleven surfaces, where a card can reach them.
 *
 * These branches were the shell's. That made the shell the thing that decided what a card shows,
 * which is exactly the decision a card should own - and it meant a card held outside the bundle
 * had to redraw a surface rather than use the one that already existed. So the dispatch moved
 * here, and a card's module invokes it:
 *
 *     template: '<CardSurface surface="files" :api="api" />'
 *
 * A card that wants something none of the eleven are replaces that line with its own markup, and
 * composes the same pieces these branches do. Nothing is lost by moving it and the shell stops
 * having an opinion.
 *
 * `surface` is optional. Without it the ladder below picks, which is what the cards that never
 * named one have always relied on.
 */
import { computed, watch } from 'vue';
import type { CardSurface } from '../../focus';
import { subjectOf } from '../../focus-artifacts';
import type { CardApi } from './card-api';

import CardAgent from './CardAgent.vue';
import CardBumps from './CardBumps.vue';
import CardComments from './CardComments.vue';
import CardCommits from './CardCommits.vue';
import CardFacts from './CardFacts.vue';
import CardPool from './CardPool.vue';
import CardReviewers from './CardReviewers.vue';
import ChangeSet from './ChangeSet.vue';
import CheckList from './CheckList.vue';
import ReviewPass from './ReviewPass.vue';

const props = withDefaults(defineProps<{ api: CardApi; surface?: CardSurface }>(), { surface: '' });

const api = props.api;
const art = computed(() => api.artifacts.value);
const notes = computed(() => api.notes.value || []);
const task = computed(() => api.task.value);
const busy = computed(() => api.busy.value);
const claimed = computed(() => api.claimed.value);
/*
 * Whether this card is the one on top.
 *
 * The deck renders the cards behind the current one too, and a conversation on each of those
 * would be an exec into the agent pod every 1.5 seconds for a card nobody is looking at. The
 * shell already works this out for clicks; the chat reads it for polling.
 */
const interactive = computed(() => api.interactive.value !== false);
const reading = computed(() => api.reading.value === true);
const notesFailed = computed(() => api.notesFailed?.value === true);

/*
 * Which pull request this card is about.
 *
 * Handed to the `checks` surface so it can read the output of the five failing checks whose logs
 * were not loaded with the card - one request, on the press that asks for it. Worked out here
 * rather than passed through the artifacts because it is a fact about the *task*, which the
 * surface has no other reach into; `subjectOf` is the one place that parses `PR #19212`.
 */
const pr = computed(() => (task.value ? subjectOf(task.value).pr : 0));

function hasFor(which: CardSurface): boolean {
  const a = art.value;

  switch (which) {
  case 'agent':   return Boolean(a.agent);
  case 'pool':    return a.pool.length > 0;
  case 'bumps':   return a.bumps.length > 0;
  case 'facts':   return Boolean(a.advisory || a.bump);
  case 'pass':    return Boolean(notes.value.length);
  case 'talk':    return a.comments.length > 0;
  case 'files':   return a.files.length > 0;
  case 'commits': return a.commits.length > 0;
  case 'checks':  return Boolean(a.ci?.failing);
  case 'who':     return Boolean(a.reviewers);
  /*
   * True, and it draws nothing here on purpose.
   *
   * `said` means the card's body IS the issue's own words, and the shell draws those above this
   * component. If this returned false the card would fall to the ladder, which is the fault the
   * `surface` field was added to stop: start-fix asks for `comments` to get the screenshot the
   * issue is about, and the ladder would hand it `talk` - the comments instead of the words.
   */
  case 'said':    return true;
  default:        return false;
  }
}

const ladder = computed<CardSurface>(() => {
  // An agent waiting on an answer beats everything: it is the highest thing in the queue, and
  // the answer is on the card.
  if (art.value.agent) {
    return 'agent';
  }
  // The pool next: it is the whole of its card, and that card has nothing else.
  if (art.value.pool.length) {
    return 'pool';
  }
  // The bumps, for the same reason: the list is the card.
  if (art.value.bumps.length) {
    return 'bumps';
  }
  // The few facts a bump or an advisory is decided on, for the two cards that had no surface.
  if (art.value.advisory || art.value.bump) {
    return 'facts';
  }
  if (notes.value.length) {
    return 'pass';
  }
  if (art.value.comments.length) {
    return 'talk';
  }
  if (art.value.files.length) {
    return 'files';
  }
  /*
   * The commits, as a surface rather than as a band above one.
   *
   * They were drawn above the surface on any card that asked for them, and the card is not wide
   * enough for two things: measured on the open-pr card, `.cm` came out 0px tall against a
   * scrollHeight of 26 and `.cm__list` 589 - so "On the branch · 20 commits" sat directly on top
   * of "What it changed" with nothing at all between the two headings. A heading over nothing is
   * worse than no heading, and the count it was announcing is already this card's 36px lede.
   *
   * So they are a rung like everything else: the surface of the card whose subject is a branch
   * with no pull request, and invisible on the cards that have a diff to read instead.
   */
  if (art.value.commits.length) {
    return 'commits';
  }

  /*
   * Last, which is where it belongs: who is looking at it is the surface of the one card that
   * has nothing else - the one about nobody looking at it, which asks for `reviewers` and no
   * diff. It used to be tested above the diff and the talk, which was harmless only for as
   * long as that was the single card asking: the moment the approved-pull-request card wanted
   * to name its approver, asking for `reviewers` would have replaced its diff with a reviewer
   * list. Who approved it is a fact about the work, so it goes in the evidence band instead -
   * see CardEvidence - and this rung is left to the card it was written for.
   */
  return art.value.reviewers ? 'who' : '';
});

/**
 * What it was told to draw, when there is anything to draw it from; otherwise the ladder's pick.
 *
 * Told by the prop, or by the card's own `surface` field when the prop is absent - which is how
 * the nineteen ported cards work: each declares `surface` once in its module and its template is
 * the same `<CardSurface :api="api" />` line. A bespoke card passes the prop to override it.
 */
const named = computed<CardSurface>(() => props.surface || task.value?.card?.surface || '');

/*
 * Surfaces that would rather say they are empty than hand the slot to something else.
 *
 * The rule below is "draw what you were told to, if there is anything to draw it from" - right
 * for almost all of them, because a card that asked for a diff and has none is better served by
 * whatever it does have. `pass` is the exception, and it was already written as one: there is an
 * empty state for it in the template, with a comment about a card being "a title, a footer, and
 * a hole between them". It could never appear. `hasFor('pass')` is false with no notes, so a
 * review card with none fell to the ladder - and a review card wants `notes`, `stat` and
 * `media`, so every rung of that ladder is empty too and `shown` came out ''. The card drew
 * nothing, which is the hole the comment describes.
 *
 * A review card with no findings is a real state, not a missing one: the stage that put it in
 * the deck is the workspace's, and an agent can reach it having left a review body and no
 * line-by-line notes at all. That card has something to say and should keep the space to say
 * it, under a footer offering to post a review.
 */
const SPEAKS_WHEN_EMPTY: CardSurface[] = ['pass'];

const shown = computed<CardSurface>(() => (
  named.value && (hasFor(named.value) || SPEAKS_WHEN_EMPTY.includes(named.value))
    ? named.value
    : ladder.value
));

/* The frame needs to know what the body chose; see `api.shell.showing`. */
watch(shown, (which) => api.shell.showing(which), { immediate: true });
</script>

<template>
  <!--
    No wrapper element. A surface is the card's body, and a div around it would be one more
    bounded flex parent between the card and the thing that has to scroll inside it - which is
    the shape of four separate overlap faults in this view's history.
  -->
      <!-- What the agent is asking, with its own choices as the buttons. -->
      <CardAgent
        v-if="shown === 'agent' && art.agent"
        :agent="art.agent"
        :busy="busy"
        :workspace="task.workspace"
        :live="interactive"
        @answer="api.emit('answer', $event)"
      />

      <!--
        What is failing, and what it printed, for the card whose whole subject is a red build.

        `red-pr` wants `checks`, `stat` and `files` and the surface ladder had a rung for `files`
        only, so the card headed "6 of 46 checks failing" drew a 45-file diff and the three red
        e2e suites were readable in a 26px popover and nowhere else. The names and their own
        one-line reports were already on the card. The diff stays one press away on "Open it".

        And then the names were not enough either: `e2e-test (admin, @adminUser, @explorer2)` is
        not something anybody decides anything on. `report` is the failing output of one of them -
        see `CardArtifacts.report` - and `pr` is how CheckList reads the others on a press.
      -->
      <CheckList
        v-else-if="shown === 'checks' && art.ci"
        surface
        :checks="art.checks"
        :failing="art.ci.failing"
        :report="art.report"
        :pr="pr"
        :claimed="claimed"
      />

      <!-- The facts a bump or an advisory is decided on. -->
      <CardFacts
        v-else-if="shown === 'facts'"
        :advisory="art.advisory"
        :bump="art.bump"
        :claimed="claimed"
      />

      <!-- Work to choose from, when nothing is waiting on you. -->
      <CardPool
        v-else-if="shown === 'pool'"
        :pool="art.pool"
        :busy="busy"
        @take="api.emit('take', $event)"
        @ask="api.emit('about-issue', $event)"
      />

      <!-- Every bump nobody has reviewed, one row each. See CardBumps. -->
      <CardBumps
        v-else-if="shown === 'bumps'"
        :bumps="art.bumps"
        :busy="busy"
        :claimed="claimed"
        @merge="api.emit('merge-bump', $event)"
        @ask="api.emit('about-bump', $event)"
      />

      <!-- Who has it, when that is the thing that is missing. -->
      <CardReviewers
        v-else-if="shown === 'who' && art.reviewers"
        :reviewers="art.reviewers"
        :busy="busy"
        @ask="api.emit('ask-reviewer', $event)"
      />

      <!--
        The agent's review, when there is one waiting: the substance of a review card.

        ReviewPass draws nothing at all without a note to select, so a card whose notes had not
        arrived yet - or whose read of them failed, which a dev-api restart does for twenty
        seconds at a time - was a title, a footer, and a hole between them. Which of the three
        it is beats an empty space that reads as a broken card.

        Three, not two. The one this was missing is the ordinary one: the read worked and the
        agent left no line-by-line findings - it reviewed by writing a body, or by recording
        what it did. Saying "could not be read" there is wrong in a way that sends somebody
        looking for a fault that is not there, which is why `notesFailed` is carried down from
        the page rather than inferred from the empty list that both cases produce.
      -->
      <p v-else-if="shown === 'pass' && !notes.length" class="surface__none">
        <template v-if="reading">Reading the review…</template>
        <template v-else-if="notesFailed">The review could not be read just now. It is on the pull request; opening it is the way through.</template>
        <template v-else>No line-by-line findings on this one. Whatever the agent left is on the pull request itself — opening the review is the way through.</template>
      </p>

      <ReviewPass
        v-else-if="shown === 'pass'"
        :notes="notes"
        @kept="api.shell.keeping($event)"
        @select="api.shell.selected($event)"
        @expand="api.emit('expand', $event)"
        @resolve="api.emit('resolve', $event)"
        @ask="api.emit('discuss', $event)"
      />

      <!-- Or the change itself, file by file, when reading it is the job. -->
      <ChangeSet
        v-else-if="shown === 'files'"
        :files="art.files"
        :total="art.stat?.files || 0"
        :busy="busy"
        :claimed="claimed"
        :workspace="task.workspace || ''"
        :pr="pr"
        :live="interactive"
        :comments="art.comments || []"
        @ask="api.emit('ask-code', $event)"
        @expand="api.emit('expand', $event)"
      />

      <!-- What is on the branch, for the card whose subject is a branch with no pull request. -->
      <!-- What is on the branch - and, for the second look, which of it is new. See `fresh`. -->
      <CardCommits
        v-else-if="shown === 'commits'"
        :commits="art.commits"
        :claimed="claimed"
        :since="task.newSince || ''"
      />

      <!-- Or what people said about it, when answering them is the job. -->
      <CardComments
        v-else-if="shown === 'talk'"
        :comments="art.comments"
        :busy="busy"
        @reply="api.emit('reply', $event)"
        @expand="api.emit('expand', $event)"
      />
</template>

<style scoped>
/* A surface with nothing in it says so, rather than leaving a hole in the card. */
.surface__none {
  margin: 0;
  padding: var(--s4) 0;
  color: var(--text-muted);
  font-size: var(--t-sm);
}
</style>
