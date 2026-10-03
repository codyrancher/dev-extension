<script setup lang="ts">
/**
 * Who has been asked to look at this, and who has answered.
 *
 * The state a pull request of yours gets stuck in most quietly: open, green, and nobody asked -
 * so nothing is happening to it and nothing ever will. GitHub shows this as an empty space in the
 * sidebar, which is easy to not see for a week.
 *
 * Three groups, and the middle one is the point: asked and silent. Somebody who has approved is
 * done with it, somebody who has not been asked is not ignoring you, and somebody who was asked
 * four days ago and has said nothing is the reason this is not merged.
 *
 * The suggestions are the people already in the thread. GitHub picks reviewers from code
 * ownership, which this cannot read; whoever has commented on the change knows it without being
 * briefed, which is usually the same answer.
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
</script>

<template>
  <section class="rv">
    <SectionHead label="Who is looking at it">
      <span v-if="nobody" class="rv__none">Nobody has been asked</span>
    </SectionHead>

    <div v-if="reviewers.approved.length" class="rv__group">
      <span class="rv__label">Approved</span>
      <span v-for="who in reviewers.approved" :key="who" class="who who--yes">
        <AppIcon name="check" :size="11" />{{ who }}
      </span>
    </div>

    <div v-if="silent.length" class="rv__group">
      <span class="rv__label">Asked, no answer</span>
      <span v-for="who in silent" :key="who" class="who who--waiting">{{ who }}</span>
    </div>

    <!-- The useful half when nobody is looking: who to ask, one press each. -->
    <div v-if="reviewers.suggested.length" class="rv__group">
      <span class="rv__label">{{ nobody ? 'They know this change' : 'Also' }}</span>
      <AppButton
        v-for="who in reviewers.suggested"
        :key="who"
        variant="ghost"
        size="sm"
        :busy="busy"
        @click="emit('ask', who)"
      >Ask {{ who }}</AppButton>
    </div>

    <p v-if="nobody && !reviewers.suggested.length" class="rv__empty">
      Nobody has commented on it either, so there is no obvious person to ask. Open it on GitHub
      and pick from the reviewers it suggests.
    </p>
  </section>
</template>

<style scoped>
.rv { display: flex; flex-direction: column; gap: var(--s3); min-width: 0; }



.rv__none { color: var(--kind); font-size: var(--t-sm); font-weight: 600; }

.rv__group {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--s2);
  min-width: 0;
}

.rv__label {
  min-width: 11ch;
  color: var(--text-faint);
  font-size: var(--t-xs);
}

.who {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 24px;
  padding: 0 10px;
  border: 1px solid var(--border);
  border-radius: var(--r-pill);
  color: var(--text-dim);
  font-size: var(--t-xs);
}

.who--yes { border-color: color-mix(in srgb, var(--success) 38%, transparent); color: var(--success); }
.who--waiting { border-style: dashed; color: var(--text-muted); }

.rv__empty { margin: 0; max-width: 70ch; color: var(--text-muted); font-size: var(--t-sm); line-height: 1.55; }
</style>
