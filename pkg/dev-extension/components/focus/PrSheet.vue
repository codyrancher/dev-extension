<script setup lang="ts">
/**
 * A pull request, read in full and acted on, over the card.
 *
 * A card about a pull request shows one face of it - the change, the checks, a recording - and
 * the rest meant leaving for GitHub: the description as it actually renders, the template's
 * checklist that the PR's own Description job reads, and the box a review is written in. This is
 * those three, one press from the card:
 *
 *   - the description drawn the way GitHub draws it, recordings and all (GithubPr);
 *   - its checklist live, so a box pressed here is ticked on the pull request - written against
 *     the description as it is at that moment, read fresh, so an edit made elsewhere since this
 *     opened is not overwritten and a long description is not cut short;
 *   - a review: words, and a verdict GitHub will take. On your own pull request that is a comment
 *     only - GitHub refuses an approval or a request for changes from the author - so the other
 *     two are not offered there rather than offered and refused.
 */
import { computed, onMounted, ref } from 'vue';
import TextModal from './TextModal.vue';
import GithubPr from './GithubPr.vue';
import AppButton from './AppButton.vue';
import { readPrSummary } from '../../focus-artifacts';
import type { PrSummary } from '../../focus-artifacts';
import { describePr, githubLogin, prBodyNow } from '../../github';
import { reviewWithBody, amendPrBody } from '../../reviews';
import { setTask, taskDone } from '../../pr-body.mjs';

const props = defineProps<{ pr: number; repo: string }>();
const emit = defineEmits<{ (e: 'close'): void; (e: 'changed'): void }>();

const summary = ref<PrSummary | null>(null);
const loading = ref(true);
const error = ref('');
const login = ref('');
const ticking = ref<number[]>([]);
const review = ref('');
const posting = ref('');
const posted = ref('');

async function load(fresh = false): Promise<void> {
  try {
    const read = await readPrSummary(props.pr, props.repo, fresh);

    if (read) {
      summary.value = read;
    } else if (!summary.value) {
      error.value = 'The pull request could not be read.';
    }
  } finally {
    loading.value = false;
  }
}

onMounted(async() => {
  githubLogin().then((who) => {
    login.value = who;
  });
  await load();
});

/** Yours, when the login is known; until then the review offers the one verdict always allowed. */
const mine = computed(() => !login.value || summary.value?.author === login.value);

/*
 * A box, ticked on the press and written behind it.
 *
 * It used to wait for three round trips before the box moved - a fresh read of the whole pull
 * request, the write, and another whole read - and every box was disabled meanwhile, so a second
 * press went nowhere. Now the description changes here at once, and the writes go one after
 * another, each set against the description as GitHub has it at that moment (`prBodyNow`, one
 * call) and as a state rather than a flip (`setTask`), so a box somebody else ticked in between
 * stays ticked. A refused write puts its box back and says so.
 */
let writes: Promise<void> = Promise.resolve();

function tick(n: number): void {
  const now = summary.value;
  const done = now ? taskDone(now.body, n) : null;

  if (!now || done === null) {
    return;
  }
  error.value = '';
  summary.value = { ...now, body: setTask(now.body, n, !done) };
  ticking.value = [...ticking.value, n];
  writes = writes.then(async() => {
    try {
      const body = setTask(await prBodyNow(props.repo, props.pr), n, !done);

      await describePr(props.repo, props.pr, { body });
      amendPrBody(props.pr, body, props.repo);
    } catch (e) {
      if (summary.value) {
        summary.value = { ...summary.value, body: setTask(summary.value.body, n, done) };
      }
      error.value = `The box was not ${ done ? 'unticked' : 'ticked' }: ${ (e as Error)?.message || e }`;
    } finally {
      ticking.value = ticking.value.filter((_, i) => i !== ticking.value.indexOf(n));
      if (!ticking.value.length) {
        emit('changed');
      }
    }
  });
}

async function send(event: 'COMMENT' | 'APPROVE' | 'REQUEST_CHANGES'): Promise<void> {
  if (posting.value) {
    return;
  }
  posting.value = event;
  error.value = '';
  posted.value = '';
  try {
    const url = await reviewWithBody(props.pr, props.repo, event, review.value);

    posted.value = event === 'APPROVE' ? 'Approved.' : event === 'REQUEST_CHANGES' ? 'Changes requested.' : 'Review posted.';
    if (url) {
      posted.value += ' It is on the pull request now.';
    }
    review.value = '';
    emit('changed');
  } catch (e) {
    error.value = `The review was not posted: ${ (e as Error)?.message || e }`;
  } finally {
    posting.value = '';
  }
}
</script>

<template>
  <TextModal
    :title="summary ? `#${ pr } · ${ summary.title }` : `Pull request #${ pr }`"
    :at="repo"
    @close="emit('close')"
  >
    <div class="prs">
      <p v-if="loading" class="prs__note">Reading the pull request…</p>
      <GithubPr
        v-else-if="summary"
        :pr="summary"
        live
        :ticking="ticking"
        class="prs__pr"
        @tick="tick"
      />

      <!-- A review, from here: words and a verdict. -->
      <section v-if="summary" class="prs__review" aria-label="Leave a review">
        <textarea
          v-model="review"
          class="prs__box"
          rows="3"
          :placeholder="mine ? 'Leave a comment on your pull request…' : 'Leave a review…'"
          :disabled="!!posting"
        />
        <div class="prs__acts">
          <AppButton size="sm" variant="primary" :busy="posting === 'COMMENT'" @click="send('COMMENT')">Comment</AppButton>
          <template v-if="!mine">
            <AppButton size="sm" :busy="posting === 'APPROVE'" @click="send('APPROVE')">Approve</AppButton>
            <AppButton size="sm" :busy="posting === 'REQUEST_CHANGES'" @click="send('REQUEST_CHANGES')">Request changes</AppButton>
          </template>
          <a
            v-if="summary.url"
            :href="summary.url"
            target="_blank"
            rel="noopener noreferrer"
            class="prs__out"
          >Open on GitHub</a>
        </div>
        <p v-if="posted" class="prs__note prs__note--ok">{{ posted }}</p>
      </section>
      <p v-if="error" class="prs__note prs__note--bad">{{ error }}</p>
    </div>
  </TextModal>
</template>

<style scoped>
.prs {
  display: flex;
  flex-direction: column;
  gap: var(--s3);
  min-height: 0;
}

/* The description scrolls inside the sheet; the review box stays under it. */
.prs__pr { max-height: min(62vh, 760px); }

.prs__review {
  display: flex;
  flex-direction: column;
  gap: var(--s2);
  padding-top: var(--s3);
  border-top: 1px solid var(--border);
}

.prs__box {
  width: 100%;
  min-height: 68px;
  padding: var(--s2) var(--s3);
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  background: var(--surface-sunk);
  color: var(--text);
  font: inherit;
  font-size: var(--t-sm);
  resize: vertical;
}

.prs__box:focus { outline: none; border-color: var(--accent); }

.prs__acts {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--s2);
}

.prs__out {
  margin-left: auto;
  color: var(--text-muted);
  font-size: var(--t-xs);
}

.prs__out:hover { color: var(--accent); }

.prs__note { margin: 0; color: var(--text-muted); font-size: var(--t-sm); }
.prs__note--ok { color: var(--success); }
.prs__note--bad { color: var(--danger); }
</style>
