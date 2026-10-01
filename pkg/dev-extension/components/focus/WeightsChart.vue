<script setup lang="ts">
/**
 * What decides the order, as something to look at rather than a list of numbers.
 *
 * Twenty-four rules with a slider each is a form, and a form does not answer the question
 * somebody opens this with - which is never "what is rule 14 worth" but "why is *that* at the
 * top, and what happens to the order if I care less about it". So:
 *
 *   - the rules are **banded** by what their score means (cannot move without you, waiting on
 *     you, yours to finish, background). The bands are the thing the numbers were standing in
 *     for, and a rule that crosses one as you drag it has visibly changed meaning.
 *   - each rule is a **bar** in the hue of the card that draws it, so the colour families
 *     gather by score and a glance says which kind of work this person's ranking favours.
 *   - the bar carries **what it is holding right now**, and a rule holding nothing is dimmed:
 *     half of these are about work nobody has, and they should not read the same as the ones
 *     doing the ranking today.
 *   - the **shipped value** stays on the bar as a notch once it has been moved, because "what
 *     did I change" is the second question and there is nowhere else to read it.
 *
 * Dragging is a drag on the bar itself - the whole row is the control - so the chart and the
 * form are one object instead of a chart with a form under it.
 */
import { computed } from 'vue';
import KindChip from './KindChip.vue';
import type { WeightRow } from '../../focus';
import type { FocusKind, CardDef } from '../../focus';

const props = defineProps<{
  rows: WeightRow[];
  cards: CardDef[];
  /** The top of the queue as it stands, so a change is seen rather than described. */
  top: { what: string; title: string; needs: string; score: number; kind: FocusKind }[];
}>();

const emit = defineEmits<{ (e: 'set', payload: { id: string; score: number }): void }>();

/** The four things a score can mean. A rule's band is the whole of what its number says. */
const BANDS = [
  { id: 'now', label: 'Cannot move without you', from: 80, about: 'Something has stopped and only you can start it again.' },
  { id: 'waiting', label: 'Somebody is waiting on you', from: 55, about: 'Work in flight that is held up at your step.' },
  { id: 'yours', label: 'Yours to finish', from: 35, about: 'Nobody is blocked; it is on your own plate.' },
  { id: 'background', label: 'Background', from: 0, about: 'Worth knowing about. Can wait until Friday.' },
];

/** Which card draws a rule, and therefore which hue the rule is drawn in. */
const kindOf = (id: string): FocusKind => props.cards.find((card) => (card.rules || []).includes(id))?.kind || 'signal';

const banded = computed(() => BANDS.map((band, n) => {
  const under = BANDS[n + 1]?.from ?? -1;

  return {
    ...band,
    rows: props.rows.filter((row) => row.score >= band.from && (under < 0 || row.score > under || n === BANDS.length - 1)
      ? row.score >= band.from && (n === 0 || row.score < BANDS[n - 1].from)
      : false),
  };
}).filter((band) => band.rows.length));

/** How many things the ranking is actually holding, which is the one number worth a headline. */
const holding = computed(() => props.rows.reduce((total, row) => total + row.count, 0));
const changed = computed(() => props.rows.filter((row) => row.score !== row.shipped).length);

function drag(row: WeightRow, event: MouseEvent) {
  const track = (event.currentTarget as HTMLElement);
  const move = (at: MouseEvent) => {
    const box = track.getBoundingClientRect();
    const score = Math.round(Math.min(100, Math.max(0, ((at.clientX - box.left) / box.width) * 100)));

    emit('set', { id: row.id, score });
  };

  move(event);
  const stop = () => {
    window.removeEventListener('mousemove', move);
    window.removeEventListener('mouseup', stop);
  };

  window.addEventListener('mousemove', move);
  window.addEventListener('mouseup', stop);
}

/** The keyboard way, because a bar you can only drag is a bar some people cannot use. */
function nudge(row: WeightRow, by: number) {
  emit('set', { id: row.id, score: Math.min(100, Math.max(0, row.score + by)) });
}
</script>

