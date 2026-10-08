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
import type { CardFile, CardComment } from '../../focus-artifacts';
import type { DiffLine } from '../../focus-review';
import AppButton from './AppButton.vue';
import AppIcon from './AppIcon.vue';
import SectionHead from './SectionHead.vue';
import CodeView from '../code/CodeView.vue';
import { fromDiffLines, highlighted } from '../code/rows';
import InlineChat from './InlineChat.vue';
import Markdown from './Markdown.vue';
import { listConversations, startConversation, queuePrompt, paneCommand } from '../../conversations';
import { linesPrompt } from '../../reviews';

const props = withDefaults(defineProps<{
  files: CardFile[];
  /** The workspace whose agent answers questions about this change. */
  workspace?: string;
  /** The pull request, when there is one, so the question names it. */
  pr?: number;
  /** False on a card that is not on top: its conversations read nothing. */
  live?: boolean;
  /**
   * Every comment on this change: the ones already on the pull request and the agent's own,
   * still waiting for your pass. Both, because while reading a diff the question is "has
   * anything been said about this line", and who said it is the second question.
   */
  comments?: CardComment[];
  busy?: boolean;
  /**
   * How many files the change really has, where that is more than were fetched.
   *
   * The card showed "157 FILES +13281 ADDED" in its evidence row and "What it changed · 40 files"
   * four lines under it, and presented both as the size of the same change - because `files` is
   * capped at the first 40 with a patch while the stat is the pull request's own total. Two
   * numbers for one thing, neither of them labelled. The header says which this is.
   */
  total?: number;
  /**
   * The fact the card's 36px lede already said. See `claimed` in FocusCard.
   *
   * On draft-pr and describe-pr the lede is `13 files changed` and this head read `13 files` 150px
   * below it. Where the list is a *subset* the count is a different fact and stays - "first 40 of
   * 157 files" says the list is not the change - which is the one case this head was written for.
   */
  claimed?: string;
}>(), { busy: false, total: 0, claimed: '', workspace: '', pr: 0, live: true, comments: () => [] });

/** The count beside the head's label, or nothing where the lede has already said it. */
const subset = computed(() => {
  if (props.total > props.files.length) {
    return `first ${ props.files.length } of ${ props.total } files`;
  }

  return props.claimed === 'files' ? '' : `${ props.files.length } files`;
});

const emit = defineEmits<{
  (e: 'ask', value: { path: string; label: string; code: string; text: string }): void;
  (e: 'expand', value: { path: string; mark: [number, number] }): void;
}>();

/** A question that has been sent, kept under the lines it was about. */
interface CodeThread {
  id: string;
  path: string;
  hunk: number;
  from: number;
  to: number;
  label: string;
  text: string;
  /**
   * The conversation this question has, which is its own.
   *
   * Asking used to hand the question to whatever thread the deck's bar was on, and leave a note
   * under the lines saying "sent to the conversation below" - so the answer was somewhere else
   * on the page, mixed in with whatever had been asked about the card before it. A question
   * about four lines of a diff is its own subject; it gets its own thread, named for the lines,
   * and the thread is drawn where the question was asked.
   */
  session: string;
  /** While the conversation is being found or made. */
  opening: boolean;
  error: string;
}

/**
 * The file this opens on: the one with the most changed lines in it.
 *
 * It opened on whichever file GitHub happened to send first, which on a 66-file pull request is
 * a lockfile or a snapshot about half the time - so the first thing a reviewer saw was the one
 * file nobody reads, and the first thing they did was go and find the big one. Churn is the
 * closest thing there is to "where the change actually is", and it costs a sort.
 */
const biggest = (files: CardFile[]) => [...files]
  .sort((a, b) => (b.added + b.removed) - (a.added + a.removed))[0]?.path ?? '';

const openPath = ref(biggest(props.files));

