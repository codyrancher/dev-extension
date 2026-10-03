<script setup lang="ts">
/**
 * What kind of card this is, in its own hue: the first thing read on a card and in the rail.
 *
 * The hue is one of five and the kinds of card are fifteen, so a chip that said only the hue's
 * name mislabelled the card: a dependency bump was chipped "Issue", a failing build "Signal", a
 * security advisory also "Signal", and the agent's finished review and a review somebody asked
 * you for were both "Review". The chip is the only thing on a card whose job is to say what kind
 * of card it is, and it was saying what colour family it belonged to.
 *
 * So the colour still comes from the kind - five hues is what makes a deck legible while it is
 * still moving - and the word comes from the card's own definition (`chip` in focus.ts). The
 * hue's name is the fallback, for the rail and anywhere drawing a kind rather than a card.
 */
import { computed } from 'vue';
import type { FocusKind } from '../../focus';

const props = defineProps<{ kind: FocusKind; size?: 'sm' | 'md'; word?: string }>();

const words: Record<FocusKind, string> = {
  review: 'Review',
  issue: 'Issue',
  agent: 'Agent work',
  question: 'Question',
  signal: 'Signal',
};

const label = computed(() => props.word || words[props.kind]);
</script>

<template>
  <span class="chip" :class="[`chip--${ kind }`, `chip--${ size || 'md' }`]">
    <span class="chip__dot" />
    {{ label }}
  </span>
</template>

<style scoped>
.chip {
  display: inline-flex;
  align-items: center;
  gap: var(--s2);
  padding: 3px 10px 3px 8px;
  border: 1px solid color-mix(in srgb, var(--kind-c) 38%, transparent);
  border-radius: var(--r-pill);
  background: var(--kind-w);
  color: var(--kind-c);
  font-size: var(--t-xs);
  font-weight: 640;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  white-space: nowrap;
}

.chip--sm { padding: 2px 8px 2px 6px; font-size: var(--t-2xs); }

.chip__dot {
  width: 6px;
  height: 6px;
  border-radius: var(--r-pill);
  background: var(--kind-c);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--kind-c) 18%, transparent);
}

.chip--review   { --kind-c: var(--kind-review);   --kind-w: var(--kind-review-wash); }
.chip--issue    { --kind-c: var(--kind-issue);    --kind-w: var(--kind-issue-wash); }
.chip--agent    { --kind-c: var(--kind-agent);    --kind-w: var(--kind-agent-wash); }
.chip--question { --kind-c: var(--kind-question); --kind-w: var(--kind-question-wash); }
.chip--signal   { --kind-c: var(--kind-signal);   --kind-w: var(--kind-signal-wash); }
</style>
