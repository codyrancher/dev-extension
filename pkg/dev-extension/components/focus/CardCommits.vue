<script setup lang="ts">
/**
 * What is on the branch, for work that has no pull request yet.
 *
 * The question this card asks is whether the work is ready to be shown to somebody, and the
 * commits are how you tell at a glance: six tidy messages is a change somebody can review, and
 * one commit called "wip" is not. So they are listed newest first with their author, because a
 * branch an agent wrote and a branch you wrote want different things from you next.
 */
import SectionHead from './SectionHead.vue';
import type { CardCommit } from '../../focus-artifacts';

defineProps<{ commits: CardCommit[] }>();

const when = (at: string) => {
  const ms = Date.now() - Date.parse(at || '');

  if (!Number.isFinite(ms)) {
    return '';
  }
  const hours = Math.round(ms / 3_600_000);

  return hours < 1 ? 'just now' : hours < 48 ? `${ hours }h` : `${ Math.round(hours / 24) }d`;
};
</script>

<template>
  <section class="cm">
    <SectionHead
      label="On the branch"
      :count="`${ commits.length } commit${ commits.length === 1 ? '' : 's' }`"
    />

    <ol class="cm__list">
      <li v-for="commit in [...commits].reverse()" :key="commit.sha" class="cm__row">
        <code class="cm__sha">{{ commit.sha }}</code>
        <span class="cm__msg">{{ commit.message }}</span>
        <span class="cm__who">{{ commit.author }}</span>
        <span class="cm__when">{{ when(commit.at) }}</span>
      </li>
    </ol>
  </section>
</template>

<style scoped>
.cm { display: flex; flex-direction: column; gap: var(--s2); min-width: 0; }



.cm__list {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-height: 0;
  margin: 0;
  padding: 0 var(--s2) 0 0;
  list-style: none;
  overflow-y: auto;
}

.cm__row {
  display: grid;
  grid-template-columns: 62px minmax(0, 1fr) auto 34px;
  align-items: center;
  gap: var(--s2);
  min-height: 26px;
  padding: 0 var(--s2);
  border-radius: var(--r-sm);
  font-size: var(--t-sm);
}

.cm__row:hover { background: var(--surface-raised); }
.cm__sha { color: var(--text-faint); font-family: var(--mono); font-size: var(--t-xs); }
.cm__msg { min-width: 0; overflow: hidden; color: var(--text-dim); text-overflow: ellipsis; white-space: nowrap; }
.cm__who { color: var(--text-faint); font-size: var(--t-xs); }
.cm__when { color: var(--text-faint); font-size: var(--t-xs); text-align: right; }
</style>
