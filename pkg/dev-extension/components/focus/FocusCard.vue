<script setup lang="ts">
/**
 * One thing waiting on you, as the card that nearly fills the page.
 *
 * The card owns its hue: `--kind` and `--kind-wash` are set here from the card definition's
 * kind, and everything inside - the chip, the primary button, the rule under the header, the
 * glow behind the card - reads them. That is what makes a deck legible while it is still
 * moving: the colour arrives before the words do.
 *
 * The body is composed rather than switched: a card draws the parts its task has, so a new kind
 * of work needs a definition (focus.ts) and not a new component. What a button does is the
 * definition's too - the card only says which one was pressed.
 *
 * What it has is `artifacts` - the things somebody would have gone and looked up before deciding
 * (see focus-artifacts.ts). A band of evidence across the top, and under it the one surface this
 * kind of work is actually about: the agent's review to pass over, the change to read, the
 * comments to answer, or the issue's own words. A card with none of them is still a card; it just
 * says less, which is honest for work that has nothing to show yet.
 */
import { computed, ref, watch } from 'vue';
import type { FocusTask, CardAction } from '../../focus';
import AppButton from './AppButton.vue';
import KindChip from './KindChip.vue';
import StatPill from './StatPill.vue';
import AppIcon from './AppIcon.vue';
import ReviewPass from './ReviewPass.vue';
import ChangeSet from './ChangeSet.vue';
import CardComments from './CardComments.vue';
import CardEvidence from './CardEvidence.vue';
import CardPool from './CardPool.vue';
import CardReviewers from './CardReviewers.vue';
import CardCommits from './CardCommits.vue';
import CardAgent from './CardAgent.vue';
import CardFacts from './CardFacts.vue';
import { NO_ARTIFACTS } from '../../focus-artifacts';
import type { CardArtifacts, CardComment, PoolIssue } from '../../focus-artifacts';
import type { ReviewNote } from '../../focus-review';

const props = defineProps<{
  task: FocusTask;
  interactive?: boolean;
  busy?: boolean;
  /** Pinned tasks sit beside the deck rather than in it; the card says so and offers the way back. */
  pinned?: boolean;
  /**
   * The agent's comments, when this card's work is a review waiting for a pass.
   *
   * The card is where the pass happens rather than somewhere the card sends you: a comment
   * carries the lines it is about, so the judgement can be made here. See focus-review.ts; the
   * page loads them for the card on top and nothing else.
   */
  notes?: ReviewNote[];
  /**
   * Everything else this card's work has to show, read for the card on top and nothing else.
   *
   * Empty is the normal state for all but one card at a time, and an empty one draws nothing
   * rather than drawing a frame around nothing. See focus-artifacts.ts for what a card asks for
   * and Focus.vue for the one place that asks.
   */
  artifacts?: CardArtifacts;
}>();

const emit = defineEmits<{
  (e: 'act', action: CardAction): void;
  (e: 'ask'): void;
  (e: 'pin'): void;
  (e: 'resolve', value: { note: ReviewNote; verdict: string; body?: string }): void;
  (e: 'discuss', value: { note: ReviewNote; text: string }): void;
  (e: 'ask-code', value: { path: string; label: string; code: string; text: string }): void;
  (e: 'reply', value: { comment: CardComment }): void;
  (e: 'expand', value: { path: string; mark: [number, number] }): void;
  (e: 'take', issue: PoolIssue): void;
  (e: 'about-issue', issue: PoolIssue): void;
  (e: 'ask-reviewer', who: string): void;
  (e: 'answer', value: { key: string; label: string }): void;
  (e: 'workspace'): void;
  (e: 'make-workspace'): void;
}>();

/**
 * The comment the pass is on, when the card is a pass.
 *
 * It decides what the evidence band shows. A review card's workspace holds everything every
 * comment was built from - eight recordings, of which one belongs to the comment you are reading
 * - so the band was showing the workspace rather than the comment, which is a different claim and
 * the wrong one. Pick a comment and the band is that comment's.
 */
const noteOn = ref<ReviewNote | null>(null);

watch(() => props.notes, (found) => { noteOn.value = found?.[0] || null; }, { immediate: true });

