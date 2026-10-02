<script setup lang="ts">
/**
 * What changed, as a thing you can read rather than a number you have to trust.
 *
 * A tree of the files on the left - folded the way a project folds, with what each file gained
 * and lost - and that file's diff on the right.
 *
 * The lines are the point: pick one, or shift-pick a run of them, and ask about exactly that.
 * The question stays anchored under the code it is about, so a file you come back to still shows
 * what you already asked - which is the difference between a review you can do in passes and one
 * you have to do in one sitting.
 *
 * Where the answer goes is the one thing this does differently from the prototype it comes from.
 * There, the agent replied inline. Here the question goes to the conversation along the bottom of
 * the view, because that is this product's one conversation and an answer that landed inside a
 * card would be an answer you could not find again once the card was dealt. What stays under the
 * lines is the question and the fact that it was asked.
 */
import { computed, nextTick, ref, watch } from 'vue';
import type { CardFile } from '../../focus-artifacts';
import type { DiffLine } from '../../focus-review';
import AppButton from './AppButton.vue';
import AppIcon from './AppIcon.vue';
import CodeLines from './CodeLines.vue';

const props = defineProps<{ files: CardFile[]; busy?: boolean }>();

const emit = defineEmits<{ (e: 'ask', value: { path: string; label: string; code: string; text: string }): void }>();

/** A question that has been sent, kept under the lines it was about. */
interface CodeThread {
  id: string;
  path: string;
  hunk: number;
  from: number;
  to: number;
  label: string;
  text: string;
}

const openPath = ref(props.files[0]?.path ?? '');

// A different task's files, so the file that was open is not a file any more.
watch(() => props.files, (files) => {
  if (!files.some((entry) => entry.path === openPath.value)) {
    openPath.value = files[0]?.path ?? '';
    pick.value = null;
    threads.value = [];
  }
});
const folded = ref<Record<string, boolean>>({});
const pick = ref<{ hunk: number; range: [number, number] } | null>(null);
const question = ref('');
const threads = ref<CodeThread[]>([]);

const root = ref<HTMLElement>();

const file = computed(() => props.files.find((f) => f.path === openPath.value) ?? props.files[0]);

/** The tree: one entry per directory, in the order the files came in. */
const tree = computed(() => {
  const dirs: { dir: string; files: CardFile[] }[] = [];

  for (const entry of props.files) {
    const cut = entry.path.lastIndexOf('/');
    const dir = cut === -1 ? '' : entry.path.slice(0, cut);
    const found = dirs.find((d) => d.dir === dir);

    if (found) {
      found.files.push(entry);
    } else {
      dirs.push({ dir, files: [entry] });
    }
  }

  return dirs;
});

const nameOf = (path: string) => path.slice(path.lastIndexOf('/') + 1);

const totals = computed(() => props.files.reduce(
  (sum, f) => ({ added: sum.added + f.added, removed: sum.removed + f.removed }),
  { added: 0, removed: 0 },
));

function open(path: string) {
  openPath.value = path;
  pick.value = null;
}

const toggle = (dir: string) => { folded.value = { ...folded.value, [dir]: !folded.value[dir] }; };

function onPick(hunk: number, range: [number, number]) {
  pick.value = { hunk, range };
  question.value = '';
}

/** "line 42", or "lines 42–47", from whichever side of the diff the run has numbers on. */
function labelFor(lines: DiffLine[], range: [number, number]) {
  const at = (line: DiffLine) => line.new ?? line.old;
  const from = at(lines[range[0]]);
  const to = at(lines[range[1]]);

  return from === to ? `line ${ from }` : `lines ${ from }–${ to }`;
}

const picked = computed(() => {
  if (!pick.value || !file.value) {
    return null;
  }
  const lines = file.value.hunks[pick.value.hunk].lines;

  return {
    label: labelFor(lines, pick.value.range),
    code: lines.slice(pick.value.range[0], pick.value.range[1] + 1).map((l) => l.text).join('\n'),
    count: pick.value.range[1] - pick.value.range[0] + 1,
  };
});

/** Threads belonging to the open file, keyed by the line they end on. */
function threadAt(hunk: number, index: number) {
  return threads.value.filter((t) => t.path === openPath.value && t.hunk === hunk && t.to === index);
}