<template>
  <div class="wc">
    <!--
      What the ranking is doing right now, at the top: the three things it has put first. Change
      a weight and this is where you see what it did - which is the only honest way to show the
      effect of a number nobody can feel.
    -->
    <section v-if="top.length" class="wc__top">
      <h3 class="wc__head">At the top right now</h3>
      <ol class="wc__list">
        <li v-for="(item, n) in top" :key="item.what" class="wc__item" :class="`wc__item--${ item.kind }`">
          <span class="wc__rank">{{ n + 1 }}</span>
          <span class="wc__item-text">
            <span class="wc__item-title">{{ item.title || item.what }}</span>
            <span class="wc__item-needs">{{ item.needs }}</span>
          </span>
          <span class="wc__item-score">{{ item.score }}</span>
        </li>
      </ol>
    </section>

    <p class="wc__note">
      <strong>{{ holding }}</strong> waiting, ranked by <strong>{{ rows.length }}</strong> rules.
      <template v-if="changed">{{ changed }} changed from what shipped.</template>
      <template v-else>None of them changed from what shipped.</template>
    </p>

    <section v-for="band in banded" :key="band.id" class="wc__band">
      <header class="wc__band-head">
        <h3 class="wc__head">{{ band.label }}</h3>
        <span class="wc__band-range">{{ band.from }}+</span>
      </header>
      <p class="wc__band-about">{{ band.about }}</p>

      <div
        v-for="row in band.rows"
        :key="row.id"
        class="rule"
        :class="[`rule--${ kindOf(row.id) }`, { 'rule--idle': !row.count }]"
      >
        <div class="rule__line">
          <span class="rule__label">{{ row.label }}</span>
          <span v-if="row.count" class="rule__count">{{ row.count }} waiting</span>
          <span class="rule__score" :class="{ 'rule__score--moved': row.score !== row.shipped }">{{ row.score }}</span>
        </div>

        <!--
          The bar is the control: pressing anywhere on it sets the weight, and the arrow keys
          move it by one. A notch marks what it shipped as, once the two differ.
        -->
        <div
          class="rule__track"
          role="slider"
          tabindex="0"
          :aria-label="`${ row.label }: ${ row.score }`"
          :aria-valuenow="row.score"
          aria-valuemin="0"
          aria-valuemax="100"
          @mousedown.prevent="drag(row, $event)"
          @keydown.left.prevent="nudge(row, -1)"
          @keydown.right.prevent="nudge(row, 1)"
          @keydown.down.prevent="nudge(row, -5)"
          @keydown.up.prevent="nudge(row, 5)"
        >
          <span class="rule__fill" :style="{ width: `${ row.score }%` }" />
          <span
            v-if="row.score !== row.shipped"
            class="rule__shipped"
            :style="{ left: `${ row.shipped }%` }"
            :title="`Shipped at ${ row.shipped }`"
          />
          <span class="rule__knob" :style="{ left: `${ row.score }%` }" />
        </div>

        <p class="rule__about">{{ row.about }}</p>
      </div>
    </section>

    <!-- The hues, once, so the bars above do not have to say what they mean one by one. -->
    <footer class="wc__legend">
      <KindChip v-for="kind in (['question', 'review', 'agent', 'issue', 'signal'] as FocusKind[])" :key="kind" :kind="kind" size="sm" />
    </footer>
  </div>
</template>

<style scoped>
.wc { display: flex; flex-direction: column; gap: var(--s5); }

