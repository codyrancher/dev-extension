<script setup lang="ts">
/**
 * A review comment, as the comment it will be once it is posted.
 *
 * These are written to be read on GitHub: a table of what was tested, a paragraph on what breaks,
 * a link to the line it breaks at, and a recording placed at the point in the argument where you
 * should watch it. Drawn as plain text, all of that becomes one grey wall with `|---|---|` in the
 * middle of it, and the judgement the pass is asking for - is this comment right, and is it worth
 * posting - is one you cannot make from a wall.
 *
 * So the markdown is rendered with the same renderer the pull request page uses, and the evidence
 * goes where the comment puts it. Two forms, because the agents write both:
 *
 *   - `[[attach:name.mp4]]`, the marker for a file still sitting in the agent's workspace. It is
 *     replaced by that file, played in place.
 *   - a bare `user-attachments` URL on a line of its own, which is what an already-uploaded
 *     recording looks like and what GitHub itself turns into a player. See reviews.ts.
 *
 * Anything attached but never referenced is drawn at the end rather than dropped: it is still
 * evidence, and a comment that silently loses half of it is worse than one that lists it.
 *
 * Nothing plays here. A recording is drawn as the frame it opens on, at the place and roughly the
 * size GitHub gives it, and pressing it opens the viewer - which is where a video is actually
 * watchable, scrubbable and closable with Escape. An inline player at the point in the argument
 * where the agent put it sounds right and is not: it is a 380px-tall control in the middle of a
 * comment you are reading, on a card that has four more things under it, and it begins playing
 * where it sits rather than where you can see it.
 *
 * `preload="metadata"` is what makes the still: the browser fetches enough to draw the first
 * frame and no more, so the strip costs a header per recording rather than a video.
 */
import { computed } from 'vue';
import { renderMd } from '../pr/diff';
import AppIcon from './AppIcon.vue';
import type { NoteMedia } from '../../focus-review';

const props = defineProps<{
  body: string;
  media?: NoteMedia[];
  /** A bare `user-attachments` link resolves through the API, which needs the pull request. */
  assetUrl?: (url: string) => string;
}>();

const emit = defineEmits<{ (e: 'open', value: { items: NoteMedia[]; at: number }): void }>();

type Part = { kind: 'text'; text: string } | { kind: 'media'; media: NoteMedia };

/** The marker the agents write, and the shape an uploaded recording takes on GitHub. */
const INLINE = /\[\[attach:([^\]]+)\]\]|^[ \t]*(https:\/\/github\.com\/user-attachments\/assets\/[^\s)]+)[ \t]*$/gm;

const parts = computed<Part[]>(() => {
  const text = String(props.body || '');
  const have = props.media || [];
  const out: Part[] = [];
  const used = new Set<string>();
  let at = 0;
  let found: RegExpExecArray | null;

  INLINE.lastIndex = 0;
  // eslint-disable-next-line no-cond-assign
  while ((found = INLINE.exec(text))) {
    if (found.index > at) {
      out.push({ kind: 'text', text: text.slice(at, found.index) });
    }

    if (found[1]) {
      const name = found[1].trim();
      const item = have.find((entry) => entry.name === name || entry.label === name);

      if (item) {
        used.add(item.src);
        out.push({ kind: 'media', media: item });
      } else {
        // The file is gone from the workspace. Saying so beats a marker rendered as literal text.
        out.push({ kind: 'text', text: `\`${ name }\` (missing)` });
      }
    } else if (found[2]) {
      out.push({
        kind:  'media',
        media: {
          kind: 'video', label: 'recording', src: props.assetUrl ? props.assetUrl(found[2]) : found[2], caption: '', name: '',
        },
      });
    }
    at = found.index + found[0].length;
  }

  if (at < text.length) {
    out.push({ kind: 'text', text: text.slice(at) });
  }

  for (const item of have) {
    if (!used.has(item.src)) {
      out.push({ kind: 'media', media: item });
    }
  }

  return out;
});

/** Everything drawn here, in the order drawn, so the viewer opens on the one that was clicked. */
const shown = computed(() => parts.value.filter((part): part is { kind: 'media'; media: NoteMedia } => part.kind === 'media').map((part) => part.media));

const open = (item: NoteMedia) => emit('open', { items: shown.value, at: Math.max(0, shown.value.indexOf(item)) });
</script>

