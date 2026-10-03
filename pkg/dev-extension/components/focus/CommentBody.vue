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
 * Playing happens here, inline, at something near the width GitHub gives it. Looking closely does
 * not: that is what the viewer is for, and the expand control on each one opens it.
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
        <video
          v-if="part.media.kind === 'video'"
          class="md__play"
          :src="part.media.src"
          controls
          preload="metadata"
          playsinline
        />
        <button
          v-else
          type="button"
          class="md__shot"
          :title="`Open ${ part.media.label }`"
          @click="open(part.media)"
        >
          <img :src="part.media.src" :alt="part.media.caption || part.media.label" loading="lazy">
        </button>

        <figcaption class="md__cap">
          <span class="md__cap-text">{{ part.media.caption || part.media.label }}</span>
          <button
            type="button"
            class="md__expand"
            :title="`Open ${ part.media.label } full size`"
            @click="open(part.media)"
          ><AppIcon name="expand" :size="12" /></button>
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
 * Near the width GitHub gives a recording in a review comment, and no taller than fits beside the
 * rest of the pass. It plays here; the viewer is for looking closely.
 */
.md__play {
  display: block;
  width: 100%;
  max-width: 760px;
  max-height: 380px;
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  background: #000;
}

.md__shot {
  display: block;
  max-width: 760px;
  padding: 0;
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  background: var(--surface-sunk);
  cursor: zoom-in;
  overflow: hidden;
}

.md__shot img { display: block; max-width: 100%; max-height: 380px; object-fit: contain; }

.md__cap {
  display: flex;
  align-items: center;
  gap: var(--s2);
  max-width: 760px;
  margin-top: 4px;
  color: var(--text-faint);
  font-size: var(--t-xs);
}

.md__cap-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.md__expand {
  display: grid;
  place-items: center;
  flex: 0 0 auto;
  width: 22px;
  height: 22px;
  margin-left: auto;
  border: 1px solid var(--border);
  border-radius: var(--r-pill);
  color: var(--text-muted);
  cursor: pointer;
}

.md__expand:hover { border-color: var(--kind); color: var(--text); }
</style>
