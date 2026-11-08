<script setup lang="ts">
/**
 * An issue, read in full over the card: the description as GitHub renders it, and what was said
 * under it.
 *
 * The cards whose work has no pull request yet - a branch with commits and nothing opened, an
 * issue to pick up - showed the change or a line about the issue, and reading what the issue
 * actually asks for meant leaving for GitHub. This is the issue's page in one press: its labels
 * and age, its body with the recordings and screenshots in it drawn, and the comments, which is
 * where the evidence of a bug report so often is.
 */
import { computed, onMounted, ref } from 'vue';
import TextModal from './TextModal.vue';
import GithubIssue from './GithubIssue.vue';
import CommentBody from './CommentBody.vue';
import MediaViewer from './MediaViewer.vue';
import { issueBody, githubLogin } from '../../github';
import { ghAssetUrl } from '../../reviews';
import type { PoolIssue } from '../../focus-artifacts';
import type { NoteMedia } from '../../focus-review';

const props = defineProps<{ issue: number; repo: string }>();
const emit = defineEmits<{ (e: 'close'): void }>();

type Read = Awaited<ReturnType<typeof issueBody>>;

const read = ref<Read | null>(null);
const login = ref('');
const loading = ref(true);
const error = ref('');
const viewer = ref<{ items: NoteMedia[]; at: number } | null>(null);

onMounted(async() => {
  githubLogin().then((who) => {
    login.value = who;
  });
  try {
    read.value = await issueBody(props.repo, props.issue);
  } catch (e) {
    error.value = `The issue could not be read: ${ (e as Error)?.message || e }`;
  } finally {
    loading.value = false;
  }
});

/** The read, in the shape the card's own issue view draws. */
const summary = computed<PoolIssue | null>(() => {
  const r = read.value;

  if (!r) {
    return null;
  }
  const whoElse = r.assignees.filter((who) => who.toLowerCase() !== login.value.toLowerCase());

  return {
    number:   props.issue,
    title:    r.title,
    url:      r.url,
    repo:     props.repo,
    labels:   r.labels,
    comments: r.comments,
    age:      Math.max(0, Math.round((Date.now() - Date.parse(r.createdAt || '')) / 86_400_000)) || 0,
    assignee: whoElse.join(', '),
    mine:     r.assignees.length !== whoElse.length,
    body:     r.body,
  } as PoolIssue;
});

function when(iso: string): string {
  const at = iso ? new Date(iso) : null;

  return at && !Number.isNaN(at.getTime()) ? at.toLocaleString([], { month: 'short', day: 'numeric', year: 'numeric' }) : '';
}
</script>

<template>
  <TextModal
    :title="summary ? `#${ issue } · ${ summary.title }` : `Issue #${ issue }`"
    :at="repo"
    @close="emit('close')"
  >
    <div class="iss">
      <p v-if="loading" class="iss__note">Reading the issue…</p>
      <p v-else-if="error" class="iss__note iss__note--bad">{{ error }}</p>
      <template v-else-if="summary">
        <GithubIssue :issue="summary" class="iss__issue" />

        <!-- What was said under it, oldest first, the way the thread reads on GitHub. -->
        <section v-if="read && read.comments_list.length" class="iss__thread" aria-label="Comments">
          <h4 class="iss__head">
            {{ read.comments }} {{ read.comments === 1 ? 'comment' : 'comments' }}<template v-if="read.comments > read.comments_list.length">, the last {{ read.comments_list.length }}</template>
          </h4>
          <article v-for="(c, i) in read.comments_list" :key="i" class="iss__comment">
            <header class="iss__who">
              <strong>{{ c.author }}</strong>
              <span class="iss__at">{{ when(c.at) }}</span>
            </header>
            <CommentBody :body="c.body" :asset-url="ghAssetUrl" @open="viewer = $event" />
          </article>
        </section>

        <a
          v-if="summary.url"
          :href="summary.url"
          target="_blank"
          rel="noopener noreferrer"
          class="iss__out"
        >Open on GitHub</a>
      </template>
    </div>

    <MediaViewer
      v-if="viewer"
      :items="viewer.items"
      :start="viewer.at"
      @close="viewer = null"
    />
  </TextModal>
</template>

<style scoped>
.iss {
  display: flex;
  flex-direction: column;
  gap: var(--s3);
  min-height: 0;
}

.iss__thread {
  display: flex;
  flex-direction: column;
  gap: var(--s3);
  padding-top: var(--s3);
  border-top: 1px solid var(--border);
}

.iss__head {
  margin: 0;
  color: var(--text-muted);
  font-size: var(--t-xs);
  font-weight: 650;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

.iss__comment {
  display: flex;
  flex-direction: column;
  gap: var(--s2);
  padding: var(--s2) var(--s3);
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
}

.iss__who {
  display: flex;
  align-items: baseline;
  gap: var(--s2);
  font-size: var(--t-sm);
}

.iss__at { color: var(--text-faint); font-size: var(--t-xs); }

.iss__out {
  align-self: flex-end;
  color: var(--text-muted);
  font-size: var(--t-xs);
}

.iss__out:hover { color: var(--accent); }

.iss__note { margin: 0; color: var(--text-muted); font-size: var(--t-sm); }
.iss__note--bad { color: var(--danger); }
</style>