const art = computed<CardArtifacts>(() => {
  const base = props.artifacts || NO_ARTIFACTS;

  if (surface.value !== 'pass' || !noteOn.value) {
    return base;
  }

  return {
    ...base,
    media: noteOn.value.media.map((item) => ({
      kind: item.kind, label: item.label, src: item.src, caption: item.caption, at: '',
    })),
  };
});

/** Waiting long enough that somebody is being held up by it. */
const overdue = computed(() => props.task.waitingHours >= 48);

/**
 * Whether a workspace could be made for this at all.
 *
 * Only where there is something to make one from: a pull request to review, or an issue to fix.
 * A bump, an advisory or a hand-written task has nothing a checkout could be of, and an offer
 * that cannot be taken is worse than no offer.
 */
const canMakeOne = computed(() => /#\d+/.test(props.task.what)
  && props.task.card.actions.some((action) => action.verb === 'review' || action.verb === 'fix'));

/** The first action is the one the card is built around; the rest are quieter. */
const primary = computed(() => props.task.card.actions[0] || null);
const rest = computed(() => props.task.card.actions.slice(1));

/**
 * Which of the four surfaces this card is built around, or none.
 *
 * In the order a card is worth reading in: an agent's review waiting for a pass beats the change
 * it is about, the change beats the talk about it, and an issue with none of those has its own
 * words. One at a time, because each of them wants most of the card.
 */
const surface = computed<'agent' | 'pool' | 'facts' | 'pass' | 'who' | 'talk' | 'files' | 'prose' | ''>(() => {
  // An agent waiting on an answer beats everything: it is the highest thing in the queue, and
  // the answer is on the card.
  if (art.value.agent) {
    return 'agent';
  }
  // The pool next: it is the whole of its card, and that card has nothing else.
  if (art.value.pool.length) {
    return 'pool';
  }
  // The few facts a bump or an advisory is decided on, for the two cards that had no surface.
  if (art.value.advisory || art.value.bump) {
    return 'facts';
  }
  if (props.notes?.length) {
    return 'pass';
  }
  // Who is looking at it beats the diff on a card about nobody looking at it.
  if (art.value.reviewers) {
    return 'who';
  }
  if (art.value.comments.length) {
    return 'talk';
  }
  if (art.value.files.length) {
    return 'files';
  }

  return art.value.body ? 'prose' : '';
});

/**
 * A card with a surface on it is laid out differently.
 *
 * The surface needs most of the card's height to be worth having, so everything above it gives
 * some up: a smaller title, and the line of prose about why this is here dropped - the line
 * under the title already says what it is.
 */
const hasPass = computed(() => surface.value !== '');

/**
 * The action that has been pressed once and is waiting to be meant.
 *
 * Posting a review and merging leave this cluster, and the whole motion of this view is pressing
 * the big button and moving on - so those two take two presses. Cleared when the card changes,
 * because a half-pressed button that survives the deck turning is a trap.
 */
const confirming = ref('');

watch(() => props.task.key, () => { confirming.value = ''; });

function press(action: CardAction) {
  if (action.confirm && confirming.value !== action.label) {
    confirming.value = action.label;

    return;
  }
  confirming.value = '';
  emit('act', action);
}

const labelOf = (action: CardAction) => (confirming.value === action.label ? `${ action.label } — sure?` : action.label);

/** How far through the agent's comments you are, shown beside the card's own button. */
const pass = ref<{ settled: number; total: number; keeping: number } | null>(null);

/** Days, where hours stop being a number anybody reads. */
const waited = computed(() => (props.task.waitingHours >= 48
  ? `${ Math.round(props.task.waitingHours / 24) } days`
  : `${ props.task.waitingHours }h`));
</script>

