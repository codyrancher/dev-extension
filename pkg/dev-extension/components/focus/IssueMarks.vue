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

const props = defineProps<{ issue: PoolIssue }>();

const tags = computed(() => issueTags(props.issue));
</script>

<template>
  <span class="marks">
    <span v-for="tag in tags" :key="tag" class="u-badge">{{ tag }}</span>
    <span v-if="!tags.length" class="marks__none">no labels</span>

    <span class="marks__fact">{{ issue.age }}d old</span>
    <span class="marks__fact">
      {{ issue.comments || 'no' }} {{ issue.comments === 1 ? 'comment' : 'comments' }}
    </span>
    <!-- Somebody already has it: the one fact that makes "start the fix" the wrong button. -->
    <span v-if="issue.assignee" class="marks__taken">{{ issue.assignee }} has it</span>
  </span>
</template>

<style scoped>
.marks {
  display: inline-flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--s2);
  min-width: 0;
}

.marks__fact { color: var(--text-faint); font-size: var(--t-xs); font-variant-numeric: tabular-nums; }
.marks__none { color: var(--text-faint); font-size: var(--t-xs); font-style: italic; }
.marks__taken { color: var(--warning); font-size: var(--t-xs); font-weight: 600; }
</style>
