<script setup lang="ts">
/**
 * The agent's review, for you to pass over.
 *
 * The agent has already read the pull request and written its comments; none of them have been
 * posted. This is the surface where you go through them one at a time and decide - keep it,
 * reword it, argue with it, or drop it - and what leaves the card is only what you agreed with.
 *
 * A comment carries the lines it is about, so the judgement can be made here rather than in a
 * diff somewhere else: the file and the run of lines, the agent's comment, and what it based
 * that on. Marking one good moves to the next one that still needs you, because the job is to
 * get to the end of the list, not to admire it.
 */
import { computed, ref, watch } from 'vue';
import type { DiffLine, ReviewNote } from '../../focus-review';
import AppButton from './AppButton.vue';
import AppIcon from './AppIcon.vue';
import CodeView from '../code/CodeView.vue';
import { fromDiffLines, highlighted } from '../code/rows';
import CommentBody from './CommentBody.vue';
import MediaViewer from './MediaViewer.vue';
import { ghAssetUrl } from '../../reviews';
import type { NoteMedia } from '../../focus-review';

/** What you decided about one comment. The prototype's word for it, and its four states. */
type NoteVerdict = 'pending' | 'good' | 'edited' | 'dropped';

/** A turn in the conversation you can have about one of the agent's comments. */
interface NoteReply { from: 'you' | 'agent'; text: string }

const props = defineProps<{ notes: ReviewNote[] }>();

/**
 * What the pass asks of the page it is on.
 *
 * It settles nothing itself: keeping, rewording and dropping are changes to a real pending
 * comment on a real pull request, and the page is what has the API for that. The prototype
 * called a mock from in here; this asks.
 */
const emit = defineEmits<{
  (e: 'progress', value: { settled: number; total: number; keeping: number }): void;
  (e: 'resolve', value: { note: ReviewNote; verdict: NoteVerdict; body?: string }): void;
  (e: 'ask', value: { note: ReviewNote; text: string }): void;
  /** Which one you are on, so the card can show that comment's evidence and not the workspace's. */
  (e: 'select', note: ReviewNote): void;
  /** Open the whole file on the lines this comment is about. See FileModal. */
  (e: 'expand', value: { path: string; mark: [number, number] }): void;
}>();

/** The comment's lines, syntax-highlighted, in the shape every code view in here takes. */
const rowsFor = (note: ReviewNote) => highlighted(fromDiffLines(note.hunk), note.path);

/** The evidence of the comment you are on, opened full size. See MediaViewer. */
const viewer = ref<{ items: NoteMedia[]; at: number } | null>(null);

const verdicts = ref<Record<string, NoteVerdict>>({});
const bodies = ref<Record<string, string>>({});
const threads = ref<Record<string, NoteReply[]>>({});
const selectedId = ref(props.notes[0]?.id ?? '');
const editingId = ref('');
const draft = ref('');
const discussingId = ref('');
const question = ref('');
const sending = ref(false);
const saving = ref('');

const selected = computed(() => props.notes.find((note) => note.id === selectedId.value) ?? props.notes[0]);
const verdictOf = (note: ReviewNote) => verdicts.value[note.id] ?? 'pending';
const bodyOf = (note: ReviewNote) => bodies.value[note.id] ?? note.body;

const settled = computed(() => props.notes.filter((note) => verdictOf(note) !== 'pending').length);
const keeping = computed(() => props.notes.filter((note) => ['good', 'edited'].includes(verdictOf(note))).length);

watch([settled, keeping], () => {
  emit('progress', { settled: settled.value, total: props.notes.length, keeping: keeping.value });
}, { immediate: true });

const verdictWord: Record<NoteVerdict, string> = {
  pending: 'needs you',
  good: 'keeping',
  edited: 'reworded',
  dropped: 'dropped',
};

/**
 * What to call one.
 *
 * `finding` is the one with no word: the agent did not say how bad it is, so neither does this.
 * See severityOf - labelling every unlabelled comment `nit` was worse than labelling none.
 */
const severityWord: Record<ReviewNote['severity'], string> = {
  blocker:  'blocker',
  nit:      'nit',
  praise:   'praise',
  question: 'question',
  finding:  'finding',
};

function select(note: ReviewNote) {
  selectedId.value = note.id;
  editingId.value = '';
  discussingId.value = '';
  emit('select', note);
}