<template>
  <article
    class="card"
    :class="[`card--${ task.card.kind }`, { 'card--flat': !interactive, 'card--pass': hasPass }]"
  >
    <div class="card__glow" aria-hidden="true" />
    <div class="card__glow card__glow--foot" aria-hidden="true" />
    <div class="card__band" aria-hidden="true" />

    <header class="card__head">
      <!--
        One line: what this is on the left, and the one control the header owns on the right.
        Nothing in the middle claims the space between them - the pin does, which is what keeps
        the right edge of the header the right edge of the card whether or not the badge is
        there. It was the badge claiming it, so a card with nothing overdue drew its pin halfway
        along the line.
      -->
      <div class="card__head-line">
        <!--
          First in the line, which is the card's top-left corner: what it does is to the whole
          card. In the line rather than floated over it, so nothing underneath has to be
          indented past it by a number nobody can derive.
        -->
        <button
          v-if="interactive"
          type="button"
          class="card__pin"
          :class="{ 'card__pin--on': pinned }"
          :title="pinned ? 'Put it back in the deck' : 'Keep it beside the deck'"
          :aria-pressed="pinned ? 'true' : 'false'"
          @click="emit('pin')"
        >
          <AppIcon name="pin" :size="13" />
        </button>
        <KindChip :kind="task.card.kind" />
        <span class="card__where">{{ task.what }}</span>

        <!--
          Where the work lives, or the offer to give it somewhere.
          
          It was a grey suffix on the line above - ` · lte-pr-19153` - which said which workspace
          but did nothing, and said nothing at all for the cards that have none. Those are the
          ones where it matters: a review somebody asked you for, an issue to pick up, a bump.
          Making the workspace is the first thing you would do and it was the one thing the card
          could not do.
        -->
        <button
          v-if="task.workspace"
          type="button"
          class="card__ws"
          :title="`Open ${ task.workspace }`"
          @click="emit('workspace')"
        >
          <AppIcon name="tasks" :size="11" />
          {{ task.workspace }}
        </button>
        <button
          v-else-if="canMakeOne"
          type="button"
          class="card__ws card__ws--none"
          title="Make a workspace for this and start"
          @click="emit('make-workspace')"
        >
          <AppIcon name="plus" :size="11" />
          No workspace
        </button>
        <span v-if="overdue" class="card__overdue">
          <AppIcon name="clock" :size="13" />
          waiting {{ waited }}
        </span>
      </div>

      <h2 class="card__title">{{ task.title || task.what }}</h2>
      <p class="card__summary">{{ task.needs }}</p>

      <div class="card__by">
        <span class="card__by-name">{{ task.summary }}</span>
      </div>
    </header>

    <div class="card__body">
      <!--
        The things you would have gone and looked up: the size of the change, what CI says, what
        is running on a link, what the agent recorded. Above the surface rather than inside it,
        because all four are true of the work whichever surface it has.
      -->
      <CardEvidence :artifacts="art" />

      <!--
        What is on the branch. Above the surface when there is one, and the surface itself when
        there is not - which is the case on the card whose subject is a branch with no pull
        request, where everything else a card reads comes off a pull request that does not exist.
      -->
      <CardCommits
        v-if="art.commits.length"
        :commits="art.commits"
        :class="{ 'card__only': surface === '' }"
      />

      <!-- Why this is in front of you at all, in the ranking's own words. -->
      <p v-if="task.about && !hasPass" class="card__prose">{{ task.about }}</p>

      <!-- What the agent is asking, with its own choices as the buttons. -->
      <CardAgent
        v-if="surface === 'agent' && art.agent"
        :agent="art.agent"
        :busy="busy"
        @answer="emit('answer', $event)"
      />

      <!-- The facts a bump or an advisory is decided on. -->
      <CardFacts
        v-else-if="surface === 'facts'"
        :advisory="art.advisory"
        :bump="art.bump"
      />

      <!-- Work to choose from, when nothing is waiting on you. -->
      <CardPool
        v-else-if="surface === 'pool'"
        :pool="art.pool"
        :busy="busy"
        @take="emit('take', $event)"
        @ask="emit('about-issue', $event)"
      />

      <!-- Who has it, when that is the thing that is missing. -->
      <CardReviewers
        v-else-if="surface === 'who' && art.reviewers"
        :reviewers="art.reviewers"
        :busy="busy"
        @ask="emit('ask-reviewer', $event)"
      />

      <!-- The agent's review, when there is one waiting: the substance of a review card. -->
      <ReviewPass
        v-else-if="surface === 'pass'"
        :notes="notes || []"
        @select="noteOn = $event"
        @expand="emit('expand', $event)"
        @progress="pass = $event"
        @resolve="emit('resolve', $event)"
        @ask="emit('discuss', $event)"
      />

      <!-- Or the change itself, file by file, when reading it is the job. -->
      <ChangeSet
        v-else-if="surface === 'files'"
        :files="art.files"
        :busy="busy"
        @ask="emit('ask-code', $event)"
        @expand="emit('expand', $event)"
      />

      <!-- Or what people said about it, when answering them is the job. -->
      <CardComments
        v-else-if="surface === 'talk'"
        :comments="art.comments"
        :busy="busy"
        @reply="emit('reply', $event)"
        @expand="emit('expand', $event)"
      />

      <!-- Or its own words: an issue, an advisory, a question the agent asked. -->
      <div v-else-if="surface === 'prose'" class="card__read">
        <p class="card__text">{{ art.body }}</p>
      </div>

      <div v-if="!hasPass" class="card__stats">
        <StatPill label="priority" :value="String(task.score)" />
        <StatPill v-if="task.waitingHours" label="waiting" :value="waited" />
        <StatPill v-if="task.workspace" label="workspace" :value="task.workspace" />
      </div>
    </div>

    <footer class="card__foot">
      <AppButton
        v-if="primary"
        variant="kind"
        size="lg"
        icon-after="arrow-right"
        :busy="busy"
        :class="{ 'card__sure': confirming === primary.label }"
        @click="press(primary)"
      >{{ labelOf(primary) }}</AppButton>

      <AppButton
        v-for="action in rest"
        :key="action.label"
        variant="ghost"
        size="lg"
        :class="{ 'card__sure': confirming === action.label }"
        @click="press(action)"
      >{{ labelOf(action) }}</AppButton>

      <span v-if="pass" class="card__pass">
        <strong>{{ pass.keeping }}</strong> of {{ pass.total }} kept
        <span v-if="pass.settled < pass.total" class="card__pass-left">· {{ pass.total - pass.settled }} still to decide</span>
      </span>

      <!--
        Only where the card does not already offer one: every definition's second action is an
        ask of its own, and two of them is a fourth button on a row that then wraps.
      -->
      <AppButton
        v-if="!task.card.actions.some((a) => a.verb === 'ask')"
        variant="quiet"
        size="lg"
        icon="sparkle"
        class="card__ask"
        @click="emit('ask')"
      >
        Ask about this
      </AppButton>
    </footer>
  </article>
