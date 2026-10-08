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

const emit = defineEmits<{
  (e: 'open', id: string): void;
  (e: 'act', value: { row: DockRow; action: string }): void;
}>();

/**
 * The destructive action that has been pressed once.
 *
 * Deleting a Rancher takes its cluster and its node with it, and this is a list you open by
 * resting a pointer in a corner - so it asks, the way the card's own merge does.
 */
const sure = ref('');

function press(row: DockRow, action: { id: string; danger?: boolean }) {
  const key = `${ row.id }:${ action.id }`;

  if (action.danger && sure.value !== key) {
    sure.value = key;

    return;
  }
  sure.value = '';
  emit('act', { row, action: action.id });
}

const open = ref(false);
const mark = ref<HTMLElement | null>(null);

/**
 * Where the card goes, measured off the mark each time it opens.
 *
 * It is teleported to the body, which is what every other popover in this view does and what this
 * one did not. The deck sets `perspective` on itself and `transform-style: preserve-3d` on the
 * card it is showing, and inside a 3D rendering context what paints on top follows Z position
 * rather than `z-index` - so the card drew over this popover whatever number it was given. Out of
 * that subtree it is an ordinary fixed box and the number means something again.
 */
const at = ref<{ left: number; top: number | null; bottom: number | null }>({ left: 0, top: null, bottom: null });

/** What the card is at most; it is `min(340px, 78vw)` in the stylesheet. */
const CARD_W = 340;
const GAP = 8;

/**
 * Below the mark or above it, whichever has the room, and never off an edge.
 *
 * It opened upward unconditionally, from when both marks sat in the bottom-left corner. They are
 * at the top now, so "upward" put the card 357px above the top of the window and 49px past the
 * right of it - measured, with `elementFromPoint` returning null at every corner of it. It read as
 * the popover being behind the card; it was never on the screen.
 *
 * So the direction follows the room, and both axes are clamped to the window. A popover that
 * decides its side from where its control actually is does not care where the dock moves to next.
 */
function place() {
  const box = mark.value?.getBoundingClientRect();

  if (!box) {
    return;
  }
  const room = { below: window.innerHeight - box.bottom, above: box.top };
  const width = Math.min(CARD_W, window.innerWidth * 0.78);
  const left = Math.round(Math.min(Math.max(GAP, box.left), window.innerWidth - width - GAP));

  at.value = room.below >= room.above
    ? { left, top: Math.round(box.bottom + GAP), bottom: null }
    : { left, top: null, bottom: Math.round(window.innerHeight - box.top + GAP) };
}
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
      place();
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
      ref="mark"
      :aria-expanded="open ? 'true' : 'false'"
      @click="place(); open = !open"
    >
      <AppIcon :name="icon" :size="15" />
      <!--
        What it counts, in words.

        The mark drew a bare number - "5" and "2", two 55x34 chips in a corner - and the `label`
        prop it was given never appeared anywhere you could see without opening it. A corner
        control with a number and no noun is a thing people press to find out what it is.
      -->
      <span class="dock__name">{{ label }}</span>
      <span v-if="live" class="dock__live">{{ live }}</span>
    </button>

    <Teleport to="body">
      <div class="dev-focus dock-layer" @mouseenter="enter" @mouseleave="leave">
        <Transition name="dock">
          <div
            v-if="open"
            class="dock__card"
            :style="{
              left: `${ at.left }px`,
              ...(at.top === null ? { bottom: `${ at.bottom }px` } : { top: `${ at.top }px` }),
            }"
          >
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

            <!-- What the sidebar's own rows offer for this thing, in the card where it is listed. -->
            <span v-if="row.actions && row.actions.length" class="ws__acts">
              <button
                v-for="action in row.actions"
                :key="action.id"
                type="button"
                class="ws__act"
                :class="{ 'ws__act--danger': action.danger, 'ws__act--sure': sure === `${ row.id }:${ action.id }` }"
                :title="sure === `${ row.id }:${ action.id }` ? `${ action.label } — press again` : action.label"
                @click="press(row, action)"
              >
                <AppIcon :name="(action.icon as never)" :size="12" />
              </button>
            </span>

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
    </Teleport>
  </div>
</template>

<style scoped>
/* Positioned by the row it is in: the page's header. See Focus.vue. */
.dock { position: relative; }

