<script setup lang="ts">
/**
 * What else is running, from a corner of the deck.
 *
 * The deck is one card at a time on purpose, and the cost of that is losing sight of everything
 * else - four workspaces with agents in them and two Ranchers up, and the view shows you one
 * card. This is the answer to "what else is there" without leaving.
 *
 * One component for both corners rather than one per corner. The behaviour is the whole of what
 * this is - when it opens, when it goes, that it survives the pointer crossing the gap - and that
 * behaviour is identical for workspaces and for Ranchers; only the rows differ. Two copies of it
 * would be two sets of timings to keep in step, which is the drift SectionHead was just pulled
 * out of six components to stop.
 *
 * Hovered rather than clicked, and it stays while the pointer is on the card, because what is in
 * it is a list of links - a control that exists only while the pointer is on the mark is a
 * control you have to chase. The delays are the dashboard's own; see hover-card.js.
 */
import { computed, onBeforeUnmount, ref } from 'vue';
import AppIcon from './AppIcon.vue';
import type { IconName } from './icons';
import type { DockRow } from './dock';

const props = withDefaults(defineProps<{
  label: string;
  rows: DockRow[];
  icon?: IconName;
  /** The one the card on top belongs to, marked in the list. */
  here?: string;
  /** Extra lines under the name: what the normal view shows about this thing. */
  meters?: boolean;
  /** What to say when there are none. */
  empty?: string;
}>(), {
  icon: 'tasks', here: '', empty: 'Nothing here yet.', meters: false,
});

const emit = defineEmits<{ (e: 'open', id: string): void }>();

const open = ref(false);
let showing: ReturnType<typeof setTimeout> | null = null;
let hiding: ReturnType<typeof setTimeout> | null = null;

const SHOW_MS = 280;
const HIDE_MS = 240;

function enter() {
  if (hiding) {
    clearTimeout(hiding);
    hiding = null;
  }
  if (!open.value && !showing) {
    showing = setTimeout(() => {
      open.value = true;
      showing = null;
    }, SHOW_MS);
  }
}

function leave() {
  if (showing) {
    clearTimeout(showing);
    showing = null;
  }
  hiding = setTimeout(() => {
    open.value = false;
    hiding = null;
  }, HIDE_MS);
}

onBeforeUnmount(() => {
  if (showing) {
    clearTimeout(showing);
  }
  if (hiding) {
    clearTimeout(hiding);
  }
});

/** Up first, then the rest; a stopped one is still worth seeing, just not first. */
const sorted = computed(() => [...props.rows].sort((a, b) => Number(b.up) - Number(a.up) || a.name.localeCompare(b.name)));

const live = computed(() => sorted.value.filter((row) => row.up).length);
</script>

<template>
  <div class="dock" @mouseenter="enter" @mouseleave="leave">
    <button
      type="button"
      class="dock__mark"
      :class="{ 'dock__mark--on': open }"
      :title="`${ label }: ${ live } of ${ sorted.length } up`"
      :aria-expanded="open ? 'true' : 'false'"
      @click="open = !open"
    >
      <AppIcon :name="icon" :size="15" />
      <span v-if="live" class="dock__live">{{ live }}</span>
    </button>

    <Transition name="dock">
      <div v-if="open" class="dock__card">
        <header class="dock__head">
          <span class="dock__title">{{ label }}</span>
          <span class="dock__count">{{ live }} of {{ sorted.length }} up</span>
        </header>

        <ul v-if="sorted.length" class="dock__list">
          <li v-for="row in sorted" :key="row.id">
            <button
              type="button"
              class="ws"
              :class="{ 'ws--here': row.id === here || row.name === here }"
              @click="emit('open', row.id)"
            >
              <span
                class="ws__dot"
                :class="{ 'ws__dot--up': row.up, 'ws__dot--bad': row.bad }"
              />
              <span class="ws__name">{{ row.name }}</span>
              <span v-if="row.id === here || row.name === here" class="u-badge">this card</span>
              <span class="ws__state" :class="`ws__state--${ row.tone || 'muted' }`">{{ row.state }}</span>
            </button>

            <!-- What the normal view says about it: what it needs, and the room it has. -->
            <p v-if="row.note" class="ws__note">{{ row.note }}</p>
            <div v-if="meters && row.room" class="ws__room">
              <span v-for="meter in row.room" :key="meter.label" class="meter" :title="`${ meter.label }: ${ meter.text }`">
                <span class="meter__label">{{ meter.label }}</span>
                <span class="meter__track"><span class="meter__fill" :style="{ width: meter.fill }" /></span>
                <span class="meter__text">{{ meter.text }}</span>
              </span>
            </div>
          </li>
        </ul>

        <p v-else class="dock__empty">{{ empty }}</p>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
