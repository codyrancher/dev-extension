<script setup lang="ts">
/**
 * The cards, as cards.
 *
 * A card definition is a thing you recognise by sight - a hue, a chip, a title, a row of
 * buttons - so a list of its field names is the one way of showing it that helps nobody. Each
 * one is drawn here as the card it makes: the real component, with a sample task built from the
 * definition, scaled down inside a frame. Not a drawing of a card that has to be kept in step
 * with the card, which is the other way this is usually done and is wrong within a month.
 *
 * What a miniature adds that a real card does not have is the part that is about the definition
 * rather than the work: the rules it claims, and how many things in the queue those rules are
 * holding right now. That is the question somebody opens this panel with, because a card
 * claiming nothing is a card they will never see.
 */
import { computed } from 'vue';
import FocusCard from './FocusCard.vue';
import AppIcon from './AppIcon.vue';
import type { CardDef, FocusTask } from '../../focus';

const props = defineProps<{
  cards: CardDef[];
  /** Rule id to how many things it is holding, so a card can say whether it is in play. */
  counts: Record<string, number>;
}>();

const emit = defineEmits<{ (e: 'edit', id: string): void; (e: 'add'): void }>();

/** What a verb does, in a word, for the line under the frame. */
const VERBS: Record<string, string> = {
  open:   'goes to the work',
  url:    'opens it on GitHub',
  ask:    'asks the agent',
  snooze: 'puts it off',
  done:   'takes it off the deck',
};

/**
 * A task that does not exist, so the card has something to draw.
 *
 * Written in the definition's own voice rather than with lorem: `{why}` and the rest are
 * filled with what they would hold, which is how somebody checks that a summary template reads
 * as a sentence before they have anything in the queue that uses it.
 */
function sample(card: CardDef): FocusTask {
  const rule = card.rules[0] || 'example';

  return {
    id:           `sample-${ card.id }`,
    key:          `sample-${ card.id }`,
    what:         'PR #19212',
    title:        card.label,
    needs:        card.actions[0]?.label || 'Deal with it',
    why:          'what the rule said about this one',
    workspace:    'lte-issue-12212',
    url:          '',
    rule,
    score:        props.counts[rule] ? 80 : 60,
    since:        new Date(Date.now() - 36 * 3600 * 1000).toISOString(),
    card,
    about:        card.summary.replace(/\{why\}/g, 'what the rule said about this one'),
    summary:      card.summary.replace(/\{why\}/g, 'what the rule said about this one'),
    waitingHours: 36,
    pinned:       false,
    snoozedUntil: '',
  } as FocusTask;
}

const shown = computed(() => props.cards.map((card) => ({ card, task: sample(card) })));
</script>

<template>
  <div class="gallery">
    <article v-for="entry in shown" :key="entry.card.id" class="mini" :class="`mini--${ entry.card.kind }`">
      <header class="mini__head">
        <span class="mini__id">{{ entry.card.id }}</span>
        <button type="button" class="mini__edit" :title="`Change ${ entry.card.label }`" @click="emit('edit', entry.card.id)">
          <AppIcon name="pencil" :size="14" />
        </button>
      </header>

      <!--
        The card itself, at the size it is drawn at, scaled into the frame. `inert`, because
        everything in it is a control and none of it is pressable here.
      -->
      <div class="mini__frame">
        <div class="mini__stage" inert>
          <FocusCard :task="entry.task" />
        </div>
      </div>

      <!-- What it draws, and whether anything is in it. A rule holding nothing is dimmed. -->
      <ul class="mini__rules">
        <li
          v-for="rule in entry.card.rules"
          :key="rule"
          class="mini__rule"
          :class="{ 'mini__rule--idle': !counts[rule] }"
        >
          {{ rule }}<span v-if="counts[rule]" class="mini__rule-count">{{ counts[rule] }}</span>
        </li>
        <li v-if="!entry.card.rules.length" class="mini__rule mini__rule--any">anything with no card of its own</li>
      </ul>

      <p class="mini__verbs">
        <span v-for="action in entry.card.actions" :key="action.label" class="mini__verb">
          <strong>{{ action.label }}</strong> {{ VERBS[action.verb] || action.verb }}<template v-if="action.verb === 'snooze' && action.hours"> {{ action.hours }}h</template>
        </span>
      </p>
    </article>

    <!-- The way to another one, drawn as the gap in the set rather than as a button elsewhere. -->
    <button type="button" class="mini mini--new" @click="emit('add')">
      <AppIcon name="sparkle" :size="20" />
      <span class="mini__new-label">Make a new card</span>
      <span class="mini__new-about">Describe it to the agent and it writes the definition.</span>
    </button>
  </div>