// A different task's files, so the file that was open is not a file any more.
watch(() => props.files, (files) => {
  if (!files.some((entry) => entry.path === openPath.value)) {
    openPath.value = biggest(files);
    pick.value = null;
    threads.value = [];
  }
});
const folded = ref<Record<string, boolean>>({});
const pick = ref<{ hunk: number; range: [number, number] } | null>(null);
const question = ref('');
const threads = ref<CodeThread[]>([]);

/* ── What has been said about this change ─────────────────────────────────────────────────── */

/** Comments by the file they are on, newest-line last, so the tree can mark a file at a glance. */
const commentsByPath = computed(() => {
  const out = new Map<string, CardComment[]>();

  for (const comment of props.comments || []) {
    if (!comment.path) {
      continue;
    }
    const list = out.get(comment.path) || [];

    list.push(comment);
    out.set(comment.path, list);
  }
  for (const list of out.values()) {
    list.sort((a, b) => (a.line || 0) - (b.line || 0));
  }

  return out;
});

const commentsOn = (path: string) => commentsByPath.value.get(path) || [];

/** The open file's comments, listed under its row in the tree. */
const hereComments = computed(() => commentsOn(openPath.value));

/**
 * The comments anchored to one drawn row.
 *
 * A review comment names a line in the file; a row knows which line it is (`new` on the diff
 * line). Anything whose line is not in a hunk that was loaded has nowhere to sit - it is still
 * listed in the tree, where it can at least be read.
 */
function commentsAt(hunkIndex: number, rowIndex: number): CardComment[] {
  const line = file.value?.hunks?.[hunkIndex]?.lines?.[rowIndex]?.new;

  if (!line) {
    return [];
  }

  return hereComments.value.filter((comment) => comment.line === line);
}

/** Bring one into view, from the list in the tree. */
function showComment(comment: CardComment): void {
  if (comment.path !== openPath.value) {
    open(comment.path);
  }
  nextTick(() => {
    const el = root.value?.querySelector(`[data-comment="${ comment.id }"]`);

    el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  });
}

/** The question people ask of a run of lines most often, as a button. */
const SUMMARISE = 'In one or two lines, what do these lines do?';

/** Offered inside a thread that is already open, for the next question rather than the first. */
const SHORTCUTS = [
  { label: 'Summarise', prompt: SUMMARISE },
  { label: 'Why?', prompt: 'Why is this written this way rather than the obvious alternative?' },
  { label: 'Risks', prompt: 'What could go wrong with this, and what is not covered by a test?' },
];

const root = ref<HTMLElement>();

const file = computed(() => props.files.find((f) => f.path === openPath.value) ?? props.files[0]);