<template>
  <div class="md">
    <template v-for="(part, n) in parts" :key="n">
      <!-- eslint-disable-next-line vue/no-v-html -- renderMd escapes authored HTML; see pr/diff.ts -->
      <div v-if="part.kind === 'text'" class="md__text" v-html="renderMd(part.text)" />

      <figure v-else class="md__media">
        <button
          type="button"
          class="md__shot"
          :title="`Open ${ part.media.label }`"
          @click="open(part.media)"
        >
          <video
            v-if="part.media.kind === 'video'"
            class="md__frame"
            :src="part.media.src"
            preload="metadata"
            muted
            playsinline
          />
          <img
            v-else
            class="md__frame"
            :src="part.media.src"
            :alt="part.media.caption || part.media.label"
            loading="lazy"
          >

          <span v-if="part.media.kind === 'video'" class="md__play"><AppIcon name="play" :size="20" /></span>
          <span class="md__open"><AppIcon name="expand" :size="13" /></span>
        </button>

        <figcaption class="md__cap">
          <span class="md__cap-text">{{ part.media.caption || part.media.label }}</span>
        </figcaption>
      </figure>
    </template>
  </div>
</template>

<style scoped>
.md {
  display: flex;
  flex-direction: column;
  gap: var(--s3);
  min-width: 0;
  color: var(--text-dim);
  font-size: var(--t-sm);
  line-height: 1.6;
}

.md__text { min-width: 0; overflow-wrap: anywhere; }

/* ── What markdown turns into ─────────────────────────────────────────────────────────────── */
.md__text :deep(p) { margin: 0 0 var(--s2); }
.md__text :deep(p:last-child) { margin-bottom: 0; }
.md__text :deep(strong) { color: var(--text); font-weight: 650; }
.md__text :deep(a) { color: var(--kind); text-decoration: none; }
.md__text :deep(a:hover) { text-decoration: underline; }

.md__text :deep(code) {
  padding: 1px 5px;
  border-radius: var(--r-sm);
  background: var(--surface-raised);
  color: var(--text);
  font-family: var(--mono);
  font-size: 0.92em;
}

.md__text :deep(pre) {
  margin: 0 0 var(--s2);
  padding: var(--s3);
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  background: var(--surface-sunk);
  overflow-x: auto;
}

.md__text :deep(pre code) { padding: 0; background: none; }

.md__text :deep(ul),
.md__text :deep(ol) { margin: 0 0 var(--s2); padding-left: var(--s5); }
.md__text :deep(li) { margin: 2px 0; }

.md__text :deep(blockquote) {
  margin: 0 0 var(--s2);
  padding-left: var(--s3);
  border-left: 2px solid var(--border-strong);
  color: var(--text-muted);
}

/* A test matrix is the most useful thing in these comments and the least readable unrendered. */
.md__text :deep(table) {
  display: block;
  width: max-content;
  max-width: 100%;
  margin: 0 0 var(--s2);
  border-collapse: collapse;
  overflow-x: auto;
  font-size: var(--t-xs);
}

.md__text :deep(th),
.md__text :deep(td) {
  padding: 4px 10px;
  border: 1px solid var(--border);
  text-align: left;
}

.md__text :deep(th) { background: var(--surface-raised); color: var(--text); font-weight: 650; }

/* ── The evidence, where the comment put it ───────────────────────────────────────────────── */
.md__media { margin: 0; min-width: 0; }

/*
 * The frame it opens on, where the comment put it.
 *
 * Narrower than GitHub's full width on purpose: this sits inside a card with a verdict and four
 * buttons under it, and a 760px still is the card. 420px is wide enough to tell what the
 * recording is of, which is all a thumbnail has to do.
 */
.md__shot {
  position: relative;
  display: block;
  width: 100%;
  max-width: 420px;
  padding: 0;
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  background: var(--surface-sunk);
  cursor: zoom-in;
  overflow: hidden;
  transition: border-color var(--fast);
}

.md__shot:hover { border-color: var(--kind); }

.md__frame {
  display: block;
  width: 100%;
  max-height: 236px;
  object-fit: cover;
  /* A video with no poster paints black before its first frame arrives. */
  background: #000;
}

.md__play,
.md__open {
  position: absolute;
  display: grid;
  place-items: center;
  border-radius: var(--r-pill);
  background: rgba(8, 10, 16, 0.7);
  color: #fff;
}

.md__play {
  inset: 50% auto auto 50%;
  width: 40px;
  height: 40px;
  transform: translate(-50%, -50%);
}

.md__open {
  top: 6px;
  right: 6px;
  width: 24px;
  height: 24px;
  opacity: 0;
  transition: opacity var(--fast);
}

.md__shot:hover .md__open { opacity: 1; }

.md__cap {
  max-width: 420px;
  margin-top: 4px;
  color: var(--text-faint);
  font-size: var(--t-xs);
  line-height: 1.4;
}

.md__cap-text { overflow-wrap: anywhere; }
</style>
