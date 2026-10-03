<script setup lang="ts">
/**
 * What was said about the change, with the code it was said about.
 *
 * This is the other half of the review pass. ReviewPass is for comments the agent has written
 * and you have not posted yet - things to judge. This is for comments that already exist and are
 * waiting on an answer from you: a reviewer's note on your pull request, the agent's reply under
 * it, your own from last week.
 *
 * The rule both halves share is that the code comes to the comment. A review comment read on its
 * own is a sentence about a line you then have to go and find, and going and finding it is the
 * thing the card exists to save. GitHub sends the hunk it anchored to; the agent's own are
 * matched against the pull request's patches. Either way the lines are under the words.
 *
 * Yours are marked and quietened. The point of the card is what is waiting on you, and what you
 * already said is context for reading it rather than part of the queue.
 */
import { computed } from 'vue';
import CodeView from '../code/CodeView.vue';
import { fromDiffLines, highlighted } from '../code/rows';
import AppIcon from './AppIcon.vue';
import SectionHead from './SectionHead.vue';
import AppButton from './AppButton.vue';
import type { CardComment } from '../../focus-artifacts';

const props = defineProps<{ comments: CardComment[]; busy?: boolean }>();

const emit = defineEmits<{
  (e: 'reply', value: { comment: CardComment }): void;
  (e: 'expand', value: { path: string; mark: [number, number] }): void;
}>();

const rowsFor = (comment: CardComment) => highlighted(fromDiffLines(comment.hunk), comment.path);

/** Theirs, and not answered after it: the ones the card is actually about. */
const waiting = computed(() => props.comments.filter((c, n) => !c.mine && !props.comments.slice(n + 1).some((later) => later.mine)));

const when = (at: string) => {
  const ms = Date.now() - Date.parse(at || '');

  if (!Number.isFinite(ms)) {
    return '';
  }
  const hours = Math.round(ms / 3_600_000);

  return hours < 1 ? 'just now' : hours < 48 ? `${ hours }h ago` : `${ Math.round(hours / 24) }d ago`;
};

const file = (path: string) => path.slice(path.lastIndexOf('/') + 1);

/** Worth drawing: at least one line with something on it. */
const hasCode = (comment: CardComment) => comment.hunk.some((line) => line.text.trim());
</script>

<template>
  <section class="talk">
    <SectionHead label="What was said" :count="`${ comments.length } comments`">
      <span v-if="waiting.length" class="talk__waiting">{{ waiting.length }} waiting on you</span>
    </SectionHead>

    <ol class="talk__list">
      <li
        v-for="comment in comments"
        :key="comment.id"
        class="note"
        :class="{ 'note--mine': comment.mine, 'note--pending': comment.pending, 'note--waiting': waiting.includes(comment) }"
      >
        <div class="note__head">
          <span class="note__who">{{ comment.author }}</span>
          <span v-if="comment.pending" class="u-badge">not posted</span>
          <span v-if="comment.path" class="note__where" dir="rtl">{{ file(comment.path) }}<template v-if="comment.line">:{{ comment.line }}</template></span>
          <span class="note__when">{{ when(comment.at) }}</span>
        </div>

        <!--
          The lines it is about, so the comment can be read where it was written - when there are
          any. A comment anchored to a file GitHub sent no usable hunk for came through as one
          blank row, which drew an empty code box with a `0 0` gutter and nothing in it.
        -->
        <CodeView
          v-if="hasCode(comment)"
          :rows="rowsFor(comment)"
          :mark-lines="comment.line ? [comment.line, comment.line] : null"
          expandable
          expand-label="See the whole file"
          @expand="emit('expand', { path: comment.path, mark: [comment.line || 1, comment.line || 1] })"
        />

        <p class="note__body">{{ comment.body }}</p>

        <!-- What the agent attached to prove it: the screenshot, the recording. -->
        <div v-if="comment.media.length" class="note__shots">
          <a
            v-for="item in comment.media"
            :key="item.src"
            class="note__shot"
            :href="item.src"
            target="_blank"
            rel="noopener"
            :title="item.caption"
          >
            <AppIcon :name="item.kind === 'video' ? 'play' : 'expand'" :size="11" />
            {{ item.label }}
          </a>
        </div>

        <AppButton
          v-if="waiting.includes(comment)"
          variant="quiet"
          size="sm"
          icon="sparkle"
          :busy="busy"
          class="note__answer"
          @click="emit('reply', { comment })"
        >Answer this one</AppButton>
      </li>
    </ol>
  </section>
</template>

<style scoped>
.talk {
  display: flex;
  flex-direction: column;
  gap: var(--s3);
  min-height: 0;
}



.talk__waiting { margin-left: auto; color: var(--kind); font-size: var(--t-sm); font-weight: 600; }

.talk__list {
  display: flex;
  flex-direction: column;
  gap: var(--s3);
  min-height: 0;
  margin: 0;
  padding: 0 var(--s2) 0 0;
  list-style: none;
  overflow-y: auto;
}

/*
 * Never squeezed.
 *
 * A flex item shrinks by default, and a scrolling column of forty of them hands each one less
 * height than its content needs - so the rows collapse into each other and their text draws over
 * the row below, which is what the file tree was doing. Pinning the row is what makes the column
 * scroll instead of compressing. The same mistake, and the same fix, as the card's own header.
 */
.note {
  flex: 0 0 auto;
  display: flex;
  flex-direction: column;
  gap: var(--s2);
  min-width: 0;
  padding: var(--s3);
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  background: var(--surface-sunk);
}

/* Yours: context for reading the rest, not part of what is waiting. */
.note--mine { background: transparent; opacity: 0.68; }
.note--waiting { border-color: color-mix(in srgb, var(--kind) 44%, transparent); background: color-mix(in srgb, var(--kind) 7%, transparent); }
.note--pending { border-style: dashed; }

.note__head {
  display: flex;
  align-items: center;
  gap: var(--s2);
  min-width: 0;
}

.note__who { color: var(--text); font-size: var(--t-sm); font-weight: 650; }

/* Right-to-left so a long path loses its start, which is the part nobody reads. */
.note__where {
  min-width: 0;
  overflow: hidden;
  color: var(--text-faint);
  font-family: var(--mono);
  font-size: var(--t-xs);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.note__when { margin-left: auto; flex: 0 0 auto; color: var(--text-faint); font-size: var(--t-xs); }

.note__body {
  margin: 0;
  color: var(--text-dim);
  font-size: var(--t-sm);
  line-height: 1.55;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.note__shots { display: flex; flex-wrap: wrap; gap: var(--s2); }

.note__shot {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 22px;
  padding: 0 8px;
  border: 1px solid var(--border);
  border-radius: var(--r-pill);
  color: var(--text-muted);
  font-size: var(--t-xs);
  text-decoration: none;
}

.note__shot:hover { border-color: var(--kind); color: var(--text); }

.note__answer { align-self: flex-start; }
</style>
