<script setup lang="ts">
/**
 * An issue the way GitHub states one: what it asks for, how old it is, who has it, what it says.
 *
 * The companion to GithubPr, and the same division: this is the summary, not the conversation.
 * `IssueMarks` already draws the four facts that decide whether an issue is worth starting and
 * is used here rather than drawn again - the difference between the two components is that this
 * one is the whole issue on a pane of its own, body included, and that one is a line on a card.
 */
import type { PoolIssue } from '../../focus-artifacts';
import Markdown from './Markdown.vue';
import IssueMarks from './IssueMarks.vue';

defineProps<{ issue: PoolIssue }>();
</script>

<template>
  <article class="gh">
    <header class="gh__head">
      <!--
        No state badge.

        An issue a pull request says it closes is open by definition - that is what the `Fixes`
        is for - and a closed one is a fact about this change having already landed, not about
        the issue. Saying "Open" on every one of them would be a pill that is never anything
        else, which is a pill nobody reads.
      -->
      <h3 class="gh__title">{{ issue.title }}</h3>
    </header>

    <p class="gh__line">
      <code class="gh__num">#{{ issue.number }}</code>
      <span class="gh__repo">{{ issue.repo }}</span>
    </p>

    <!-- The area labels, the age, how much was said, and whether somebody else has it. -->
    <IssueMarks :issue="issue" />

    <div v-if="issue.body" class="gh__body">
      <Markdown :text="issue.body" />
    </div>
    <p v-else class="gh__none">No description on the issue.</p>
  </article>
</template>

<style scoped>
.gh {
  display: flex;
  flex-direction: column;
  gap: var(--s2);
  flex: 1 1 auto;
  min-height: 0;
  min-width: 0;
}

.gh__head { flex: 0 0 auto; min-width: 0; }

.gh__title {
  margin: 0;
  color: var(--text);
  font-size: var(--t-md);
  font-weight: 600;
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  overflow: hidden;
}

.gh__line {
  display: flex;
  align-items: center;
  gap: var(--s3);
  margin: 0;
  color: var(--text-faint);
  font-size: var(--t-sm);
}

.gh__num {
  font-family: var(--mono);
  font-size: 11px;
}

.gh__repo { color: var(--text-faint); }

.gh__body {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
  padding-top: var(--s2);
  border-top: 1px solid var(--border);
}

.gh__none {
  margin: 0;
  padding-top: var(--s2);
  border-top: 1px solid var(--border);
  color: var(--text-faint);
  font-size: var(--t-sm);
}
</style>