</template>


<style scoped>
.card {
  position: relative;
  display: flex;
  flex-direction: column;
  height: 100%;
  /* The card may be narrower than the widest thing in it; see the deck's grid track. */
  min-width: 0;
  padding: clamp(var(--s5), 3.2vw, var(--s7));
  border: 1px solid var(--border);
  /* The hue closes the card at both ends, so a card reads as one object rather than as a
     coloured header with a page under it. */
  border-top: 1px solid color-mix(in srgb, var(--kind) 34%, var(--border));
  border-bottom: 1px solid color-mix(in srgb, var(--kind) 34%, var(--border));
  border-radius: var(--r-xl);
  background:
    linear-gradient(
      180deg,
      color-mix(in srgb, var(--kind) 7%, var(--surface)) 0%,
      var(--surface) 22%,
      var(--surface) 78%,
      color-mix(in srgb, var(--kind) 7%, var(--surface)) 100%
    );
  box-shadow: var(--shadow-card);
  overflow: hidden;
}

/* A card with the pass on it gives the header's room to the comments. */
.card--pass .card__title { font-size: clamp(var(--t-lg), 2vw, var(--t-xl)); }
.card--pass .card__summary { font-size: var(--t-sm); }
.card--pass .card__body { gap: var(--s3); }

.card__pass { margin-left: auto; color: var(--text-muted); font-size: var(--t-sm); }
.card__pass strong { color: var(--text); font-variant-numeric: tabular-nums; }
.card__pass-left { color: var(--text-faint); }

/* The hue, once, at the top of the component that owns it. */
.card--review   { --kind: var(--kind-review);   --kind-deep: var(--kind-review-deep);   --kind-wash: var(--kind-review-wash); }
.card--issue    { --kind: var(--kind-issue);    --kind-deep: var(--kind-issue-deep);    --kind-wash: var(--kind-issue-wash); }
.card--agent    { --kind: var(--kind-agent);    --kind-deep: var(--kind-agent-deep);    --kind-wash: var(--kind-agent-wash); }
.card--question { --kind: var(--kind-question); --kind-deep: var(--kind-question-deep); --kind-wash: var(--kind-question-wash); }
.card--signal   { --kind: var(--kind-signal);   --kind-deep: var(--kind-signal-deep);   --kind-wash: var(--kind-signal-wash); }