</template>
        </span>
      </p>
    </article>

    <!-- The way to another one, drawn as the gap in the set rather than as a button elsewhere. -->
    <button type="button" class="mini mini--new" @click="emit('add')">
      <AppIcon name="sparkle" :size="20" />
      <span class="mini__new-label">Make a new card</span>
      <span class="mini__new-about">Describe it to the agent and it writes the definition.</span>
    </button>
  </div>
</template>

<style scoped>
.gallery { display: flex; flex-direction: column; gap: var(--s5); }

.mini { display: flex; flex-direction: column; gap: var(--s2); }

.mini__head { display: flex; align-items: center; gap: var(--s2); }
.mini__id { color: var(--text-faint); font-family: var(--mono); font-size: var(--t-xs); }

.mini__edit {
  display: grid;
  place-items: center;
  width: 32px;
  height: 32px;
  margin-left: auto;
  border: 1px solid var(--border);
  border-radius: var(--r-pill);
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  transition: color var(--fast), border-color var(--fast);
}

.mini__edit:hover { color: var(--kind-c); border-color: color-mix(in srgb, var(--kind-c) 50%, transparent); }

/*
 * The frame, and the card inside it at its own size.
 *
 * A card is laid out for most of a screen, so it is drawn at a screen's worth of pixels and
 * scaled from the top left into the width the panel has. The frame is what clips it and what
 * gives the row its height; the card inside never knows it is small, which is the only way a
 * miniature stays true to the thing it is a miniature of.
 */
.mini__frame {
  position: relative;
  height: 212px;
  border-radius: var(--r-md);
  overflow: hidden;
  /* The scale, and the size the card is drawn at before it. */
  --mini-w: 840px;
  --mini-scale: 0.44;
}

.mini__stage {
  width: var(--mini-w);
  height: calc(212px / var(--mini-scale));
  transform: scale(var(--mini-scale));
  transform-origin: 0 0;
  pointer-events: none;
}

.mini__rules { display: flex; flex-wrap: wrap; gap: 4px; margin: 0; padding: 0; list-style: none; }

.mini__rule {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 2px 8px;
  border: 1px solid color-mix(in srgb, var(--kind-c) 28%, transparent);
  border-radius: var(--r-pill);
  background: color-mix(in srgb, var(--kind-c) 10%, transparent);
  color: var(--text-dim);
  font-family: var(--mono);
  font-size: 10px;
}

.mini__rule--idle { border-color: var(--border); background: transparent; color: var(--text-faint); }
.mini__rule--any { font-family: var(--font); font-style: italic; }

.mini__rule-count {
  padding: 0 4px;
  border-radius: var(--r-pill);
  background: var(--kind-c);
  color: var(--ground);
  font-weight: 700;
}

.mini__verbs { display: flex; flex-direction: column; gap: 2px; margin: 0; }
.mini__verb { color: var(--text-faint); font-size: var(--t-xs); }
.mini__verb strong { color: var(--text-muted); font-weight: 600; }

.mini--review   { --kind-c: var(--kind-review); }
.mini--issue    { --kind-c: var(--kind-issue); }
.mini--agent    { --kind-c: var(--kind-agent); }
.mini--question { --kind-c: var(--kind-question); }
.mini--signal   { --kind-c: var(--kind-signal); }

/* The one that is not a card yet. */
.mini--new {
  --kind-c: var(--accent);
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  min-height: 48px;
  padding: var(--s4);
  border: 1px dashed var(--border);
  border-radius: var(--r-md);
  background: transparent;
  color: var(--accent);
  text-align: left;
  cursor: pointer;
  transition: background var(--fast), border-color var(--fast);
}

.mini--new:hover { background: var(--accent-wash); border-color: var(--accent); }
.mini__new-label { color: var(--text); font-size: var(--t-sm); font-weight: 650; }
.mini__new-about { color: var(--text-faint); font-size: var(--t-xs); }
</style>
