<script setup lang="ts">
/** What kind of card this is, in its own hue: the first thing read on a card and in the rail. */
import { computed } from 'vue';
import type { FocusKind } from '../../focus';

const props = defineProps<{ kind: FocusKind; size?: 'sm' | 'md' }>();

const words: Record<FocusKind, string> = {
  review: 'Review',
  issue: 'Issue',
  agent: 'Agent work',
  question: 'Question',
  signal: 'Signal',
};

const label = computed(() => words[props.kind]);
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

.chip--sm { padding: 2px 8px 2px 6px; font-size: 10px; }

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
