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
 */
import { computed } from 'vue';
import type { FocusTask, CardAction } from '../../focus';
import AppButton from './AppButton.vue';
import KindChip from './KindChip.vue';
import StatPill from './StatPill.vue';
import AppIcon from './AppIcon.vue';

const props = defineProps<{
  task: FocusTask;
  interactive?: boolean;
  busy?: boolean;
  /** Pinned tasks sit beside the deck rather than in it; the card says so and offers the way back. */
  pinned?: boolean;
}>();

const emit = defineEmits<{
  (e: 'act', action: CardAction): void;
  (e: 'ask'): void;
  (e: 'pin'): void;
}>();

/** Waiting long enough that somebody is being held up by it. */
const overdue = computed(() => props.task.waitingHours >= 48);

/** The first action is the one the card is built around; the rest are quieter. */
const primary = computed(() => props.task.card.actions[0] || null);
const rest = computed(() => props.task.card.actions.slice(1));

/** Days, where hours stop being a number anybody reads. */
const waited = computed(() => (props.task.waitingHours >= 48
  ? `${ Math.round(props.task.waitingHours / 24) } days`
  : `${ props.task.waitingHours }h`));
</script>

<template>
  <article
    class="card"
    :class="[`card--${ task.card.kind }`, { 'card--flat': !interactive }]"
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
          <AppIcon name="pin" :size="15" />
          <span class="card__pin-word">{{ pinned ? 'Pinned' : 'Pin' }}</span>
        </button>
        <KindChip :kind="task.card.kind" />
        <span class="card__where">{{ task.what }}</span>
        <span v-if="task.workspace" class="card__ws">{{ task.workspace }}</span>
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
      <!-- Why this is in front of you at all, in the ranking's own words. -->
      <p v-if="task.about" class="card__prose">{{ task.about }}</p>

      <div class="card__stats">
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
        @click="emit('act', primary)"
      >{{ primary.label }}</AppButton>

      <AppButton
        v-for="action in rest"
        :key="action.label"
        variant="ghost"
        size="lg"
        @click="emit('act', action)"
      >{{ action.label }}</AppButton>

      <AppButton variant="quiet" size="lg" icon="sparkle" class="card__ask" @click="emit('ask')">
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
.card__foot { min-width: 0; }

.card__head { position: relative; }

.card__head-line {
  display: flex;
  align-items: center;
  gap: var(--s3);
  /* One line that truncates, rather than a line that wraps: the title under it is the thing
     allowed to take two lines, and a header that grows pushes it down by a row. */
  flex-wrap: nowrap;
  min-width: 0;
}

.card__where {
  flex: 0 0 auto;
  color: var(--text-muted);
  font-family: var(--mono);
  font-size: var(--t-sm);
  white-space: nowrap;
}

/* Where the work lives, which is a name of arbitrary length: it is the part that gives way. */
.card__ws {
  min-width: 0;
  padding: 2px 8px;
  border: 1px solid var(--border);
  border-radius: var(--r-pill);
  color: var(--text-faint);
  font-family: var(--mono);
  font-size: var(--t-xs);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/*
 * The pin: a control the size the rest of them are (the smallest button here is 30px), in the
 * card's top-left corner. It shows its glyph alone until the pointer is on the card, and then
 * says what it does - a corner icon with no word is a thing people press to find out.
 */
.card__pin {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  gap: var(--s2);
  height: 32px;
  padding: 0 var(--s3);
  border: 1px solid var(--border);
  border-radius: var(--r-pill);
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  transition: color var(--fast), border-color var(--fast), background var(--fast);
}

.card__pin:hover { color: var(--text); border-color: var(--border-strong); }

.card__pin--on {
  border-color: color-mix(in srgb, var(--kind) 55%, transparent);
  background: var(--kind-wash);
  color: var(--kind);
}

/* The word, which only appears when the pointer is on the card it belongs to. */
.card__pin-word {
  max-width: 0;
  overflow: hidden;
  font-size: var(--t-xs);
  font-weight: 600;
  white-space: nowrap;
  transition: max-width var(--base) var(--ease-out);
}

.card:hover .card__pin-word,
.card__pin:focus-visible .card__pin-word,
.card__pin--on .card__pin-word { max-width: 72px; }

.card__overdue {
  display: inline-flex;
  align-items: center;
  flex: 0 0 auto;
  margin-left: auto;
  gap: 5px;
  padding: 3px 10px;
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

.card__stats { display: flex; gap: var(--s2); flex-wrap: wrap; align-items: center; }


</style>
