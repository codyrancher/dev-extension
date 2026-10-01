<script setup lang="ts">
/**
 * The cards, as cards.
 *
 * A card definition is a thing you recognise by sight - a hue, a chip, a row of buttons - so a
 * list of its field names is the one way of showing it that helps nobody. Each definition is
 * drawn here as a miniature of the card it makes, with the same chrome the deck uses: the hue
 * closing it top and bottom, the chip, a title in its own voice, and the actions as the buttons
 * they will be. What is different from a real card is only what a definition adds: the rules it
 * claims, and how many things in the queue those rules are holding right now - which is the
 * question somebody opens this panel with, because a card claiming nothing is a card they will
 * never see.
 */
import KindChip from './KindChip.vue';
import AppButton from './AppButton.vue';
import AppIcon from './AppIcon.vue';
import type { CardDef } from '../../focus';

defineProps<{
  cards: CardDef[];
  /** Rule id to how many things it is holding, so a card can say whether it is in play. */
  counts: Record<string, number>;
}>();

const emit = defineEmits<{ (e: 'edit', id: string): void; (e: 'add'): void }>();

/** What a verb does, in a word, for the line under the buttons. */
const VERBS: Record<string, string> = {
  open:   'goes to the work',
  url:    'opens it on GitHub',
  ask:    'asks the agent',
  snooze: 'puts it off',
  done:   'takes it off the deck',
};
</script>

<template>
  <div class="gallery">
    <article
      v-for="card in cards"
      :key="card.id"
      class="mini"
      :class="`mini--${ card.kind }`"
    >
      <span class="mini__band" aria-hidden="true" />

      <header class="mini__head">
        <KindChip :kind="card.kind" size="sm" />
        <span class="mini__id">{{ card.id }}</span>
        <button type="button" class="mini__edit" :title="`Change ${ card.label }`" @click="emit('edit', card.id)">
          <AppIcon name="pencil" :size="13" />
        </button>
      </header>

      <h3 class="mini__label">{{ card.label }}</h3>

      <!-- What it draws, and whether anything is in it. A rule holding nothing is dimmed. -->
      <ul class="mini__rules">
        <li
          v-for="rule in card.rules"
          :key="rule"
          class="mini__rule"
          :class="{ 'mini__rule--idle': !counts[rule] }"
        >
          {{ rule }}<span v-if="counts[rule]" class="mini__rule-count">{{ counts[rule] }}</span>
        </li>
        <li v-if="!card.rules.length" class="mini__rule mini__rule--any">anything with no card of its own</li>
      </ul>

      <p class="mini__summary">{{ card.summary }}</p>

      <!-- The buttons as they will be: the first one is the card's own, the rest are quiet. -->
      <footer class="mini__foot">
        <AppButton
          v-for="(action, n) in card.actions"
          :key="action.label"
          :variant="n ? 'ghost' : 'kind'"
          size="sm"
          :title="VERBS[action.verb] || action.verb"
        >{{ action.label }}</AppButton>
      </footer>

      <p class="mini__verbs">
        <span v-for="action in card.actions" :key="action.label" class="mini__verb">
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

<style scoped>
.gallery { display: flex; flex-direction: column; gap: var(--s4); }

/* A miniature of the thing it makes: the hue closes it at both ends, as on a real card. */
.mini {
  position: relative;
  padding: var(--s4);
  border: 1px solid var(--border);
  border-top-color: color-mix(in srgb, var(--kind-c) 34%, var(--border));
  border-bottom-color: color-mix(in srgb, var(--kind-c) 34%, var(--border));
  border-radius: var(--r-md);
  background:
    linear-gradient(
      180deg,
      color-mix(in srgb, var(--kind-c) 8%, var(--surface)) 0%,
      var(--surface) 30%,
      var(--surface) 76%,
      color-mix(in srgb, var(--kind-c) 8%, var(--surface)) 100%
    );
  overflow: hidden;
}

/* The edge a card shows from inside the deck, which is how the deck is read at a glance. */
.mini__band {
  position: absolute;
  inset: 0 0 auto;
  height: 3px;
  background: linear-gradient(90deg, transparent, var(--kind-c), transparent);
}

.mini__head { display: flex; align-items: center; gap: var(--s2); }
.mini__id { color: var(--text-faint); font-family: var(--mono); font-size: var(--t-xs); }

.mini__edit {
  display: grid;
  place-items: center;
  width: 24px;
  height: 24px;
  margin-left: auto;
  border: 1px solid var(--border);
  border-radius: var(--r-pill);
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  transition: color var(--fast), border-color var(--fast);
}

.mini__edit:hover { color: var(--kind-c); border-color: color-mix(in srgb, var(--kind-c) 50%, transparent); }

.mini__label {
  margin-top: var(--s3);
  color: var(--text);
  font-size: var(--t-md);
  letter-spacing: -0.015em;
}

.mini__rules { display: flex; flex-wrap: wrap; gap: 4px; margin: var(--s2) 0 0; padding: 0; list-style: none; }

.mini__rule {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 1px 7px;
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

.mini__summary {
  margin: var(--s3) 0 0;
  color: var(--text-muted);
  font-family: var(--mono);
  font-size: var(--t-xs);
}

.mini__foot {
  display: flex;
  flex-wrap: wrap;
  gap: var(--s2);
  margin-top: var(--s3);
  padding-top: var(--s3);
  border-top: 1px solid color-mix(in srgb, var(--kind-c) 16%, var(--border));
  /* The buttons are a picture of the card's buttons, not buttons: pressing one here would be
     pressing it on nothing. */
  pointer-events: none;
}

.mini__verbs { display: flex; flex-direction: column; gap: 2px; margin: var(--s2) 0 0; }
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
  border-style: dashed;
  background: transparent;
  color: var(--accent);
  text-align: left;
  cursor: pointer;
}

.mini--new:hover { background: var(--accent-wash); }
.mini__new-label { color: var(--text); font-size: var(--t-sm); font-weight: 650; }
.mini__new-about { color: var(--text-faint); font-size: var(--t-xs); }
</style>