/*
 * Bottom left, over the deck, clear of the chat bar's own corner. Fixed rather than in the flow:
 * the deck is a grid of one row and anything added to it takes room from the card.
 */
/* Positioned by the row it is in, so the marks sit together in one corner. See Focus.vue. */
.dock { position: relative; }

.dock__mark {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  /* 34px: a corner control, and above the 30px the prototype's smallest button sets. */
  height: 34px;
  min-width: 34px;
  padding: 0 10px;
  border: 1px solid var(--border);
  border-radius: var(--r-pill);
  background: color-mix(in srgb, var(--surface) 86%, transparent);
  color: var(--text-muted);
  cursor: pointer;
  backdrop-filter: blur(8px);
  transition: color var(--fast), border-color var(--fast), background var(--fast);
}

.dock__mark:hover,
.dock__mark--on { border-color: var(--accent); color: var(--text); background: var(--surface); }

.dock__live {
  color: var(--accent);
  font-family: var(--font);
  font-size: var(--t-xs);
  font-weight: 650;
  font-variant-numeric: tabular-nums;
}

.dock__card {
  position: absolute;
  bottom: calc(100% + 8px);
  width: min(340px, 78vw);
  padding: var(--s3);
  border: 1px solid var(--border-strong);
  border-radius: var(--r-lg);
  background: var(--surface);
  box-shadow: var(--shadow-3);
}

.dock__card { left: 0; }

.dock__head {
  display: flex;
  align-items: baseline;
  gap: var(--s2);
  margin-bottom: var(--s2);
}

.dock__title { color: var(--text); font-size: var(--t-sm); font-weight: 650; }
.dock__count { margin-left: auto; color: var(--text-faint); font-size: var(--t-xs); }

.dock__list {
  display: flex;
  flex-direction: column;
  gap: 1px;
  max-height: 46vh;
  margin: 0;
  padding: 0;
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
.ws {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: var(--s2);
  width: 100%;
  min-height: 30px;
  padding: 0 var(--s2);
  border: 0;
  border-radius: var(--r-sm);
  background: none;
  color: var(--text-dim);
  font: inherit;
  font-size: var(--t-sm);
  text-align: left;
  cursor: pointer;
}

.ws:hover { background: var(--surface-raised); color: var(--text); }
.ws--here { background: var(--accent-wash); color: var(--text); }

.ws__dot {
  flex: 0 0 auto;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--text-faint);
}

.ws__dot--up { background: var(--success); }
.ws__dot--bad { background: var(--danger); }

.ws__name {
  min-width: 0;
  overflow: hidden;
  font-family: var(--mono);
  font-size: var(--t-xs);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ws__state { margin-left: auto; flex: 0 0 auto; color: var(--text-faint); font-size: var(--t-xs); }

/* The tones the sidebar's own rows use, so a state reads the same in both places. */
.ws__state--busy { color: var(--kind-agent, var(--text-dim)); }
.ws__state--needs { color: var(--accent); font-weight: 600; }
.ws__state--bad { color: var(--danger); }
.ws__state--good { color: var(--success); }

/* What it needs, in the words the sidebar uses. */
.ws__note {
  margin: 0 0 var(--s2);
  padding: 0 var(--s2) 0 calc(7px + var(--s2));
  color: var(--text-muted);
  font-size: var(--t-xs);
  line-height: 1.45;
}

/* ── The room, for the things that have any ───────────────────────────────────────────────── */
.ws__room { display: flex; gap: var(--s3); padding: 0 var(--s2) var(--s2) calc(7px + var(--s2)); }

.meter { display: flex; align-items: center; gap: 5px; min-width: 0; }
.meter__label { color: var(--text-faint); font-size: 10px; }

.meter__track {
  width: 46px;
  height: 4px;
  border-radius: var(--r-pill);
  background: var(--surface-raised);
  overflow: hidden;
}

.meter__fill { display: block; height: 100%; background: var(--success); }
.meter__text { color: var(--text-muted); font-size: 10px; font-variant-numeric: tabular-nums; }

.dock__empty { margin: 0; color: var(--text-muted); font-size: var(--t-sm); line-height: 1.5; }

.dock-enter-active { transition: opacity var(--fast) var(--ease-out), transform var(--fast) var(--ease-out); }
.dock-leave-active { transition: opacity var(--fast) linear; }
.dock-enter-from,
.dock-leave-to { opacity: 0; transform: translateY(4px); }
</style>
