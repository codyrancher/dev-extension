<script setup lang="ts">
/**
 * Lines of code, drawn once for everybody who draws them.
 *
 * A diff hunk, a whole file, a run of lines a comment points at - the same grid every time: the
 * two gutters, the sign, and the code. What differs between the places it is used is which of
 * them are numbered, whether you can pick a run out of it, and whether there is more of the file
 * to go and look at.
 *
 * **Wrapping, not scrolling.** A long line used to run off the side behind its own scrollbar, so
 * reading the end of it meant dragging a bar that belonged to one row out of forty. It wraps, and
 * the gutters sit at the top of the row they number, which is what `align-items: start` is doing.
 * `wrap="false"` is there for a caller that really wants a single line, and nothing uses it yet.
 *
 * **Picking.** Click a line, shift-click another, and everything between is the run - the way it
 * works in an editor. The indices are into the rows given, so a caller that slices its rows gets
 * indices into the slice.
 *
 * **The way out.** `expandable` draws one row at the foot of the hunk, and the caller decides what
 * it opens; in practice that is FileModal, with this same component inside it showing the whole
 * file with these lines marked. A hunk is six lines of context either side, and the question it
 * raises most often is what the rest of the function looks like.
 *
 * That control used to be a chip floated into a header, and the header drew whenever *either* a
 * label or the chip was there. `ChangeSet` passes no label, so on all seven diff cards in the deck
 * `.cv__head` measured `{h: 39, label: "", kids: 1}`: a full-width band of `--surface-raised` with
 * nothing in it but one right-floated chip, sitting on top of every piece of code in the view. On
 * the open-pr card the whole code pane was 99px, so 39% of it was an empty strip, and in all four
 * diff screenshots it read as a rendering failure. A header draws when there is a heading; the way
 * out of a hunk goes at the end of the hunk, which is where a diff puts it everywhere else.
 */
import { computed } from 'vue';
import AppIcon from '../focus/AppIcon.vue';
import type { CodeRow } from './rows';

const props = withDefaults(defineProps<{
  rows: CodeRow[];
  /** Pickable, for asking about a run of lines. */
  selectable?: boolean;
  /** First and last index of the run to mark, inclusive. */
  picked?: [number, number] | null;
  /** The same, by line number on the new side, for a caller that thinks in lines. */
  markLines?: [number, number] | null;
  wrap?: boolean;
  /** Draw the control that opens the whole file. */
  expandable?: boolean;
  expandLabel?: string;
  /** A heading inside the frame: the path, usually. */
  label?: string;
}>(), {
  wrap: true, selectable: false, picked: null, markLines: null, expandable: false, expandLabel: 'See the whole file', label: '',
});

const emit = defineEmits<{
  (e: 'pick', range: [number, number]): void;
  (e: 'expand'): void;
}>();

/**
 * Whether the old-side gutter is worth a column.
 *
 * A whole file has one set of numbers and a diff has two. Drawing both regardless put an empty
 * 44px column down the side of every file this has ever shown.
 */
const twoSided = computed(() => props.rows.some((row) => row.old !== null && row.new !== null && row.old !== row.new)
  || props.rows.some((row) => (row.old === null) !== (row.new === null)));

const marked = computed<[number, number] | null>(() => {
  if (props.picked) {
    return props.picked;
  }
  if (!props.markLines) {
    return null;
  }
  const [from, to] = props.markLines;
  const first = props.rows.findIndex((row) => row.new === from || row.old === from);
  const last = props.rows.findIndex((row) => row.new === to || row.old === to);

  return first < 0 ? null : [first, last < 0 ? first : last];
});

/** In the picked run, or marked on its own. See CodeRow.marked. */
const inPick = (i: number) => Boolean(props.rows[i]?.marked)
  || Boolean(marked.value && i >= marked.value[0] && i <= marked.value[1]);

