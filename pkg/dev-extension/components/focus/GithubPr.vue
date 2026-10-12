<script setup lang="ts">
/**
 * A pull request the way GitHub states one: what it is, who wrote it, where it goes, what it says.
 *
 * The summary and not the change. The diff has a surface of its own (`files`, ChangeSet) and the
 * checks have theirs; this is the half of a pull request page above them, which is the half a
 * card about something else - a review waiting on you - never showed at all.
 *
 * Nothing is read here. Everything comes off `PrSummary`, which `readArtifacts` fills from the
 * `meta` that already comes back with the diff, so a card drawing this pays for no extra call.
 */
import { computed } from 'vue';
import type { PrSummary } from '../../focus-artifacts';
import Markdown from './Markdown.vue';
import AppIcon from './AppIcon.vue';

const props = defineProps<{ pr: PrSummary }>();

/**
 * The one word GitHub puts in the badge, and it is not `state` alone.
 *
 * `state` is OPEN for a draft and MERGED for a merge, but a draft is the case that changes what
 * you would do about it - it is not asking for anything yet - so it wins over OPEN. Closed and
 * merged are different endings and GitHub colours them differently; so does this.
 */
const badge = computed(() => {
  if (props.pr.merged) {
    return { word: 'Merged', tone: 'merged' };
  }
  if (props.pr.draft) {
    return { word: 'Draft', tone: 'draft' };
  }
  if (/closed/i.test(props.pr.state)) {
    return { word: 'Closed', tone: 'closed' };
  }

  return { word: 'Open', tone: 'open' };
});

/** What is standing in the way, when GitHub says something is. Nothing for a clean one. */
const blocked = computed(() => {
  const state = String(props.pr.mergeableState || '').toLowerCase();

  if (props.pr.merged || /clean|unknown|has_hooks/.test(state) || !state) {
    return '';
  }

  return { dirty: 'has conflicts', blocked: 'blocked', behind: 'behind the base', unstable: 'checks failing' }[state] || state;
});
</script>

<template>
  <article class="gh">
    <header class="gh__head">
      <span class="gh__badge" :class="`gh__badge--${ badge.tone }`">{{ badge.word }}</span>
      <h3 class="gh__title">{{ pr.title }}</h3>
    </header>

    <!-- The line GitHub puts under the title: who, into what, from what. -->
    <p class="gh__line">
      <strong>{{ pr.author || 'somebody' }}</strong> wants to merge
      <code class="gh__ref">{{ pr.headRef }}</code> into <code class="gh__ref">{{ pr.baseRef }}</code>
    </p>

    <ul class="gh__marks">
      <li class="gh__mark"><code>#{{ pr.number }}</code></li>
      <li class="gh__mark">{{ pr.stat.files }} {{ pr.stat.files === 1 ? 'file' : 'files' }}</li>
      <li class="gh__mark gh__mark--add">+{{ pr.stat.added }}</li>
      <li class="gh__mark gh__mark--del">−{{ pr.stat.removed }}</li>
      <li v-if="pr.approved" class="gh__mark gh__mark--ok">
        <AppIcon name="check" :size="12" />
        approved{{ pr.approvedBy.length ? ` by ${ pr.approvedBy.join(', ') }` : '' }}
      </li>
      <li v-if="blocked" class="gh__mark gh__mark--warn">
        <AppIcon name="alert" :size="12" />
        {{ blocked }}
      </li>
    </ul>

    <!--
      The description, as written.

      Its own scroller: a pull request body on this repository is a filled-in template running
      to several screens, and the tab it is in is one pane of a card.
    -->
    <div v-if="pr.body" class="gh__body">
      <Markdown :text="pr.body" />
    </div>
    <p v-else class="gh__none">No description.</p>
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

.gh__head {
  display: flex;
  align-items: baseline;
  gap: var(--s3);
  flex: 0 0 auto;
  min-width: 0;
}

/* The pill GitHub leads with, in the colours it uses for the four endings. */
.gh__badge {
  display: inline-flex;
  align-items: center;
  flex: 0 0 auto;
  padding: 2px var(--s3);
  border: 1px solid currentcolor;
  border-radius: var(--r-pill);
  font-size: var(--t-xs, 11px);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.gh__badge--open { color: var(--ok, #3fb950); }
.gh__badge--draft { color: var(--text-muted); }
.gh__badge--merged { color: var(--kind, #a371f7); }
.gh__badge--closed { color: var(--danger, #f85149); }

.gh__title {
  margin: 0;
  color: var(--text);
  font-size: var(--t-md);
  font-weight: 600;
  /* Two lines at most: the body under it is the thing to read. */
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  overflow: hidden;
}

.gh__line {
  margin: 0;
  color: var(--text-muted);
  font-size: var(--t-sm);
}

.gh__ref {
  padding: 1px 5px;
  border-radius: var(--r-sm);
  background: var(--surface-sunk);
  font-family: var(--mono);
  font-size: 11px;
}

.gh__marks {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--s3);
  flex: 0 0 auto;
  margin: 0;
  padding: 0;
  list-style: none;
  color: var(--text-faint);
  font-size: var(--t-sm);
}

.gh__mark {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-variant-numeric: tabular-nums;
}

.gh__mark code {
  font-family: var(--mono);
  font-size: 11px;
}

.gh__mark--add { color: var(--ok, #3fb950); }
.gh__mark--del { color: var(--danger, #f85149); }
.gh__mark--ok { color: var(--ok, #3fb950); }
.gh__mark--warn { color: var(--warning, #d29922); }

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