.wc__head {
  color: var(--text-muted);
  font-size: var(--t-xs);
  font-weight: 650;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

.wc__note { color: var(--text-muted); font-size: var(--t-xs); }
.wc__note strong { color: var(--text); font-variant-numeric: tabular-nums; }

/* ── The live top of the queue ─────────────────────────────────────────────────────────────── */
.wc__top { display: flex; flex-direction: column; gap: var(--s2); }
.wc__list { display: flex; flex-direction: column; gap: 4px; margin: 0; padding: 0; list-style: none; }

.wc__item {
  display: grid;
  grid-template-columns: auto 1fr auto;
  align-items: center;
  gap: var(--s3);
  padding: 6px var(--s3);
  border: 1px solid var(--border);
  border-left: 3px solid var(--kind-c);
  border-radius: var(--r-sm);
  background: var(--surface-sunk);
}

.wc__rank { color: var(--text-faint); font-size: var(--t-xs); font-variant-numeric: tabular-nums; }
.wc__item-text { display: flex; flex-direction: column; min-width: 0; }
.wc__item-title { color: var(--text); font-size: var(--t-sm); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wc__item-needs { color: var(--text-faint); font-size: var(--t-xs); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wc__item-score { color: var(--kind-c); font-size: var(--t-sm); font-weight: 650; font-variant-numeric: tabular-nums; }

.wc__item--review   { --kind-c: var(--kind-review); }
.wc__item--issue    { --kind-c: var(--kind-issue); }
.wc__item--agent    { --kind-c: var(--kind-agent); }
.wc__item--question { --kind-c: var(--kind-question); }
.wc__item--signal   { --kind-c: var(--kind-signal); }

/* ── A band of rules ──────────────────────────────────────────────────────────────────────── */
.wc__band { display: flex; flex-direction: column; gap: var(--s2); }
.wc__band-head { display: flex; align-items: baseline; gap: var(--s2); }

.wc__band-range {
  margin-left: auto;
  color: var(--text-faint);
  font-size: var(--t-xs);
  font-variant-numeric: tabular-nums;
}

.wc__band-about { margin: 0 0 var(--s2); color: var(--text-faint); font-size: var(--t-xs); }

/* ── One rule ─────────────────────────────────────────────────────────────────────────────── */
.rule {
  padding: var(--s3) 0 var(--s2);
  border-top: 1px solid var(--border);
}

.rule--idle { opacity: 0.45; }
.rule__line { display: flex; align-items: baseline; gap: var(--s2); }
.rule__label { color: var(--text); font-size: var(--t-sm); }

.rule__count {
  padding: 0 6px;
  border-radius: var(--r-pill);
  background: color-mix(in srgb, var(--kind-c) 18%, transparent);
  color: var(--kind-c);
  font-size: 10px;
  font-weight: 700;
  white-space: nowrap;
}

.rule__score {
  margin-left: auto;
  color: var(--text-muted);
  font-size: var(--t-sm);
  font-variant-numeric: tabular-nums;
}

.rule__score--moved { color: var(--accent); }

.rule__track {
  position: relative;
  height: 10px;
  margin: 8px 0 6px;
  border-radius: var(--r-pill);
  background: var(--surface-raised);
  cursor: ew-resize;
}

.rule__track:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }

.rule__fill {
  position: absolute;
  inset: 0 auto 0 0;
  border-radius: var(--r-pill);
  background: linear-gradient(90deg, color-mix(in srgb, var(--kind-c) 45%, transparent), var(--kind-c));
}

.rule__knob {
  position: absolute;
  top: 50%;
  width: 14px;
  height: 14px;
  border: 2px solid var(--ground);
  border-radius: var(--r-pill);
  background: var(--kind-c);
  transform: translate(-50%, -50%);
  pointer-events: none;
}

/* What it shipped as, left on the bar: the only place "what did I change" can be read. */
.rule__shipped {
  position: absolute;
  top: -3px;
  bottom: -3px;
  width: 2px;
  background: var(--text-faint);
  transform: translateX(-50%);
  pointer-events: none;
}

.rule__about { margin: 0; color: var(--text-faint); font-size: var(--t-xs); }

.rule--review   { --kind-c: var(--kind-review); }
.rule--issue    { --kind-c: var(--kind-issue); }
.rule--agent    { --kind-c: var(--kind-agent); }
.rule--question { --kind-c: var(--kind-question); }
.rule--signal   { --kind-c: var(--kind-signal); }

.wc__legend {
  display: flex;
  flex-wrap: wrap;
  gap: var(--s2);
  padding-top: var(--s3);
  border-top: 1px solid var(--border);
}
</style>