const sign = (row: CodeRow) => (row.kind === 'add' ? '+' : row.kind === 'del' ? '−' : ' ');

function onClick(event: MouseEvent, i: number) {
  if (!props.selectable || props.rows[i]?.kind === 'hunk' || props.rows[i]?.kind === 'expand') {
    return;
  }
  if (event.shiftKey && props.picked) {
    emit('pick', [Math.min(props.picked[0], i), Math.max(props.picked[1], i)]);

    return;
  }
  emit('pick', [i, i]);
}

defineExpose({
  /** Which row a line number is on, for a caller that wants to scroll to it. See FileModal. */
  rowFor: (line: number) => props.rows.findIndex((row) => row.new === line || row.old === line),
});
</script>

<template>
  <div
    class="cv"
    :class="{ 'cv--pickable': selectable, 'cv--wrap': wrap, 'cv--one-side': !twoSided }"
  >
    <!-- A heading, only where there is a heading. See the note at the top of this file. -->
    <header v-if="label" class="cv__head">
      <code class="cv__label">{{ label }}</code>
    </header>

    <div class="cv__rows">
      <template v-for="(row, i) in rows" :key="i">
        <div
          class="cv__row"
          :class="[`cv__row--${ row.kind }`, { 'cv__row--picked': inPick(i), 'cv__row--first': inPick(i) && !inPick(i - 1), 'cv__row--last': inPick(i) && !inPick(i + 1) }]"
          :role="selectable ? 'button' : undefined"
          :tabindex="selectable && row.kind !== 'hunk' ? 0 : undefined"
          @click="onClick($event, i)"
          @keydown.enter.prevent="onClick($event as unknown as MouseEvent, i)"
        >
          <template v-if="row.kind === 'hunk' || row.kind === 'expand'">
            <!-- eslint-disable-next-line vue/no-v-html -- escaped by whoever highlighted it. -->
            <span v-if="row.html" class="cv__span" v-html="row.html" />
            <span v-else class="cv__span">{{ row.text }}</span>
          </template>
          <template v-else>
            <span v-if="twoSided" class="cv__no">{{ row.old ?? '' }}</span>
            <span class="cv__no">{{ row.new ?? row.old ?? '' }}</span>
            <span class="cv__sign">{{ sign(row) }}</span>
            <!-- eslint-disable-next-line vue/no-v-html -- highlightLines escapes before it marks up. -->
            <code v-if="row.html" class="cv__text" v-html="row.html" />
            <code v-else class="cv__text">{{ row.text }}</code>
          </template>
        </div>

        <!-- Anything anchored to this line: a question asked about it, a composer, an answer. -->
        <slot name="after" :row="row" :index="i" />
      </template>

      <!-- The last row of the hunk, in the hunk row's own treatment: the rest of the file. -->
      <button
        v-if="expandable"
        type="button"
        class="cv__row cv__row--out"
        :title="expandLabel"
        @click="emit('expand')"
      >
        <span class="cv__span cv__span--out">
          <AppIcon name="chevron-down" :size="12" />
          {{ expandLabel }}
        </span>
      </button>
    </div>
  </div>
</template>

<style scoped>
.cv {
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  background: var(--surface-sunk);
  font-family: var(--mono);
  font-size: var(--t-sm);
  line-height: 1.55;
  overflow: hidden;
}

.cv__head {
  display: flex;
  align-items: center;
  gap: var(--s2);
  padding: 3px var(--s2) 3px var(--s3);
  border-bottom: 1px solid var(--border);
  background: var(--surface-raised);
}

.cv__label {
  min-width: 0;
  overflow: hidden;
  color: var(--text-muted);
  font-size: var(--t-xs);
  text-overflow: ellipsis;
  white-space: nowrap;
}

/*
 * The way out of a hunk: the hunk's last row, at the height everything you press here is.
 *
 * It was a 22px chip in a header - two thirds of the 32px floor the view sets for itself, and the
 * header it was floated into was an empty 39px band on every diff card in the deck. A row costs
 * the hunk its own height and nothing above the code.
 */