/** The tree: one entry per directory, biggest change first, for the reason `biggest` gives. */
const tree = computed(() => {
  const dirs: { dir: string; files: CardFile[] }[] = [];
  const byChurn = [...props.files].sort((a, b) => (b.added + b.removed) - (a.added + a.removed));

  for (const entry of byChurn) {
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

/** The first and last numbered line of a hunk, for opening the file on it. */
function lineSpan(lines: DiffLine[]): [number, number] {
  const numbers = lines.map((line) => line.new ?? line.old).filter((n): n is number => typeof n === 'number');

  return numbers.length ? [numbers[0], numbers[numbers.length - 1]] : [1, 1];
}

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

/**
 * The conversation for one run of lines: the one already named for them, or a new one.
 *
 * Named rather than found by position, so coming back to the same lines tomorrow opens what was
 * said about them yesterday. `openConversation` is not used because its fallback is "any
 * conversation in this workspace", which is right for "talk to the agent" and wrong here: a
 * question about these four lines must not land in the thread about the last four.
 */
async function conversationFor(title: string): Promise<{ id: string; attach: unknown }> {
  const existing = await listConversations(props.workspace).catch(() => []);
  const found = existing.find((c) => c.title === title);

  return found || await startConversation(props.workspace, title);
}

/**
 * Update a thread through the array, not through the object that was pushed into it.
 *
 * `threads` is a deep ref, so what the template renders is a proxy of the object - and the
 * local `thread` handed around here is the raw one. Writing `thread.session` on the raw object
 * changes the data and tells Vue nothing, which is why the first version of this sat on
 * "Opening a conversation about these lines…" for ever while the conversation behind it was
 * perfectly ready.
 */
function patch(id: string, fields: Partial<CodeThread>): void {
  const found = threads.value.find((t) => t.id === id);

  if (found) {
    Object.assign(found, fields);
  }
}

async function openThread(thread: CodeThread, code: string): Promise<void> {
  const title = `${ thread.path.split('/').pop() } ${ thread.label }`;

  try {
    const conversation = await conversationFor(title);
    const prompt = props.pr
      ? linesPrompt(props.pr, {
        path: thread.path, line: thread.to, startLine: thread.from === thread.to ? null : thread.from, side: 'RIGHT', code,
      }, thread.text)
      : `About ${ thread.path } ${ thread.label }:\n\n\`\`\`\n${ code }\n\`\`\`\n\n${ thread.text }`;

    await queuePrompt((conversation as { attach: never }).attach, prompt).catch(() => {});
    patch(thread.id, { session: conversation.id });
  } catch (e) {
    patch(thread.id, { error: (e as Error)?.message || String(e) });
  } finally {
    patch(thread.id, { opening: false });
  }
}

function ask(text = question.value.trim()) {
  if (!text || !pick.value || !picked.value || !file.value) {
    return;
  }
  const thread: CodeThread = {
    id:      `c-${ Date.now().toString(36) }`,
    path:    file.value.path,
    hunk:    pick.value.hunk,
    from:    pick.value.range[0],
    to:      pick.value.range[1],
    label:   picked.value.label,
    text,
    session: '',
    opening: true,
    error:   '',
  };

  threads.value = [...threads.value, thread];
  if (props.workspace) {
    openThread(thread, picked.value.code);
  } else {
    // No workspace, no agent: the question goes where it used to, so a card without one is no
    // worse off than before.
    patch(thread.id, { opening: false });
    emit('ask', {
      path: thread.path, label: thread.label, code: picked.value.code, text,
    });
  }
  question.value = '';

  // The mark lands under the lines it is about, which can be off the bottom of a short pane.
  nextTick(() => root.value?.querySelector(`[data-thread="${ thread.id }"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
}

/**
 * GitHub's own words for what happened to a file, in shorter ones.
 *
 * `modified` is not in here on purpose: nearly every file in a diff is modified, so a badge
 * saying so on every file is a badge saying nothing. What is worth a word is the file that is new,
 * gone or moved - which is the one case where the +/− pair beside it is misleading on its own.
 */
const statusWord: Record<string, string> = {
  added: 'new', removed: 'gone', renamed: 'moved', copied: 'copied',
};
</script>

<template>
  <section v-if="file" ref="root" class="changes">
    <SectionHead
      class="changes__head"
      label="What it changed"
      :count="subset"
    >
      <!--
        No `+added −removed` here. It was the sum over the shown subset, not over the change, so it
        sat 26px under the authoritative totals on the facts strip as a second unlabelled pair that
        contradicted them: "157 FILES +13281 ADDED −507 REMOVED" on the strip against "+268 −139"
        on this head, on the same card; "+1725 −1426" against "+1502 −1402" on another; "+2819 −5"
        against "+1620 −5" on a third. The count beside the label does its job - it says the list
        is the first 40 of 157 - and is the one number here that is about the subset on purpose.
      -->
      <!--
        The file being read, named here rather than in a header of its own.

        `.file__head` was a second heading inside the pane, and on nine of the eleven cards with a
        diff it measured 0px tall against a scrollHeight of 16 - so the path of the file you were
        looking at was not drawn at all, and the 38px it wanted when it did draw came off the code.
        One header per surface, which is what SectionHead is for.
      -->
      <code class="changes__path" :title="file.path">{{ file.path }}</code>
      <span v-if="statusWord[file.status]" class="u-badge">{{ statusWord[file.status] }}</span>
      <span class="changes__stat changes__stat--add">+{{ file.added }}</span>
      <span class="changes__stat changes__stat--del">−{{ file.removed }}</span>
      <span class="changes__hint">
        {{ threads.length ? `${ threads.length } asked about` : 'Click a line to ask about it' }}
      </span>
    </SectionHead>

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
          <span class="tree__dirname">{{ group.dir }}</span>
        </button>

        <template v-if="!folded[group.dir]">
          <template v-for="entry in group.files" :key="entry.path">
            <button
              type="button"
              class="tree__file"
              :class="[`tree__file--${ entry.status }`, { 'tree__file--on': entry.path === openPath }]"
              @click="open(entry.path)"
            >
              <span class="tree__name">{{ nameOf(entry.path) }}</span>
              <!--
                That something has been said about this file, before it is opened. Without it the
                only way to find the commented files in a sixty-file change is to open all sixty.
              -->
              <span
                v-if="commentsOn(entry.path).length"
                class="tree__said"
                :title="`${ commentsOn(entry.path).length } comment${ commentsOn(entry.path).length === 1 ? '' : 's' } on this file`"
              >
                <AppIcon name="comment" :size="11" />
                {{ commentsOn(entry.path).length }}
              </span>
              <span class="tree__plus">+{{ entry.added }}</span>
              <span class="tree__minus">−{{ entry.removed }}</span>
            </button>

            <!--
              The open file's comments, by line, under its own row. Only the open one: a list
              under every file is the whole review in the margin, and the point of the tree is
              to be a map of where to go next.
            -->
            <ul v-if="entry.path === openPath && hereComments.length" class="tree__lines">
              <li v-for="comment in hereComments" :key="comment.id">
                <button type="button" class="tree__line" @click="showComment(comment)">
                  <span class="tree__line-n">{{ comment.line ? `line ${ comment.line }` : 'on the file' }}</span>
                  <span v-if="comment.pending" class="tree__line-tag">yours, unsent</span>
                  <span v-else-if="comment.mine" class="tree__line-tag">yours</span>
                  <span v-else class="tree__line-who">{{ comment.author }}</span>
                </button>
              </li>
            </ul>
          </template>
        </template>
      </template>
    </nav>

    <!-- The file. -->
    <article class="file u-fade-y">
      <div v-for="(hunk, h) in file.hunks" :key="h" class="file__hunk">
        <CodeView
          :rows="highlighted(fromDiffLines(hunk.lines), file.path)"
          :label="hunk.header"
          selectable
          :picked="pick && pick.hunk === h ? pick.range : null"
          :expandable="h === 0"
          expand-label="See the whole file"
          @pick="onPick(h, $event)"
          @expand="emit('expand', { path: file.path, mark: lineSpan(hunk.lines) })"
        >
          <template #after="{ index }">
            <!--
              The box that asks, under the run of lines it would ask about.

              It was a bar across the bottom of the pane, which meant the lines were up here and
              the question was down there with the file and the range repeated in it so you knew
              what you were typing about. Here there is nothing to repeat: it is under the rows
              it belongs to, the thread opens in its place, and continuing is the thread's own
              box rather than this one.
            -->
            <div v-if="pick && pick.hunk === h && pick.range[1] === index" class="ask">
              <form class="ask__form" @submit.prevent="ask()">
                <input
                  v-model="question"
                  class="ask__field"
                  placeholder="Ask the agent about this code…"
                  aria-label="Ask the agent about the selected lines"
                >
                <AppButton variant="quiet" size="sm" :busy="busy" title="Ask what these lines do" @click="ask(SUMMARISE)">Summarise</AppButton>
                <AppButton variant="kind" size="sm" icon="sparkle" :busy="busy" @click="ask()">Ask</AppButton>
                <AppButton variant="quiet" size="sm" @click="pick = null">Clear</AppButton>
              </form>
            </div>

            <!--
              What has already been said about this line: the pull request's comments and the
              agent's own, unsent ones. Above the questions, because a comment is the record and
              a question is something happening now.
            -->
            <div
              v-for="comment in commentsAt(h, index)"
              :key="`k-${ comment.id }`"
              :data-comment="comment.id"
              class="said"
              :class="{ 'said--mine': comment.mine || comment.pending }"
            >
              <p class="said__who">
                <AppIcon name="comment" :size="11" />
                <strong>{{ comment.pending ? 'Yours, not sent yet' : comment.mine ? 'You' : comment.author }}</strong>
                <span v-if="comment.line" class="said__line">line {{ comment.line }}</span>
              </p>
              <Markdown class="said__body" :text="comment.body" />
            </div>

            <!-- A question and its answer, under the lines they belong to. -->
            <div v-for="thread in threadAt(h, index)" :key="thread.id" :data-thread="thread.id" class="anchored">
              <p class="anchored__where">{{ thread.label }}</p>
              <p class="anchored__turn">
                <span class="anchored__who">You asked</span>
                {{ thread.text }}
              </p>
              <p v-if="thread.opening" class="anchored__sent">
                <AppIcon name="spinner" :size="11" />
                Opening a conversation about these lines…
              </p>
              <p v-else-if="thread.error" class="anchored__sent">{{ thread.error }}</p>

              <!-- The conversation itself, here, about these lines and nothing else. -->
              <InlineChat
                v-else-if="thread.session"
                class="anchored__chat"
                :session="thread.session"
                :command="paneCommand(workspace, thread.session)"
                :live="live !== false"
                :shortcuts="SHORTCUTS"
              />

              <p v-else class="anchored__sent">
                <AppIcon name="send" :size="11" />
                Sent to the conversation below.
              </p>
            </div>
          </template>
        </CodeView>
      </div>
    </article>

  </section>
</template>

<style scoped>
/*
 * Two columns, at the width this view actually runs at.
 *
 * A diff is a two-column object and the breakpoint for the second column was 1100px, so at the
 * measured 1024 every diff card in the deck got the phone layout: a 32px horizontal strip of file
 * chips over a code box. What that cost, measured on the four cards with a diff - `.tree`
 * clientWidth 688 against scrollWidth 8,729 (157 files), 6,623, 6,616 and 3,339, so 8-20% of the
 * file list, scrolled sideways with no scrollbar and 3 of 157 files visible; and `.file`
 * clientHeight 99 against scrollHeight 1,762 to 22,978, which with the code pane's old 39px empty
 * header meant 60px of a 488px card was code. 12.3% of the card for the thing the card is for.
 *
 * 760px, which is the narrowest a 180px file column and a readable code pane fit in. The column is
 * a fixed track rather than `minmax(200px, 250px)`: 250 of 688 is 36% of the card spent on file
 * names, and 180px is a path's last two segments, which is what identifies it. Ten rows at 30px.
 */
.changes {
  display: grid;
  grid-template-columns: 180px minmax(0, 1fr);
  grid-template-rows: auto minmax(0, 1fr) auto;
  gap: var(--s3) var(--s4);
  /* The card is the width that decides; nothing in here is allowed to widen it. */
  min-width: 0;
  min-height: 0;
}

/* ── The header ──────────────────────────────────────────────────────────── */
/* Placement only: the look is SectionHead's, like every other surface's header. */
.changes__head { grid-column: 1 / -1; }


/* The end of a path identifies it, so that is the end it keeps when the head has to give. */
.changes__path {
  min-width: 0;
  overflow: hidden;
  color: var(--text);
  font-family: var(--mono);
  font-size: var(--t-sm);
  text-overflow: ellipsis;
  white-space: nowrap;
  direction: rtl;
  text-align: left;
}

.changes__stat { flex: 0 0 auto; font-family: var(--mono); font-size: var(--t-xs); }
.changes__stat--add { color: var(--success); }
.changes__stat--del { color: var(--danger); }

.changes__hint { flex: 0 0 auto; color: var(--text-faint); font-size: var(--t-sm); }

/* ── The tree ────────────────────────────────────────────────────────────── */
/*
 * A column that scrolls down, never across.
 *
 * `.tree` reported a scrollWidth of 8713px in a 660px box: the directory button laid its path
 * out at full length - a flex container's bare text node cannot be ellipsised - and pushed the
 * whole column out, which the card's body then offered to scroll sideways to. A long path loses
 * its middle instead.
 */
.tree {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
  min-height: 0;
  /*
   * The fade, written out rather than taken from `.u-fade-y` in design/focus.css, for the reason
   * `.pass__list` writes its own: at this card's width the tree is a column and below 1100px it is
   * a strip along the top, so the axis of the cut changes with the breakpoint and a class cannot
   * follow it. The reason for it is the utility's - a row of a file list bisected horizontally at
   * the surface's edge reads as a rendering fault, and a fade reads as a scroller - and the
   * padding is the room the gradient eats so a short list is left alone.
   */
  padding: 0 var(--s2) var(--s5) 0;
  overflow: hidden auto;
  touch-action: pan-y;
  scroll-snap-type: y proximity;
  mask-image: linear-gradient(to bottom, #000 calc(100% - var(--s5)), transparent 100%);
}

.tree > * { scroll-snap-align: start; }

/*
 * Never squeezed.
 *
 * A flex item shrinks by default, and a scrolling column of forty of them hands each one less
 * height than its content needs - so the rows collapse into each other and their text draws over
 * the row below, which is what the file tree was doing. Pinning the row is what makes the column
 * scroll instead of compressing. The same mistake, and the same fix, as the card's own header.
 */
.tree__dir,
.tree__file {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 6px;
  width: 100%;
  /*
   * 30px, the row height the pool, the dock and the commits all use - and the smallest thing the
   * prototype lets you press. It was a 5px padding and whatever the text came to, which is both
   * a different rhythm from every other list on a card and a smaller target than any of them.
   */
  min-height: 30px;
  padding: 0 var(--s2);
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

.tree__dirname {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  /* Right to left: the end of a path is the part that identifies it, as on the file rows. */
  direction: rtl;
  text-align: left;
  white-space: nowrap;
}

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
  /* Right to left, so a long name loses its start - the end is the part that identifies it. */
  direction: rtl;
  text-align: left;
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
  padding: 0 var(--s2) var(--s5) 0;
  overflow: hidden auto;
  touch-action: pan-y;
}

.file__hunk { display: flex; flex-direction: column; gap: 6px; }

/*
 * `.file__hunk-head` lived here: `@@ -12,7 +12,9 @@` as a paragraph above each panel, which is a
 * header for the panel drawn outside the panel. It is the panel's label now, and the 6px gap plus
 * its own line came back to the code.
 */

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

/* ── The box that asks, in among the code ────────────────────────────────── */
.ask {
  /* Inset to the same place a thread sits, so asking and the answer line up. */
  margin: var(--s2) 0;
  display: flex;
  align-items: center;
  gap: var(--s3);
  padding: var(--s2) var(--s3);
  border-left: 2px solid var(--kind);
  background: color-mix(in srgb, var(--kind) 9%, var(--surface-sunk));
  border-radius: 0 var(--r-sm, 4px) var(--r-sm, 4px) 0;
}

.ask__form { display: flex; align-items: center; gap: var(--s2); flex: 1; min-width: 0; }


@keyframes dot {
  50% { opacity: 0.25; transform: translateY(-2px); }
}

/*
 * Narrow: a phone, which is the only place this layout belongs.
 *
 * It was the layout that *shipped*, because the breakpoint was 1100px and the view runs at 1024 -
 * so every diff card in the deck stacked a 32px sideways strip of file chips over a 99px code box,
 * showing 3 of 157 files and two lines of code. See `.changes` above for what that measured. The
 * breakpoint is 760px now and this is what is left: one column, because at a phone's width there
 * is no second one to have.
 *
 * Everything above the code is still a number, and the code gets the remainder. The head is 26px
 * (SectionHead does not wrap, and it is the only header this surface has - `.file__head` was a
 * second one, 0px tall on nine cards). The file strip is 32px of chips with its 8px scrollbar
 * hidden: the `u-fade-x` on it already says there is more, and an 8px track under a 30px row is a
 * quarter of the row. Capping what is above the code rather than flooring the code is the version
 * of that fix which cannot overflow: 26 + a 140px floor + the gaps + an open ask bar is 258px of
 * rows in a box that does not have it, which is this same bug one row further down.
 */
@media (max-width: 760px) {
  .changes {
    grid-template-columns: minmax(0, 1fr);
    /*
     * Three tracks for four children on purpose: the ask bar lands in an implicit fourth row, so
     * it costs a row *and* a gap only while it is open. Four explicit tracks charge the code 8px
     * of gap on every card whether anybody has picked a line or not - and a `min-height` floor on
     * the pane plus an open ask bar sums to 226px of rows in a 180px box, which is this same bug
     * one row further down. The floor is the capped furniture above it, not a declaration here.
     */
    grid-template-rows: auto auto minmax(0, 1fr);
    gap: var(--s2);
  }
  /* Turned sideways with the strip: a bottom mask on a sideways scroller dims the row it is
     meant to be reading. */
  .tree {
    flex: 0 0 auto;
    flex-direction: row;
    height: 32px;
    padding: 0 var(--s5) 0 0;
    overflow: auto hidden;
    scroll-snap-type: x proximity;
    mask-image: linear-gradient(to right, #000 calc(100% - var(--s5)), transparent 100%);
    scrollbar-width: none;
  }
  .tree::-webkit-scrollbar { height: 0; }
  .tree__dir { display: none; }
  .tree__file { width: auto; flex: none; }
  .ask { flex-wrap: wrap; }
}

/* A conversation under the lines it is about, inset so the diff still reads as the subject. */
.anchored__chat {
  margin-top: var(--s2);
  padding-top: var(--s2);
  border-top: 1px solid var(--border);
}

/* ── What has been said ───────────────────────────────────────────────────────────────────── */

/* The mark on a file in the tree. */
.tree__said {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  margin-left: auto;
  padding: 0 4px;
  border-radius: var(--r-pill);
  color: var(--accent);
  font-size: var(--t-xs);
  font-variant-numeric: tabular-nums;
}

/* Its comments, by line, under the open file. */
.tree__lines { margin: 0 0 var(--s2) 0; padding: 0 0 0 var(--s4); list-style: none; }

.tree__line {
  display: flex;
  align-items: baseline;
  gap: var(--s2);
  width: 100%;
  padding: 2px var(--s2);
  border: 0;
  border-left: 1px solid var(--border);
  background: transparent;
  color: var(--text-muted);
  font: inherit;
  font-size: var(--t-xs);
  text-align: left;
  cursor: pointer;
}

.tree__line:hover { color: var(--text); border-left-color: var(--accent); background: var(--surface-raised); }
.tree__line-n { font-variant-numeric: tabular-nums; }
.tree__line-tag { color: var(--accent); }
.tree__line-who { color: var(--text-faint); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* A comment where the line is. */
.said {
  margin: var(--s2) 0;
  padding: var(--s2) var(--s3);
  border-left: 2px solid var(--border-strong, var(--border));
  background: var(--surface-raised);
  border-radius: 0 var(--r-sm, 4px) var(--r-sm, 4px) 0;
}

/* Yours reads as yours, the way the deck marks anything of your own. */
.said--mine { border-left-color: var(--accent); }

.said__who {
  display: flex;
  align-items: center;
  gap: var(--s2);
  margin: 0 0 2px;
  color: var(--text-muted);
  font-size: var(--t-xs);
}

.said__line { color: var(--text-faint); font-variant-numeric: tabular-nums; }
.said__body { font-size: var(--t-sm); }
</style>