.card__glow {
  position: absolute;
  inset: -40% 20% auto;
  height: 60%;
  background: radial-gradient(60% 60% at 50% 0%, color-mix(in srgb, var(--kind) 26%, transparent), transparent 70%);
  filter: blur(18px);
  pointer-events: none;
}

/* The same light at the other end, quieter, so the card is lit from both edges rather than
   hung from the top one. */
/*
 * Kept inside the card rather than hung below it. Hanging it out cost nothing to look at - the
 * card clips - but on a phone the card is the scroller, and an invisible glow below the footer
 * is two hundred and eighty pixels of dead scroll at the end of every card.
 */
.card__glow--foot {
  inset: auto 20% 0;
  height: 46%;
  background: radial-gradient(60% 70% at 50% 116%, color-mix(in srgb, var(--kind) 30%, transparent), transparent 70%);
}

/*
 * The face this card wears while it is behind another one.
 *
 * Only a card's top edge is ever seen from inside the stack, so from there the edge is the
 * whole card and it is painted in the kind's colour, strong enough to be read at fifteen
 * pixels. It is a layer rather than a different background because the deck fades it off as a
 * card comes forward: without that, the top of an arriving card changed shade in one step,
 * which is the one part of a turn you cannot help but notice.
 *
 * Drawn before the header, which is positioned - so it sits over the card's background and
 * under its words.
 */
.card__band {
  position: absolute;
  inset: 0 0 auto;
  height: 58px;
  background:
    linear-gradient(
      180deg,
      color-mix(in srgb, var(--kind) 62%, var(--surface)) 0,
      color-mix(in srgb, var(--kind) 22%, var(--surface)) 14px,
      transparent 58px
    );
  box-shadow:
    inset 0 2px 0 var(--kind),
    0 -10px 30px -16px color-mix(in srgb, var(--kind) 55%, transparent);
  opacity: 0;
  pointer-events: none;
}

.card__head,
.card__body,
/* The same, at the other end: the buttons are the point of the card and never give up room. */
.card__foot { flex: 0 0 auto; min-width: 0; }

/*
 * Never squeezed.
 *
 * The card is a column flex box, so every child of it shrinks by default - and a header with no
 * `overflow` does not clip when it is shrunk, it draws its children outside itself. Once the body
 * grew tall enough to push (which is what putting the evidence and a diff on a card did), the
 * summary and the byline were painted straight over the top of the body. The header is as tall as
 * its text and the body is what gives: that is what `min-height: 0` and `overflow: auto` down
 * there are for.
 */
.card__head {
  position: relative;
  flex: 0 0 auto;
  min-width: 0;
}

/*
 * One line, and everything on it the same height.
 *
 * It had four things on it at three different heights - a chip, a monospace string, a pill and
 * a button - which reads as four things that happen to be near each other rather than as a
 * line. They all take the row's height now and sit on its centre; what differs between them is
 * weight and colour, which is what was supposed to be doing the work.
 */
.card__head-line {
  --head-h: 24px;
  display: flex;
  align-items: center;
  gap: var(--s2);
  /* One line that truncates, rather than a line that wraps: the title under it is the thing
     allowed to take two lines, and a header that grows pushes it down by a row. */
  flex-wrap: nowrap;
  min-width: 0;
  overflow: hidden;
}

/* The boxes on the line are one size; the text on it is text, as it is in the prototype. */
.card__head-line > .chip,
.card__head-line > .card__pin,
.card__head-line > .card__overdue { height: var(--head-h); }

/* The chip is the prototype's; only its box is told to match the row. */
.card__head-line :deep(.chip) {
  display: inline-flex;
  align-items: center;
  height: var(--head-h);
  padding-top: 0;
  padding-bottom: 0;
}