.cv__row--out {
  width: 100%;
  min-height: var(--control-h);
  border: 0;
  background: none;
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.cv__span--out {
  display: flex;
  align-items: center;
  gap: 6px;
  min-height: var(--control-h);
  color: var(--text-muted);
  font-family: var(--font);
}

.cv__row--out:hover .cv__span--out { background: var(--surface); color: var(--text); }

.cv__row {
  display: grid;
  /* Old gutter, new gutter, sign, code. The first is dropped for a file, which has one set. */
  grid-template-columns: 44px 44px 16px minmax(0, 1fr);
  /*
   * The gutters sit at the top of the row they number rather than centring in it, because a
   * wrapped line is four rows tall and a number floating in the middle of it belongs to nothing.
   */
  align-items: start;
  border: 0;
  background: none;
  text-align: left;
}

.cv--one-side .cv__row { grid-template-columns: 44px 16px minmax(0, 1fr); }

/*
 * A line you can press is a control; a line you only read is text.
 *
 * `.cv__row` measured 20px across 753 instances in one walk of the deck, and the view's own floor
 * is 32px - but a diff at 32px a line is a third of the lines on screen, and reading the code is
 * what the component is for. So only the rows that are actually pickable grow: the padding makes
 * the whole row the target at 30px without changing the leading of the code inside it, and a
 * read-only diff keeps its density.
 */
.cv--pickable .cv__row { padding-block: 5px; cursor: pointer; }
.cv--pickable .cv__row:hover { background: color-mix(in srgb, var(--kind, var(--accent)) 7%, transparent); }
.cv--pickable .cv__row:focus-visible { outline: 2px solid var(--kind, var(--accent)); outline-offset: -2px; }

.cv__no {
  padding-right: var(--s2);
  color: var(--text-faint);
  text-align: right;
  user-select: none;
}

.cv__sign { color: var(--text-muted); text-align: center; user-select: none; }

.cv__text {
  padding-right: var(--s3);
  color: var(--text-dim);
  /*
   * Wrapped, with the indentation of the lines that wrap preserved. `pre-wrap` keeps the leading
   * whitespace that makes code readable; `anywhere` is what lets a 300-character string with no
   * spaces in it break at all rather than forcing the column wider than the card.
   */
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.cv:not(.cv--wrap) .cv__text { white-space: pre; overflow-x: auto; }

/* A `@@` header or an expand control: the whole width, no numbers. */
.cv__span {
  grid-column: 1 / -1;
  padding: 2px var(--s3);
  background: var(--surface-raised);
  color: var(--text-faint);
  font-size: var(--t-xs);
}

/* The wash behind an added or removed line, mixed from the token rather than written out as
   the same colour at 9% - which, being a literal, did not follow the light theme. */
.cv__row--add { background: color-mix(in srgb, var(--success) 9%, transparent); }
.cv__row--add .cv__sign,
.cv__row--add .cv__text { color: color-mix(in srgb, var(--success) 45%, var(--text)); }
.cv__row--del { background: color-mix(in srgb, var(--danger) 9%, transparent); }
.cv__row--del .cv__sign,
.cv__row--del .cv__text { color: color-mix(in srgb, var(--danger) 45%, var(--text)); }

/* The run being pointed at, marked down its edge the way a selection is. */
.cv__row--picked {
  background: color-mix(in srgb, var(--kind, var(--accent)) 13%, transparent);
  box-shadow: inset 3px 0 0 var(--kind, var(--accent));
}

.cv--pickable .cv__row--picked:hover { background: color-mix(in srgb, var(--kind, var(--accent)) 17%, transparent); }
.cv__row--picked .cv__no { color: color-mix(in srgb, var(--kind, var(--accent)) 55%, var(--text-muted)); }
</style>