.dock__mark {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  /* 34px: a corner control, and above the 30px the prototype's smallest button sets. */
  /* The bar's height: these sit on its line and must not be a different size. */
  height: var(--bar-h, 34px);
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

.dock__name { color: var(--text-dim); font-size: var(--t-sm); white-space: nowrap; }

.dock__live {
  color: var(--accent);
  font-family: var(--font);
  font-size: var(--t-xs);
  font-weight: 650;
  font-variant-numeric: tabular-nums;
}

/*
 * Opens downward, from the header's right edge: it hangs under the control that opened it, over
 * the deck, which is where there is room. It opened upward when the mark lived in the bottom-left
 * corner.
 */
/* A box of nothing that carries the view's tokens to a teleported child. See FocusModal. */
.dock-layer {
  position: fixed;
  inset: 0;
  z-index: 60;
  pointer-events: none;
}

.dock-layer > * { pointer-events: auto; }

.dock__card {
  position: fixed;
  width: min(340px, 78vw);
  padding: var(--s3);
  border: 1px solid var(--border-strong);
  border-radius: var(--r-lg);
  background: var(--surface);
  box-shadow: var(--shadow-3);
}

.dock__card { right: 0; }

.dock__head {
  display: flex;
  align-items: baseline;
  gap: var(--s2);
  margin-bottom: var(--s2);
}

.dock__title { color: var(--text); font-size: var(--t-sm); font-weight: 650; }
.dock__count { margin-left: auto; color: var(--text-faint); font-size: var(--t-xs); }

/* Never taller than the room its side has; the rest scrolls. */
.dock__card { max-height: min(46vh, calc(100vh - 96px)); display: flex; flex-direction: column; }

.dock__list {
  /*
   * The state dot's width, declared where all three things that depend on it can see it: the
   * dot itself and the two lines that hang under a row and indent past it. The 7 was written
   * out in three places, so the indent could drift off the dot by anybody changing one.
   */
  --ws-dot: 7px;
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
  width: var(--ws-dot);
  height: var(--ws-dot);
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

/* ── What you can do to a row ─────────────────────────────────────────────────────────────── */
.ws__acts {
  display: flex;
  gap: 2px;
  /* `--ws-dot`, which `.dock__list` declares for exactly this: the 7 was written out in three
     places, and this was the third one still writing it out. */
  padding: 0 var(--s2) var(--s2) calc(var(--ws-dot) + var(--s2));
}

.ws__act {
  display: grid;
  place-items: center;
  /* 30px, the smallest the prototype presses. A 20px icon button in a popover is a dare. */
  width: 30px;
  height: 30px;
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  transition: color var(--fast), border-color var(--fast), background var(--fast);
}

.ws__act:hover { border-color: var(--accent); color: var(--text); }
.ws__act--danger:hover { border-color: var(--danger); color: var(--danger); }

/* Pressed once: the next press does it. */
.ws__act--sure {
  border-color: var(--danger);
  background: color-mix(in srgb, var(--danger) 16%, transparent);
  color: var(--danger);
}

/* The tones the sidebar's own rows use, so a state reads the same in both places. */
.ws__state--busy { color: var(--kind-agent, var(--text-dim)); }
.ws__state--needs { color: var(--accent); font-weight: 600; }
.ws__state--bad { color: var(--danger); }
.ws__state--good { color: var(--success); }

/* What it needs, in the words the sidebar uses. */
.ws__note {
  margin: 0 0 var(--s2);
  padding: 0 var(--s2) 0 calc(var(--ws-dot) + var(--s2));
  color: var(--text-muted);
  font-size: var(--t-xs);
  line-height: 1.45;
}

/* ── The room, for the things that have any ───────────────────────────────────────────────── */
.ws__room { display: flex; gap: var(--s3); padding: 0 var(--s2) var(--s2) calc(var(--ws-dot) + var(--s2)); }

.meter { display: flex; align-items: center; gap: 5px; min-width: 0; }
.meter__label { color: var(--text-faint); font-size: var(--t-2xs); }

.meter__track {
  width: 46px;
  height: 4px;
  border-radius: var(--r-pill);
  background: var(--surface-raised);
  overflow: hidden;
}

.meter__fill { display: block; height: 100%; background: var(--success); }
.meter__text { color: var(--text-muted); font-size: var(--t-2xs); font-variant-numeric: tabular-nums; }

.dock__empty { margin: 0; color: var(--text-muted); font-size: var(--t-sm); line-height: 1.5; }

.dock-enter-active { transition: opacity var(--fast) var(--ease-out), transform var(--fast) var(--ease-out); }
.dock-leave-active { transition: opacity var(--fast) linear; }
.dock-enter-from,
.dock-leave-to { opacity: 0; transform: translateY(4px); }
</style>
