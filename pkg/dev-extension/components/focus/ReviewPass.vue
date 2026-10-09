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
import TextModal from './TextModal.vue';
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
  (e: 'resolve', value: { note: ReviewNote; verdict: NoteVerdict; body?: string }): void;
  (e: 'ask', value: { note: ReviewNote; text: string }): void;
  /** Which one you are on, so the card can show that comment's evidence and not the workspace's. */
  (e: 'select', note: ReviewNote): void;
  /** Open the whole file on the lines this comment is about. See FileModal. */
  (e: 'expand', value: { path: string; mark: [number, number] }): void;
  /**
   * How many of them you are keeping, for the card's own `Post the review`.
   *
   * Nothing has been written to GitHub - the verdicts are this component's state - so the footer
   * had no way to know whether its primary would post anything. It arrived live on every one of
   * these cards, every one of which starts at `0 of 2 decided`, and pressing it said "Nothing was
   * left to post." and then marked the card done. See `anyKept` in focus.ts.
   *
   * A count rather than a boolean, because the next thing to want it is a label. `progress` used
   * to be emitted from here so the footer could *print* two numbers this surface already prints;
   * this one is read and not drawn.
   */
  (e: 'kept', count: number): void;
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

/*
 * `settled` lived here: how many findings had been decided, for the header's "N of M decided".
 * That header is gone - see the note in the template - and `keeping` stays, because the shell's
 * primary button is gated on it.
 */
const keeping = computed(() => props.notes.filter((note) => ['good', 'edited'].includes(verdictOf(note))).length);

watch(keeping, (count) => emit('kept', count), { immediate: true });

/** The agent's words, read over the card, when three lines of them are not the argument. */
const sayAll = ref(false);

watch(selectedId, () => { sayAll.value = false; });

/*
 * `progress` used to be emitted from here so the card's footer could print "3 of 11 kept · 8
 * still to decide" - beside this surface, which prints the same two numbers in its own meter.
 * The card said the same thing twice about a list that could not be read at all, so the footer's
 * copy is gone and this is the one place that counts.
 */

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

/**
 * One along, decided or not.
 *
 * `advance` goes to the next thing that still needs you, which is what a verdict should do. This
 * is the plain walk, for the layout where the list of notes is not on the card at all and the
 * only other way between them is the meter.
 */