/** The next one that still wants a decision, so a pass runs forward on its own. */
function advance(from: ReviewNote) {
  const order = props.notes;
  const start = order.findIndex((note) => note.id === from.id);
  const next = order.slice(start + 1).find((note) => verdictOf(note) === 'pending')
    ?? order.find((note) => verdictOf(note) === 'pending');

  if (next) {
    select(next);
  }
}

async function settle(note: ReviewNote, verdict: NoteVerdict) {
  const undo = verdictOf(note) === verdict;

  saving.value = note.id;
  verdicts.value = { ...verdicts.value, [note.id]: undo ? 'pending' : verdict };
  emit('resolve', { note, verdict: verdicts.value[note.id] });
  saving.value = '';
  if (!undo && verdict !== 'dropped') {
    advance(note);
  }
}

function startEdit(note: ReviewNote) {
  editingId.value = note.id;
  draft.value = bodyOf(note);
  discussingId.value = '';
}

async function saveEdit(note: ReviewNote) {
  const text = draft.value.trim();

  if (!text) {
    return;
  }
  bodies.value = { ...bodies.value, [note.id]: text };
  editingId.value = '';
  saving.value = note.id;
  verdicts.value = { ...verdicts.value, [note.id]: 'edited' };
  emit('resolve', { note, verdict: 'edited', body: bodies.value[note.id] });
  saving.value = '';
}

function discuss(note: ReviewNote) {
  discussingId.value = discussingId.value === note.id ? '' : note.id;
  editingId.value = '';
  question.value = '';
}

async function ask(note: ReviewNote) {
  const text = question.value.trim();

  if (!text || sending.value) {
    return;
  }
  sending.value = true;
  question.value = '';
  threads.value = { ...threads.value, [note.id]: [...(threads.value[note.id] || []), { from: 'you', text }] };
  // The answer does not come back here. It goes to the conversation, where everything else
  // this product asks goes - and where it is still there tomorrow.
  emit('ask', { note, text });
  threads.value = {
    ...threads.value,
    [note.id]: [...(threads.value[note.id] || []), { from: 'agent', text: 'Asked in the conversation — the answer is in the bar at the bottom.' }],
  };
  sending.value = false;
}

/**
 * The comment's own selection, as indexes into the hunk.
 *
 * The note says which lines it is about in the file's numbering; the lines are drawn from a
 * list, so the two have to be matched up once here rather than per row.
 */
function pickedRun(note: ReviewNote): [number, number] | null {
  const [from, to] = note.selects ?? [note.line, note.line];
  const inside = (line: DiffLine) => (line.new ?? -1) >= from && (line.new ?? -1) <= to;
  const first = note.hunk.findIndex(inside);

  if (first === -1) {
    return null;
  }
  let last = first;

  note.hunk.forEach((line, i) => { if (inside(line)) { last = i; } });

  return [first, last];
}
</script>

