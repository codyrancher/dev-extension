<script setup lang="ts">
/**
 * A run of diff lines, drawn once for everybody who needs one.
 *
 * Two uses: a review comment showing the few lines it is about, and a file's diff you can pick
 * a run out of to ask about. The difference between them is one prop - `selectable` - because
 * the alternative was two copies of the same grid, the same gutters and the same add/delete
 * colours drifting apart.
 *
 * Picking works the way it does in an editor: click a line, shift-click another, and everything
 * between them is the selection.
 */
import type { DiffLine } from '../../focus-review';

const props = defineProps<{
  lines: DiffLine[];
  /** First and last index of the run to mark, inclusive. */
  picked?: [number, number] | null;
  selectable?: boolean;
}>();

const emit = defineEmits<{ (e: 'pick', range: [number, number]): void }>();

const inPick = (i: number) => Boolean(props.picked && i >= props.picked[0] && i <= props.picked[1]);

const sign = (line: DiffLine) => (line.type === 'add' ? '+' : line.type === 'del' ? '−' : ' ');

function onClick(event: MouseEvent, i: number) {
  if (!props.selectable) {
    return;
  }
  if (event.shiftKey && props.picked) {
    emit('pick', [Math.min(props.picked[0], i), Math.max(props.picked[1], i)]);

    return;
  }
  emit('pick', [i, i]);
}
</script>

<template>
  <div class="code" :class="{ 'code--pickable': selectable }">
    <template v-for="(line, i) in lines" :key="i">
      <div
        class="code__row"
        :class="[`code__row--${ line.type }`, { 'code__row--picked': inPick(i), 'code__row--first': inPick(i) && !inPick(i - 1), 'code__row--last': inPick(i) && !inPick(i + 1) }]"
        :role="selectable ? 'button' : undefined"
        :tabindex="selectable ? 0 : undefined"
        @click="onClick($event, i)"
        @keydown.enter.prevent="onClick($event as unknown as MouseEvent, i)"
      >
        <span class="code__no">{{ line.old ?? '' }}</span>
        <span class="code__no">{{ line.new ?? '' }}</span>
        <span class="code__sign">{{ sign(line) }}</span>
        <code class="code__text">{{ line.text }}</code>
      </div>

      <!-- Anything anchored to this line: a question asked about it, and the answer. -->
      <slot name="after" :line="line" :index="i" />
    </template>
  </div>
</template>

<style scoped>
.code {
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  background: var(--surface-sunk);
  font-family: var(--mono);
  font-size: var(--t-sm);
  line-height: 1.55;
  overflow: hidden;
}

.code__row {
  display: grid;
  grid-template-columns: 44px 44px 16px minmax(0, 1fr);
  border: 0;
  background: none;
  text-align: left;
}

.code--pickable .code__row { cursor: pointer; }
.code--pickable .code__row:hover { background: color-mix(in srgb, var(--kind) 7%, transparent); }
.code--pickable .code__row:focus-visible { outline: 2px solid var(--kind); outline-offset: -2px; }

.code__no {
  padding-right: var(--s2);
  color: var(--text-faint);
  text-align: right;
  user-select: none;
}

.code__sign { color: var(--text-muted); text-align: center; user-select: none; }

.code__text {
  padding-right: var(--s3);
  color: var(--text-dim);
  white-space: pre;
  overflow-x: auto;
}

.code__row--add { background: rgba(72, 199, 142, 0.09); }
.code__row--add .code__sign,
.code__row--add .code__text { color: color-mix(in srgb, var(--success) 45%, var(--text)); }
.code__row--del { background: rgba(242, 85, 90, 0.09); }
.code__row--del .code__sign,
.code__row--del .code__text { color: color-mix(in srgb, var(--danger) 45%, var(--text)); }

/* The run being pointed at, marked down its edge the way a selection is. */
.code__row--picked {
  background: color-mix(in srgb, var(--kind) 13%, transparent);
  box-shadow: inset 3px 0 0 var(--kind);
}

.code--pickable .code__row--picked:hover { background: color-mix(in srgb, var(--kind) 17%, transparent); }
.code__row--picked .code__no { color: color-mix(in srgb, var(--kind) 55%, var(--text-muted)); }
</style>