function ask() {
  const text = question.value.trim();

  if (!text || !pick.value || !picked.value || !file.value) {
    return;
  }
  const thread: CodeThread = {
    id:    `c-${ Date.now().toString(36) }`,
    path:  file.value.path,
    hunk:  pick.value.hunk,
    from:  pick.value.range[0],
    to:    pick.value.range[1],
    label: picked.value.label,
    text,
  };

  threads.value = [...threads.value, thread];
  emit('ask', {
    path: thread.path, label: thread.label, code: picked.value.code, text,
  });
  question.value = '';

  // The mark lands under the lines it is about, which can be off the bottom of a short pane.
  nextTick(() => root.value?.querySelector(`[data-thread="${ thread.id }"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
}

/** GitHub's own words for what happened to a file, in shorter ones. */
const statusWord: Record<string, string> = {
  added: 'new', modified: 'changed', removed: 'gone', renamed: 'moved', changed: 'changed', copied: 'copied',
};
</script>

<template>
  <section v-if="file" ref="root" class="changes">
    <header class="changes__head">
      <span class="changes__title">
        <AppIcon name="tasks" :size="14" />
        What it changed
      </span>
      <span class="changes__count">{{ files.length }} files</span>
      <span class="changes__stat changes__stat--add">+{{ totals.added }}</span>
      <span class="changes__stat changes__stat--del">−{{ totals.removed }}</span>
      <span class="changes__hint">
        {{ threads.length ? `${ threads.length } asked about` : 'Click a line to ask about it' }}
      </span>
    </header>

    <!-- The explorer. -->
    <nav class="tree" aria-label="Files the agent changed">
      <template v-for="group in tree" :key="group.dir">
        <button
          v-if="group.dir"
          type="button"
          class="tree__dir"
          :aria-expanded="!folded[group.dir]"
          @click="toggle(group.dir)"
        >
          <AppIcon :name="folded[group.dir] ? 'chevron-right' : 'chevron-down'" :size="13" />
          {{ group.dir }}
        </button>

        <template v-if="!folded[group.dir]">
          <button
            v-for="entry in group.files"
            :key="entry.path"
            type="button"
            class="tree__file"
            :class="[`tree__file--${ entry.status }`, { 'tree__file--on': entry.path === openPath }]"
            @click="open(entry.path)"
          >
            <span class="tree__name">{{ nameOf(entry.path) }}</span>
            <span class="tree__plus">+{{ entry.added }}</span>
            <span class="tree__minus">−{{ entry.removed }}</span>
          </button>
        </template>
      </template>
    </nav>

    <!-- The file. -->
    <article class="file">
      <header class="file__head">
        <code class="file__path">{{ file.path }}</code>
        <span class="file__status" :class="`file__status--${ file.status }`">{{ statusWord[file.status] }}</span>
        <span class="file__stat file__stat--add">+{{ file.added }}</span>
        <span class="file__stat file__stat--del">−{{ file.removed }}</span>
      </header>

      <div v-for="(hunk, h) in file.hunks" :key="h" class="file__hunk">
        <p class="file__hunk-head">{{ hunk.header }}</p>

        <CodeLines
          :lines="hunk.lines"
          selectable
          :picked="pick && pick.hunk === h ? pick.range : null"
          @pick="onPick(h, $event)"
        >
          <template #after="{ index }">
            <!-- A question and its answer, under the lines they belong to. -->
            <div v-for="thread in threadAt(h, index)" :key="thread.id" :data-thread="thread.id" class="anchored">
              <p class="anchored__where">{{ thread.label }}</p>
              <p class="anchored__turn">
                <span class="anchored__who">You asked</span>
                {{ thread.text }}
              </p>
              <p class="anchored__sent">
                <AppIcon name="send" :size="11" />
                Sent to the conversation below.
              </p>
            </div>
          </template>
        </CodeLines>
      </div>
    </article>

    <!-- What you picked, and the box that asks about it. -->
    <Transition name="ask">
      <div v-if="picked" class="ask">
        <span class="ask__what">
          <strong>{{ picked.count }}</strong> {{ picked.count === 1 ? 'line' : 'lines' }} ·
          <code>{{ nameOf(file.path) }}</code> {{ picked.label }}
        </span>

        <form class="ask__form" @submit.prevent="ask">
          <input
            v-model="question"
            class="ask__field"
            placeholder="Ask the agent about this code…"
            aria-label="Ask the agent about the selected lines"
          >
          <AppButton variant="kind" size="sm" icon="sparkle" :busy="busy" @click="ask">Ask</AppButton>
          <AppButton variant="quiet" size="sm" @click="pick = null">Clear</AppButton>
        </form>
      </div>
    </Transition>
  </section>
</template>

<style scoped>
.changes {
  display: grid;
  grid-template-columns: minmax(200px, 250px) minmax(0, 1fr);
  grid-template-rows: auto minmax(0, 1fr) auto;
  gap: var(--s3) var(--s5);
  min-height: 0;
}

/* ── The header ──────────────────────────────────────────────────────────── */
.changes__head {
  grid-column: 1 / -1;
  display: flex;
  align-items: center;
  gap: var(--s3);
  min-width: 0;
}

.changes__title {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--kind);
  font-size: var(--t-sm);
  font-weight: 620;
}

.changes__count { color: var(--text-muted); font-size: var(--t-sm); }
.changes__stat { font-family: var(--mono); font-size: var(--t-sm); }
.changes__stat--add { color: var(--success); }
.changes__stat--del { color: var(--danger); }
.changes__hint { margin-left: auto; color: var(--text-faint); font-size: var(--t-sm); }

/* ── The tree ────────────────────────────────────────────────────────────── */
.tree {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-height: 0;
  padding-right: var(--s2);
  overflow: hidden auto;
  touch-action: pan-y;
}

.tree__dir,
.tree__file {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 5px var(--s2);
  border: 0;
  border-radius: var(--r-sm);
  background: none;
  color: var(--text-muted);
  font: inherit;
  font-size: var(--t-sm);
  text-align: left;
  cursor: pointer;
  transition: background var(--fast), color var(--fast);
}

.tree__dir { font-family: var(--mono); font-size: var(--t-xs); letter-spacing: 0.01em; }
.tree__dir:hover { color: var(--text-dim); }

.tree__file { padding-left: var(--s4); color: var(--text-dim); }
.tree__file:hover { background: var(--surface-raised); color: var(--text); }

.tree__file--on {
  background: color-mix(in srgb, var(--kind) 14%, transparent);
  color: var(--text);
  box-shadow: inset 2px 0 0 var(--kind);
}

.tree__name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--mono);
  font-size: var(--t-xs);
}

.tree__file--added .tree__name { color: var(--success); }
.tree__file--deleted .tree__name { text-decoration: line-through; color: var(--text-faint); }
.tree__plus { color: var(--success); font-family: var(--mono); font-size: var(--t-xs); }
.tree__minus { color: var(--danger); font-family: var(--mono); font-size: var(--t-xs); }

/* ── The file ────────────────────────────────────────────────────────────── */
.file {
  display: flex;
  flex-direction: column;
  gap: var(--s3);
  min-height: 0;
  min-width: 0;
  padding-right: var(--s2);
  overflow: hidden auto;
  touch-action: pan-y;
}

.file__head { display: flex; align-items: baseline; gap: var(--s3); flex-wrap: wrap; }
.file__path { color: var(--text); font-family: var(--mono); font-size: var(--t-sm); }

.file__status {
  padding: 1px 8px;
  border-radius: var(--r-pill);
  background: var(--surface-raised);
  color: var(--text-muted);
  font-size: var(--t-xs);
  font-weight: 620;
}

.file__status--added { background: var(--success-wash); color: var(--success); }
.file__stat { font-family: var(--mono); font-size: var(--t-xs); }
.file__stat--add { color: var(--success); }
.file__stat--del { color: var(--danger); }


.file__hunk { display: flex; flex-direction: column; gap: 6px; }

.file__hunk-head {
  color: var(--text-faint);
  font-family: var(--mono);
  font-size: var(--t-xs);
}

/* ── A question, anchored to its lines ───────────────────────────────────── */
.anchored {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 0 0 var(--s1) 44px;
  padding: var(--s3);
  border-left: 3px solid var(--kind);
  background: var(--surface-raised);
  font-family: var(--font);
}

.anchored__where { color: var(--text-faint); font-family: var(--mono); font-size: var(--t-xs); }
.anchored__turn { color: var(--text-dim); font-size: var(--t-sm); line-height: 1.5; max-width: 76ch; }

.anchored__turn--you .anchored__sent {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  margin-top: 4px;
  color: var(--text-faint);
  font-size: var(--t-xs);
}

.anchored__who { color: var(--kind); }

.anchored__field:focus-visible,
.ask__field:focus-visible { outline: 2px solid var(--kind); outline-offset: 1px; }

/* ── The bar that asks ───────────────────────────────────────────────────── */
.ask {
  grid-column: 1 / -1;
  display: flex;
  align-items: center;
  gap: var(--s3);
  padding: var(--s2) var(--s3);
  border: 1px solid color-mix(in srgb, var(--kind) 40%, var(--border));
  border-radius: var(--r-pill);
  background: color-mix(in srgb, var(--kind) 9%, var(--surface-sunk));
}

.ask__what { color: var(--text-dim); font-size: var(--t-sm); white-space: nowrap; }
.ask__what strong { color: var(--text); }
.ask__what code { color: var(--text-muted); font-family: var(--mono); font-size: var(--t-xs); }
.ask__form { display: flex; align-items: center; gap: var(--s2); flex: 1; min-width: 0; }

.ask-enter-active,
.ask-leave-active { transition: opacity var(--fast) var(--ease-out), transform var(--fast) var(--ease-out); }
.ask-enter-from,
.ask-leave-to { opacity: 0; transform: translateY(6px); }


@keyframes dot {
  50% { opacity: 0.25; transform: translateY(-2px); }
}

@media (max-width: 1100px) {
  .changes { grid-template-columns: minmax(0, 1fr); grid-template-rows: auto auto minmax(0, 1fr) auto; }
  .tree { flex-direction: row; overflow: auto hidden; padding-bottom: var(--s2); }
  .tree__dir { display: none; }
  .tree__file { width: auto; flex: none; }
  .ask { flex-wrap: wrap; border-radius: var(--r-md); }
}
</style>