<template>
  <section v-if="selected" class="pass">
    <header class="pass__head">
      <span class="pass__title">
        <AppIcon name="sparkle" :size="14" />
        The agent's pass
      </span>
      <span class="pass__count">{{ settled }} of {{ notes.length }} decided</span>
      <span class="pass__meter" :style="{ '--at': `${ (settled / notes.length) * 100 }%` }" />
      <span class="pass__keeping">{{ keeping }} to post</span>
    </header>

    <!-- The list: what the agent found, and where each one stands. -->
    <ol class="pass__list">
      <li v-for="note in notes" :key="note.id">
        <button
          type="button"
          class="note"
          :class="[`note--${ note.severity }`, `note--is-${ verdictOf(note) }`, { 'note--on': note.id === selected.id }]"
          @click="select(note)"
        >
          <span class="note__top">
            <span class="note__sev">{{ severityWord[note.severity] }}</span>
            <span class="note__state">{{ verdictWord[verdictOf(note)] }}</span>
          </span>
          <span class="note__title">{{ note.title }}</span>
          <span class="note__where">{{ note.path.split('/').pop() }}:{{ note.line }}</span>
        </button>
      </li>
    </ol>

    <!-- The one you are on: the lines, the comment, and the four things you can do to it. -->
    <article class="pass__detail" :class="`pass__detail--${ selected.severity }`">
      <header class="detail__head">
        <span class="detail__sev">{{ severityWord[selected.severity] }}</span>
        <code class="detail__path">{{ selected.path }}</code>
        <span class="detail__lines">
          {{ selected.selects && selected.selects[0] !== selected.selects[1]
            ? `lines ${ selected.selects[0] }–${ selected.selects[1] }`
            : `line ${ selected.line }` }}
        </span>
        <span v-if="verdictOf(selected) !== 'pending'" class="detail__state" :class="`detail__state--${ verdictOf(selected) }`">
          {{ verdictWord[verdictOf(selected)] }}
        </span>
      </header>

      <div class="hunk">
        <CodeView
          :rows="rowsFor(selected)"
          :picked="pickedRun(selected)"
          expandable
          expand-label="See the whole file"
          @expand="emit('expand', { path: selected.path, mark: selected.selects || [selected.line, selected.line] })"
        />
      </div>

      <div v-if="editingId === selected.id" class="detail__edit">
        <textarea
          v-model="draft"
          class="detail__draft"
          rows="5"
          placeholder="Reword the comment. Markdown, and [[attach:name.mp4]] to place a recording."
          aria-label="Reword the comment"
          @keydown.esc.prevent="editingId = ''"
        />
        <div class="detail__edit-actions">
          <AppButton variant="kind" size="sm" @click="saveEdit(selected)">Save the wording</AppButton>
          <AppButton variant="ghost" size="sm" @click="editingId = ''">Cancel</AppButton>
        </div>
      </div>

      <template v-else>
        <!-- The comment as it will read once posted: markdown, with its evidence where it put it. -->
        <CommentBody
          class="detail__body"
          :body="bodyOf(selected)"
          :media="selected.media"
          :asset-url="ghAssetUrl"
          @open="viewer = $event"
        />
        <p v-if="selected.because" class="detail__because">
          <AppIcon name="sparkle" :size="12" />
          {{ selected.because }}
        </p>
      </template>

      <div class="detail__actions">
        <AppButton
          :variant="verdictOf(selected) === 'good' ? 'kind' : 'ghost'"
          size="sm"
          icon="check"
          :busy="saving === selected.id"
          @click="settle(selected, 'good')"
        >{{ verdictOf(selected) === 'good' ? 'Keeping it' : 'Mark good' }}</AppButton>

        <AppButton variant="ghost" size="sm" icon="pencil" @click="startEdit(selected)">Edit</AppButton>

        <AppButton
          :variant="discussingId === selected.id ? 'kind' : 'ghost'"
          size="sm"
          icon="sparkle"
          @click="discuss(selected)"
        >{{ discussingId === selected.id ? 'Discussing' : 'Discuss' }}</AppButton>

        <AppButton variant="quiet" size="sm" icon="cross" @click="settle(selected, 'dropped')">
          {{ verdictOf(selected) === 'dropped' ? 'Dropped' : 'Drop it' }}
        </AppButton>
      </div>

      <!-- The agent, under the comment it wrote, about that comment only. -->
      <div v-if="discussingId === selected.id" class="thread">
        <p v-for="(turn, n) in threads[selected.id] ?? []" :key="n" class="turn" :class="`turn--${ turn.from }`">
          <span class="turn__who">{{ turn.from === 'you' ? 'You' : 'Agent' }}</span>
          {{ turn.text }}
        </p>
        <p v-if="sending" class="turn turn--agent turn--waiting">
          <span class="turn__who">Agent</span>
          <span class="dots"><i /><i /><i /></span>
        </p>

        <form class="thread__ask" @submit.prevent="ask(selected)">
          <input
            v-model="question"
            class="thread__field"
            placeholder="Ask why, or tell it what to change…"
            aria-label="Ask the agent about this comment"
          >
          <AppButton variant="kind" size="sm" :busy="sending" @click="ask(selected)">Send</AppButton>
        </form>
      </div>
    </article>
    <!--
      Teleported: this is inside the deck's transformed, clipped card, and a `position: fixed`
      child of a transform is fixed to the transform rather than to the window. Carrying
      `.dev-focus` with it, because the view's tokens are declared there. See FocusModal.
    -->
    <Teleport to="body">
      <div class="dev-focus">
        <MediaViewer
          v-if="viewer"
          :items="viewer.items"
          :start="viewer.at"
          @close="viewer = null"
        />
      </div>
    </Teleport>
  </section>
</template>

<style scoped>
.pass {
  display: grid;
  grid-template-columns: minmax(240px, 300px) minmax(0, 1fr);
  grid-template-rows: auto minmax(0, 1fr);
  gap: var(--s3) var(--s5);
  min-height: 0;
  min-width: 0;
}