function step(by: number) {
  const at = props.notes.findIndex((note) => note.id === selected.value?.id);
  const next = props.notes[(at + by + props.notes.length) % props.notes.length];

  if (next) {
    select(next);
  }
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
  <!-- `pass--few` is gone with the strip that needed it: there is one list, and it is the meter. -->
  <section v-if="selected" class="pass">

    <!--
      No header here.

      It said "The agent's pass", "N of M decided" and "K to post", and all three were already on
      the card. The chip says AGENT REVIEW and the lede says "6 findings to judge", so M was the
      lede's own number printed a second time twelve pixels away - which is what collided in the
      top-left corner when the surface grew. What each finding's state is, the list below says per
      finding, which is more than a tally; and whether anything is ready to post is what the
      footer's primary button is gated on (`anyKept`), so "0 to post" was a label for a button
      that was not there yet.
    -->

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
          <span class="note__where">{{ note.path ? `${ note.path.split('/').pop() }:${ note.line }` : 'the change as a whole' }}</span>
        </button>
      </li>
    </ol>

    <!-- The one you are on: the lines, the comment, and the four things you can do to it. -->
    <article
      class="pass__detail"
      :class="[`pass__detail--${ selected.severity }`, { 'pass__detail--nocode': !selected.path }]"
    >
      <!--
        The code, then the comment on it - the order GitHub uses and the order the work is done in:
        you read the lines, then you read what was said about them, then you decide.

        It was the other way round for a round, on the reasoning that the claim should precede its
        evidence. The reason it was moved was that the comment had been crushed to three pixels by
        a hunk with a fixed height - and putting it first did not fix that, it moved the clipping
        to its other edge: a 56px track with a fade, cutting the agent's sentence mid-word. The
        fault was the track, not the order. The hunk is capped and the comment takes the rest.
      -->
      <div v-if="selected.path" class="hunk">
        <CodeView
          :rows="rowsFor(selected)"
          :picked="pickedRun(selected)"
          :label="selected.path"
          expandable
          expand-label="See the whole file"
          @expand="emit('expand', { path: selected.path, mark: selected.selects || [selected.line, selected.line] })"
        >
          <!--
            Which file, which lines, how bad, and whether it is settled - on the panel's own bar.

            This was `.detail__head`, a row of its own above the panel saying the same four
            things, which on a narrow card was 26px of a 142px pane spent on a label the panel
            was able to carry. One bar per surface, the way the panel already draws one for a
            whole file in FileModal.
          -->
          <template #head>
            <span class="detail__lines">
              {{ selected.selects && selected.selects[0] !== selected.selects[1]
                ? `${ selected.selects[0] }–${ selected.selects[1] }`
                : selected.line }}
            </span>
            <span class="u-pill detail__sev">{{ severityWord[selected.severity] }}</span>
            <span v-if="verdictOf(selected) !== 'pending'" class="u-pill detail__state" :class="`detail__state--${ verdictOf(selected) }`">
              {{ verdictWord[verdictOf(selected)] }}
            </span>
          </template>
        </CodeView>
      </div>

      <!--
        One wrapper either way, so the grid keeps four children whichever state this is in - the
        rewording textarea takes this slot whole.
      -->
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

      <!--
        Three lines of it, cut on a fade, with the rest in the dialog.

        Nothing else is in this track. `Read it all` went to the verdict row and `because` - where
        the agent got it from - went into the dialog with the words it belongs to: a 32px control
        and a 38px aside inside a 56px track is the track spent on everything but the sentence,
        which is the fault this pane was rebuilt for. The cap is on this wrapper rather than on
        CommentBody, because CommentBody draws children and `-webkit-line-clamp` on a box with
        element children clamps the boxes - measured, `.detail__body` came back 14px tall against
        334 of content, which is no sentence at all.
      -->
      <div v-else class="detail__say">
        <CommentBody
          class="detail__body"
          :body="bodyOf(selected)"
          :media="selected.media"
          :asset-url="ghAssetUrl"
          @open="viewer = $event"
        />
      </div>

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

        <!-- The whole of what is being judged, over the card: the same answer a description gets,
             through the same dialog. A comment has no natural size either. -->
        <AppButton variant="quiet" size="sm" icon="expand" @click="sayAll = true">Read it all</AppButton>

        <!--
          Step, because below 1100px there is no list to click: the meter above is clickable but a
          pass runs in order, and `Mark good` only advances to the next *undecided* one.
        -->
        <span class="detail__step">
          <button type="button" class="step" title="The one before" @click="step(-1)">‹</button>
          <button type="button" class="step" title="The next one" @click="step(1)">›</button>
        </span>
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
    <!-- The whole of the agent's argument, over the card. TextModal teleports itself. -->
    <TextModal
      v-if="sayAll"
      :title="`${ severityWord[selected.severity] } · ${ selected.title }`"
      :text="selected.because ? `${ bodyOf(selected) }\n\n---\n\n${ selected.because }` : bodyOf(selected)"
      :at="selected.path ? `${ selected.path }:${ selected.line }` : 'the change as a whole'"
      @close="sayAll = false"
    />

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
/*
 * The surface takes the room, and it has to say so.
 *
 * Every child of `.card__body` is `flex-shrink: 1`, so this grid was outbid by the evidence band
 * above it: measured 28px of pass - a card headed "Go through the agent's findings (round 2)" with
 * "0 of 8 decided" and no findings on it - under 129px of band, 95px of which was one video
 * thumbnail. See the budget on `.card__body`, which now gives every surface a floor.
 */
.pass {
  display: grid;
  grid-template-columns: minmax(240px, 300px) minmax(0, 1fr);
  /*
   * One row, not two.
   *
   * The first was the header's, spanning both columns. With the header gone the list and the
   * detail would both land in that `auto` track - content-sized, so a long findings list or a
   * 16,000px diff would size the row and the pane would grow out of the card. `grid-template-rows`
   * has to name the rows a grid actually has: this one has one.
   */
  grid-template-rows: minmax(0, 1fr);
  gap: var(--s3) var(--s5);
  flex: 1 1 auto;
  min-height: 0;
  min-width: 0;
}

/*
 * A note with nowhere to point: the review's own comment.
 *
 * Three tracks become two. The first exists to hold the code beside the claim, and this claim
 * is about the change as a whole - there is no hunk, the `.hunk` child is not rendered, and a
 * grid told to lay out three rows with two children leaves the verdicts stranded in the middle
 * track with a gap beneath them.
 */
.pass__detail--nocode { grid-template-rows: minmax(0, 1fr) auto; }

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

/*
 * The meter, which is the list of findings.
 *
 * The row is `--control-h` tall so each segment is a real target - the bar inside it is 4px, so
 * it still reads as a meter and not as a row of buttons - and the segments share the width, so a
 * pass of three is three wide bands and a pass of twenty is twenty narrow ones.
 */

/* Decided: filled in the finding's own severity, which is the colour its row carries. */
.seg--blocker  { --sev: var(--danger); }

/* The one you are reading: taller, and in the card's hue whatever its verdict. */

.pass__keeping { color: var(--text-dim); font-size: var(--t-sm); font-weight: 560; }

/* ── The list ────────────────────────────────────────────────────────────── */
.pass__list {
  display: flex;
  flex-direction: column;
  gap: var(--s2);
  min-height: 0;
  min-width: 0;
  margin: 0;
  /* The fade's own room; see `.u-fade-y` in design/focus.css. */
  padding: 0 var(--s2) var(--s5) 0;
  list-style: none;
  overflow: hidden auto;
  /* The deck owns the vertical gesture; this pane asks for it back. */
  touch-action: pan-y;
  /*
   * The fade, written out rather than taken from `.u-fade-y` in design/focus.css, because this is
   * the one scroller in the view whose axis changes with the breakpoint - a column down the side
   * at width, a strip along the top when the card is narrow - and a class cannot follow that. The
   * reason for it is the utility's: a cut through the middle of a glyph reads as a rendering
   * fault, a fade reads as a scroller, and these are the same pixels either way.
   */
  scroll-snap-type: y proximity;
  mask-image: linear-gradient(to bottom, #000 calc(100% - var(--s5)), transparent 100%);
}

.pass__list > li { scroll-snap-align: start; }

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

/*
 * Neither of these wraps.
 *
 * `needs you` broke after `needs` inside a 34px chip - two half-height lines where a two-word
 * label belongs - because a flex item's automatic minimum lets it be squeezed to its longest word.
 */
.note__sev,
.note__state { flex: 0 0 auto; white-space: nowrap; }

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
/*
 * Four tracks: which file, what the agent says, the code it says it about, and the verdict.
 *
 * It was a column of flex children where every one of them had an opinion and the pane had 129px:
 * `.detail__head` 26px pinned, `.hunk` at `flex: none; max-height: 156px` (a cap 27px *larger*
 * than the pane it lives in) measuring 100px, `.detail__actions` sticky at the foot, and
 * `.detail__body` - the agent's actual words, which is the thing being judged - taking what was
 * left, which measured about three pixels against a natural 122. 59% of the finding was below the
 * fold, and the screenshot shows four verdict buttons sitting on top of a bisected code line.
 *
 * As tracks, each one's share is written down: the path line and the verdict row are `auto` and
 * cannot be squeezed, the agent's sentence is `auto` and clamped to three lines with the rest in
 * TextModal, and the hunk is the `minmax(0, 1fr)` - the one thing here that is a scroller, which
 * is what evidence should be. The pane itself stops scrolling, so nothing can hide the verdicts by
 * being long.
 */
/*
 * And the tracks are written down, because `auto` beside `1fr` in a box that cannot afford both is
 * the same starvation one level up. Measured with the say track at `auto`: the pane's computed rows
 * were `26px 97px 0px 32px` - the sentence took 97 and the hunk, the one thing here that is meant
 * to scroll, got nothing at all.
 *
 * 191px, which is what the surface leaves after the meter: 26 (the path line) + 56 (three lines of
 * 13px at 1.45) + 53 (the hunk, which is two code rows and the row that opens the whole file) + 32
 * (the verdicts) + three 8px gaps. `--s2` rather than `--s3` between them, because 36px of gap in
 * 191 is a fifth of the pane spent on air.
 */
.pass__detail {
  display: grid;
  /*
   * The code, the comment, the verdicts.
   *
   * There was a fourth track above these - a row carrying the path, the line range and the two
   * pills - and the panel below it already has a bar to carry all four. The pills are on that bar
   * now and this is three tracks.
   *
   * The comment's track was a fixed 56px - three lines and a fade - which is how a sentence came
   * to be cut mid-word on a card whose whole question is whether that sentence is right. It takes
   * the remainder now and scrolls; the code is what is capped, because a hunk is six lines either
   * side of a change and reads fine at any height.
   *
   * `fit-content(50%)` rather than `minmax(0, auto)`, which was the same bug one track over. An
   * `auto` track's base size is its max-content, and a hunk's max-content is the whole hunk - 346px
   * of it in a 192px pane - so the free space `1fr` divides was already negative and the comment's
   * track came out at **0px**: `.detail__say` measured `h: 0` against `scrollHeight: 122`, the
   * agent's sentence not drawn at all on the card whose one question is whether it is right.
   * `.hunk { max-height: 50% }` could not save it, because a max-height on the item does not shrink
   * the track it sits in. `fit-content(50%)` is min(max-content, half the pane) applied to the
   * track, which is what "capped at half the pane" was supposed to mean both times.
   */
  grid-template-rows: fit-content(50%) minmax(0, 1fr) auto;
  gap: var(--s2);
  min-height: 0;
  min-width: 0;
  overflow: hidden;
}

/*
 * `.detail__head` lived here: a row above the panel saying which file, which lines, how bad and
 * whether it was settled. All four are on the panel's own bar now - see the `#head` slot above -
 * because a second header for one thing cost this pane 26px of its 142px, and the panel draws a
 * bar either way the moment it is given a label.
 */

.detail__step { display: inline-flex; align-items: center; gap: 2px; margin-left: auto; }

.step {
  display: grid;
  place-items: center;
  width: var(--control-h);
  height: var(--control-h);
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  background: none;
  color: var(--text-muted);
  font: inherit;
  font-size: var(--t-md);
  line-height: 1;
  cursor: pointer;
}

.step:hover { border-color: var(--border-strong); color: var(--text); }

/* Both of these are `.u-pill` now; what is theirs is the colour and the voice. */
.detail__sev {
  flex: 0 0 auto;
  background: var(--sev-wash, var(--surface-raised));
  color: var(--sev, var(--text-dim));
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

.pass__detail--blocker  { --sev: var(--danger);     --sev-wash: var(--danger-wash); }
.pass__detail--nit      { --sev: var(--text-dim);   --sev-wash: var(--surface-raised); }
.pass__detail--question { --sev: var(--warning);    --sev-wash: var(--warning-wash); }
.pass__detail--praise   { --sev: var(--success);    --sev-wash: var(--success-wash); }

/*
 * `.detail__path` lived here, with its own `rtl` clip to keep the end of the path. The panel's
 * label does that now, for every surface that draws a hunk rather than for this one - see
 * `.cv__label--path`.
 *
 * What is left on the bar is the line range and the two pills, so they sit in the bar's type
 * rather than the pane's: `--t-xs` beside the panel's own label, and the range without the word
 * "line" in front of it, which the gutter under it is already saying.
 */
.detail__lines {
  flex: 0 0 auto;
  color: var(--text-faint);
  font-size: var(--t-xs);
  white-space: nowrap;
}

/* To the right of the bar, where the state of a file sits on GitHub's own. */
.detail__sev { margin-left: auto; }

.detail__state {
  flex: 0 0 auto;
  background: var(--success-wash);
  color: var(--success);
  font-weight: 620;
}

.detail__state--dropped { background: var(--surface-raised); color: var(--text-faint); }

/*
 * The few lines the comment is about, and the one thing in this pane that scrolls.
 *
 * `max-height: 156px` lived here, which was 27px taller than the 129px pane it was inside - so the
 * cap did nothing but guarantee the hunk ate everything the sentence above it needed. It is a
 * track now and it takes the remainder, whatever that is.
 */
.hunk {
  min-height: 0;
  overflow: auto;
  border-radius: var(--r-md);
  /*
   * `max-height: 50%` lived here, and once the track became `fit-content(50%)` it capped the hunk
   * twice: a percentage height resolves against the grid *area*, which is already half the pane,
   * so the hunk drew at 37px inside the 74px track it had been given. One cap, on the track.
   */
}

/*
 * What the agent said, and the reason it said it: three lines, with the rest over the card.
 *
 * A comment has no natural size, which is the same thing a pull request's description has and the
 * same answer: a control that says what it opens, and TextModal. It was `flex: 1 1 auto` in a pane
 * with nothing to spare, which is how it came to be three pixels tall.
 */
/*
 * The comment, with the room to be read.
 *
 * It was `-webkit-line-clamp: 3` with a fade over the last line, inside a 56px track - a sentence
 * cut mid-word on the card whose one question is whether that sentence is right. It scrolls now
 * and nothing is hidden.
 */
.detail__say {
  min-height: 0;
  min-width: 0;
  padding-right: var(--s2);
  overflow-y: auto;
}

.detail__body { min-width: 0; }

/*
 * `.detail__because` lived here: the agent's own note about where it got the finding from, drawn
 * as a bordered aside under the comment. It is in the dialog with the comment now - see `sayAll` -
 * because a 38px aside inside the 56px track that holds the sentence being judged is the track
 * spent on the footnote instead of the claim.
 */

/*
 * Rewording spans the sentence's track and the hunk's: a five-row textarea does not fit 56px, and
 * while you are writing the comment the code it is about is not what you are reading.
 */
.detail__edit {
  grid-row: 2 / 4;
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden auto;
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
/*
 * The fourth track, not an overlay on the third.
 *
 * These are the whole point of the surface and they were the thing that could not be reached: the
 * pane they sat in had a computed height of 0, so they painted at card-relative 386-434 while the
 * footer occupied 402-463, and `elementFromPoint` over the verdict row returned a footer button.
 * Then they were `position: sticky` over a pane that scrolled, which is how they came to sit on
 * top of a half-drawn line of code. A row with a track of its own is on screen because it has
 * somewhere to be, and nothing is underneath it.
 */
.detail__actions {
  display: flex;
  align-items: center;
  gap: var(--s2);
  flex-wrap: nowrap;
  min-width: 0;
  overflow-x: auto;
  scrollbar-width: none;
}

.detail__actions::-webkit-scrollbar { height: 0; }

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

/*
 * Narrow: one finding, and no list.
 *
 * This is the layout that ships - the view runs at 1024px - and it was the one that could not be
 * used at all. The list lay along the top as a strip of 230px note cards and the detail took
 * `minmax(0, 1fr)` of what was left, which was nothing: measured, `.pass` computed its rows as
 * `19.5px 83.5px 0px` inside a 127px surface, so `.pass__detail` had a height of 0 against a
 * scrollHeight of 288. Its contents painted outside the card - the code of the finding at
 * card-relative 398-860 inside a 488px card, 372px past its bottom edge - and the four verdict
 * buttons landed under the footer, where `elementFromPoint` returned a footer button. The card
 * said `0 of 2 decided · 0 to post` and its primary could only ever answer "N comments are still
 * pending", because the buttons that un-pend them were not reachable.
 *
 * Three ways out were tried on paper. Capping the strip at 72px and flooring the detail at 120
 * sums to 242px of rows in a 180px box, which is the same overflow one row further down. Shrinking
 * the notes to 32px pills leaves the detail 90px, which is a severity row and no code. So: the
 * strip goes, and the meter in the head - which already draws one segment per finding, in its
 * severity, and is clickable - is the list. Nothing is lost that was readable; a 230px card
 * holding a title and a path was never the thing being decided.
 *
 * What the detail gets: 180 (the surface) − 32 (the head) − 12 = 136px, with the verdict row
 * sticky at its foot so it is on screen whatever is being read, the hunk capped at five code rows,
 * and the agent's sentence clamped to three lines. Everything above the verdicts is reachable by
 * scrolling the pane, which is what a pane with a height can do.
 */
@media (max-width: 1100px) {
  /*
   * Three children, three tracks.
   *
   * It declared two - `auto minmax(0, 1fr)` - against the head, the list and the detail, and an
   * implicit grid row is `auto`: the detail took an implicit third row sized to its own content,
   * which left the free space `1fr` divides at zero and gave the **list** a 0px track. Its two
   * 103px rows then drew outside it, over the panel below - the findings list painting through
   * the code on every narrow review card. `grid-template-rows` has to name every row a grid
   * actually has; the one it leaves out is the one that breaks it.
   */
  .pass { grid-template-columns: minmax(0, 1fr); grid-template-rows: auto minmax(0, 1fr); }

  /*
   * The code gets less of a small pane, because what is left is the sentence being judged.
   *
   * Half of a 149px pane is 74px of hunk against 26px of comment - two code rows beside a line and
   * a half of the claim they are evidence for, which is the wrong way round on this card. 40%
   * leaves the comment 41px and the hunk still shows the changed line and its neighbour. At width
   * the pane is big enough that half of it is several lines of each, so the base rule stands.
   */
  .pass__detail { grid-template-rows: fit-content(40%) minmax(0, 1fr) auto; }

  /*
   * The strip the fade above has been describing since it was written: "a column down the side at
   * width, a strip along the top when the card is narrow".
   *
   * It was the column at both widths, and a stacked row is 103px tall - so on a 235px pane two
   * findings asked for 206px and the detail below them was left with 121, of which the hunk took
   * half and the agent's sentence got **12**. The list was not too long; each row was three lines
   * of a layout that only makes sense in a 240px column.
   *
   * One line each here: how bad, what it is, where it stands. The track is `auto`, so the strip
   * costs its own 34px and the whole of the rest is the detail's - which is where the code and the
   * sentence being judged are.
   */
  .pass__list {
    flex-direction: row;
    align-items: start;
    padding: 0 0 var(--s2);
    overflow: auto hidden;
    scroll-snap-type: x proximity;
    /* The fade follows the axis, which is the reason it is written out here at all. */
    mask-image: linear-gradient(to right, #000 calc(100% - var(--s5)), transparent 100%);
    touch-action: pan-x;
  }

  .note {
    display: flex;
    align-items: center;
    gap: var(--s2);
    width: auto;
    /* Enough for a finding's title to be told from its neighbour, never enough to be the card. */
    max-width: 280px;
    min-height: var(--control-h);
    padding: 0 var(--s3);
  }

  /* So the severity and the state sit on the chip's one line rather than in a row of their own. */
  .note__top { display: contents; }

  /*
   * And the state goes to the end of that line. `.note__top` holds it before the title in the
   * markup, which is the order a stacked row wants - the label above, the title under it - and on
   * one line it put `needs you` between the severity and the thing that says which finding this
   * is. What identifies the chip comes first; how it stands comes last, against the far edge.
   */
  .note__state { order: 1; }

  .note__title { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

  /*
   * The file and the line, which the panel's own bar now says for the finding you are on, and
   * which will not fit on a 280px chip beside the thing that identifies it: its title.
   */
  .note__where { display: none; }

  .note:hover { transform: none; }
  /*
   * No caps here any more. `.hunk { max-height: 100px }` and `.detail__body { max-height: 56px }`
   * were this fault treated at the symptom: the hunk's cap was larger than the pane on the wide
   * layout and smaller than it needed on the narrow one, and the body's cap was a guess at three
   * lines. The pane is four tracks now (see `.pass__detail`), so the hunk takes the remainder and
   * the sentence is clamped by line count rather than by pixels - at either width.
   */
}
</style>