.card__where {
  flex: 0 1 auto;
  min-width: 0;
  color: var(--text-muted);
  font-family: var(--mono);
  font-size: var(--t-sm);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Where the work lives, said in the same breath as what it is. */

/*
 * The pin: a control the size the rest of them are (the smallest button here is 30px), in the
 * card's top-left corner. It shows its glyph alone until the pointer is on the card, and then
 * says what it does - a corner icon with no word is a thing people press to find out.
 */
/*
 * The pin is drawn at the chip's size, because it is on the chip's row: a 24px disc of ink with
 * a hit area six pixels bigger all round. Visual size and target size are different numbers and
 * this is the one place in the view where they have to be - a control sized to be hit would be
 * the largest thing on a line of 24px boxes.
 */
.card__pin {
  position: relative;
  display: grid;
  place-items: center;
  flex: 0 0 auto;
  width: var(--head-h);
  height: var(--head-h);
  border: 1px solid var(--border);
  border-radius: var(--r-pill);
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  transition: color var(--fast), border-color var(--fast), background var(--fast);
}

/*
 * The hit area, taller than the ink rather than wider: the row clips horizontally - it has to,
 * or a long workspace name pushes the line out - so a target that reached sideways was six
 * pixels of nothing being clipped. Vertically there is room, and vertically is where a 24px
 * target is actually missed.
 */
.card__pin::after {
  content: '';
  position: absolute;
  inset: -8px 0;
}

.card__pin:hover { color: var(--text); border-color: var(--border-strong); }

.card__pin--on {
  border-color: color-mix(in srgb, var(--kind) 55%, transparent);
  background: var(--kind-wash);
  color: var(--kind);
}



.card__overdue {
  display: inline-flex;
  align-items: center;
  flex: 0 0 auto;
  margin-left: auto;
  gap: 5px;
  padding: 0 var(--s3);
  border-radius: var(--r-pill);
  background: var(--warning-wash);
  color: var(--warning);
  font-size: var(--t-xs);
  font-weight: 600;
}

.card__title {
  margin-top: var(--s4);
  font-size: clamp(var(--t-xl), 3.1vw, var(--t-3xl));
  line-height: 1.08;
  letter-spacing: -0.03em;
  text-wrap: balance;
}

.card__summary {
  margin-top: var(--s3);
  max-width: 62ch;
  color: var(--text-dim);
  font-size: clamp(var(--t-md), 1.3vw, var(--t-lg));
  line-height: 1.45;
}

.card__by {
  display: flex;
  align-items: center;
  gap: var(--s2);
  margin-top: var(--s4);
  padding-bottom: var(--s4);
  border-bottom: 1px solid color-mix(in srgb, var(--kind) 16%, var(--border));
  color: var(--text-muted);
  font-size: var(--t-sm);
  flex-wrap: wrap;
}

.card__by-name { color: var(--text-dim); font-weight: 560; }
.card__by-dot { color: var(--text-faint); }


.card__body {
  display: flex;
  flex-direction: column;
  gap: var(--s5);
  flex: 1 1 auto;
  min-height: 0;
  margin-top: var(--s4);
  overflow: auto;
  padding-right: var(--s2);
}

.card__prose {
  max-width: 70ch;
  color: var(--text-dim);
  font-size: var(--t-md);
  line-height: 1.6;
}

/* An issue's own words: as much as fits, scrolled, rather than a paragraph cut off mid-sentence. */
.card__read {
  flex: 1 1 auto;
  min-height: 0;
  padding-right: var(--s2);
  overflow-y: auto;
}

.card__text {
  margin: 0;
  max-width: 82ch;
  color: var(--text-dim);
  font-size: var(--t-sm);
  line-height: 1.6;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

/* Pressed once: it is about to do something outside this cluster, and says so. */
.card__sure {
  border-color: var(--danger) !important;
  color: var(--danger) !important;
}

/* The one thing on the card: it takes the room the absent surface would have had. */
.card__only { flex: 1 1 auto; min-height: 0; }

/* Where the work lives. A control, so it reads as somewhere you can go rather than a label. */
.card__ws {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  flex: 0 0 auto;
  /* 24px, the header line's own height: everything on that line is the same height on purpose. */
  height: var(--head-h, 24px);
  padding: 0 9px;
  border: 1px solid var(--border);
  border-radius: var(--r-pill);
  background: transparent;
  color: var(--text-faint);
  font-family: var(--mono);
  font-size: var(--t-xs);
  cursor: pointer;
  white-space: nowrap;
  transition: color var(--fast), border-color var(--fast);
}

.card__ws:hover { border-color: var(--kind); color: var(--text); }

/* Nothing to open: an offer to make one, in the card's own colour so it reads as the next step. */
.card__ws--none {
  border-style: dashed;
  border-color: color-mix(in srgb, var(--kind) 40%, transparent);
  color: var(--kind);
  font-family: var(--font);
}

.card__ws--none:hover { background: color-mix(in srgb, var(--kind) 12%, transparent); }

.card__stats { display: flex; gap: var(--s2); flex-wrap: wrap; align-items: center; }


</style>