/* ── The header: how far through the pass you are ────────────────────────── */
.pass__head {
  grid-column: 1 / -1;
  display: flex;
  align-items: center;
  gap: var(--s3);
  min-width: 0;
}

.pass__title {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--kind);
  font-size: var(--t-sm);
  font-weight: 620;
  letter-spacing: 0.02em;
}

.pass__count { color: var(--text-muted); font-size: var(--t-sm); }

.pass__meter {
  position: relative;
  flex: 1;
  min-width: 40px;
  height: 4px;
  border-radius: var(--r-pill);
  background: var(--surface-raised);
  overflow: hidden;
}

.pass__meter::after {
  content: '';
  position: absolute;
  inset: 0 auto 0 0;
  width: var(--at, 0%);
  background: var(--kind);
  transition: width var(--base) var(--ease-out);
}

.pass__keeping { color: var(--text-dim); font-size: var(--t-sm); font-weight: 560; }

/* ── The list ────────────────────────────────────────────────────────────── */
.pass__list {
  display: flex;
  flex-direction: column;
  gap: var(--s2);
  min-height: 0;
  min-width: 0;
  margin: 0;
  padding: 0 var(--s2) var(--s2) 0;
  list-style: none;
  overflow: hidden auto;
  /* The deck owns the vertical gesture; this pane asks for it back. */
  touch-action: pan-y;
}

/*
 * A grid column that may be narrower than what is in it.
 *
 * The prototype's comments pointed at `src/components/Button.vue`; a real one points at
 * `pkg/rancher-components/src/components/Form/LabeledSelect/LabeledSelect.vue`, in mono, with no
 * space in it to break at. A grid item's automatic minimum is its content, so that one string
 * made the whole list 555px wider than the card it was in.
 */
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
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 5px;
  width: 100%;
  min-width: 0;
  padding: var(--s3);
  border: 1px solid var(--border);
  border-left: 3px solid var(--sev, var(--border-strong));
  border-radius: var(--r-md);
  background: var(--surface-sunk);
  color: inherit;
  text-align: left;
  font: inherit;
  cursor: pointer;
  transition: border-color var(--fast), background var(--fast), transform var(--fast) var(--ease-out);
}

.note:hover { background: var(--surface-raised); transform: translateX(2px); }

.note--on {
  border-color: color-mix(in srgb, var(--kind) 45%, var(--border));
  background: var(--surface-raised);
}

.note--blocker  { --sev: var(--danger); }
.note--nit      { --sev: var(--text-muted); }
.note--question { --sev: var(--warning); }
.note--praise   { --sev: var(--success); }

.note__top { display: flex; align-items: center; gap: var(--s2); min-width: 0; }

.note__sev {
  color: var(--sev);
  font-size: var(--t-xs);
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

.note__state {
  margin-left: auto;
  color: var(--text-faint);
  font-size: var(--t-xs);
}

.note--is-good .note__state,
.note--is-edited .note__state { color: var(--success); }
.note--is-dropped .note__state { color: var(--text-faint); }
.note--is-dropped .note__title { text-decoration: line-through; color: var(--text-faint); }

.note__title {
  min-width: 0;
  color: var(--text);
  font-size: var(--t-sm);
  font-weight: 560;
  line-height: 1.3;
  overflow-wrap: anywhere;
}

/* A path is read from its end - the file - so it keeps that end when it has to give way. */
.note__where {
  min-width: 0;
  color: var(--text-faint);
  font-family: var(--mono);
  font-size: var(--t-xs);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  direction: rtl;
  text-align: left;
}

/* ── The comment itself ──────────────────────────────────────────────────── */
.pass__detail {
  display: flex;
  flex-direction: column;
  gap: var(--s3);
  min-height: 0;
  min-width: 0;
  padding-right: var(--s2);
  overflow: hidden auto;
  touch-action: pan-y;
}

.detail__head {
  display: flex;
  align-items: baseline;
  gap: var(--s3);
  flex-wrap: wrap;
}

.detail__sev {
  padding: 2px 9px;
  border-radius: var(--r-pill);
  background: var(--sev-wash, var(--surface-raised));
  color: var(--sev, var(--text-dim));
  font-size: var(--t-xs);
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

.pass__detail--blocker  { --sev: var(--danger);     --sev-wash: var(--danger-wash); }
.pass__detail--nit      { --sev: var(--text-dim);   --sev-wash: var(--surface-raised); }
.pass__detail--question { --sev: var(--warning);    --sev-wash: var(--warning-wash); }
.pass__detail--praise   { --sev: var(--success);    --sev-wash: var(--success-wash); }

.detail__path { color: var(--text-dim); font-family: var(--mono); font-size: var(--t-sm); }
.detail__lines { color: var(--text-faint); font-size: var(--t-sm); }

.detail__state {
  margin-left: auto;
  padding: 2px 10px;
  border-radius: var(--r-pill);
  background: var(--success-wash);
  color: var(--success);
  font-size: var(--t-xs);
  font-weight: 620;
}

.detail__state--dropped { background: var(--surface-raised); color: var(--text-faint); }

/* The few lines the comment is about, so the diff does not have to be opened. */
.hunk {
  /* A long hunk scrolls rather than pushing the comment it belongs to out of the pane. */
  max-height: 156px;
  overflow: auto;
  flex: none;
  border-radius: var(--r-md);
}

/* The comment, rendered. It scrolls rather than pushing the four verdict buttons off the card. */
.detail__body {
  flex: 1 1 auto;
  min-height: 0;
  padding-right: var(--s2);
  overflow-y: auto;
}

.detail__because {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  max-width: 78ch;
  padding: var(--s2) var(--s3);
  border-left: 2px solid color-mix(in srgb, var(--kind) 40%, var(--border));
  color: var(--text-muted);
  font-size: var(--t-sm);
  line-height: 1.5;
}

.detail__draft {
  width: 100%;
  padding: var(--s3);
  border: 1px solid var(--border-strong);
  border-radius: var(--r-md);
  background: var(--surface-sunk);
  color: var(--text);
  font: inherit;
  font-size: var(--t-md);
  line-height: 1.5;
  resize: vertical;
}

.detail__draft:focus-visible { outline: 2px solid var(--kind); outline-offset: 1px; }
.detail__edit-actions { display: flex; gap: var(--s2); margin-top: var(--s2); }

/*
 * Pinned to the bottom of the pane.
 *
 * These are the whole point of the surface, and a comment long enough to scroll was pushing
 * them out of the card entirely - you could read the agent's argument but not answer it.
 */
.detail__actions {
  position: sticky;
  bottom: 0;
  z-index: 1;
  display: flex;
  align-items: center;
  gap: var(--s2);
  flex-wrap: wrap;
  margin-top: auto;
  padding: var(--s3) 0 var(--s1);
}

/* ── Arguing with it ─────────────────────────────────────────────────────── */
.thread {
  display: flex;
  flex-direction: column;
  gap: var(--s2);
  padding: var(--s3);
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  background: var(--surface-sunk);
}

.turn {
  max-width: 72ch;
  color: var(--text-dim);
  font-size: var(--t-sm);
  line-height: 1.5;
}

.turn__who {
  margin-right: 8px;
  color: var(--text-faint);
  font-size: var(--t-xs);
  font-weight: 700;
  letter-spacing: 0.05em;
  text-transform: uppercase;
}

.turn--you .turn__who { color: var(--kind); }
.turn--agent { color: var(--text); }

.thread__ask { display: flex; gap: var(--s2); margin-top: var(--s1); }

.thread__field {
  flex: 1;
  min-width: 0;
  padding: 0 var(--s3);
  height: 34px;
  border: 1px solid var(--border-strong);
  border-radius: var(--r-pill);
  background: var(--surface);
  color: var(--text);
  font: inherit;
  font-size: var(--t-sm);
}

.thread__field:focus-visible { outline: 2px solid var(--kind); outline-offset: 1px; }

.dots { display: inline-flex; gap: 3px; }
.dots i {
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: var(--text-muted);
  animation: dot 1.1s ease-in-out infinite;
}
.dots i:nth-child(2) { animation-delay: 150ms; }
.dots i:nth-child(3) { animation-delay: 300ms; }

@keyframes dot {
  50% { opacity: 0.25; transform: translateY(-2px); }
}

@media (max-width: 1100px) {
  .pass { grid-template-columns: minmax(0, 1fr); grid-template-rows: auto auto minmax(0, 1fr); }
  .pass__list {
    flex-direction: row;
    overflow: auto hidden;
    padding-bottom: var(--s2);
  }
  .note { width: 230px; flex: none; }
}
</style>
