<script setup lang="ts">
/**
 * The full view of a thumbnail.
 *
 * On a card, media is small on purpose - it is evidence, not the point - so the thumbnail has
 * to open into something you can actually read: an image you can zoom into and drag around, a
 * video you can scrub. Everything the card holds is in here, so moving between the three shots
 * an agent attached does not mean closing one and finding the next.
 *
 * Zoom follows the pointer rather than the centre, because the thing you want to look at is
 * under the cursor, and dragging is only enabled once there is somewhere to drag to.
 *
 * **Two views, and the grid is the way in.** This opened on the first artifact with `‹ ›` under
 * it, which is a serial reader for a set: an agent attaches four or five things to one pull
 * request - two screenshots, a recording of the fix, a recording of the regression - and getting
 * to the last one meant loading and watching every one before it, with nothing but a file name
 * at the bottom to say which was which. So all of them are drawn at once as tiles, and the
 * single view is what a tile opens into. Everything that view could already do is unchanged;
 * what is new is that you can choose.
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { CardMedia } from '../../focus-artifacts';
import AppIcon from './AppIcon.vue';
import IconButton from './IconButton.vue';
import { holdOverlay, releaseOverlay } from './overlay';

const props = defineProps<{ items: CardMedia[]; start?: number }>();
const emit = defineEmits<{ (e: 'close'): void }>();

/**
 * Which of the two views is up: all of them, or one of them.
 *
 * The grid is the default, with two exceptions, and both of them are the same rule - do not put
 * a choice in front of somebody who has already made it:
 *
 *   - one artifact is not a set. A grid of one is a thumbnail you have to click to see the
 *     thing you asked for, so it opens on the thing.
 *   - a caller that names a `start` has picked. `CommentBody` hands over the thumbnail somebody
 *     clicked inside a review comment, and `ReviewPass` passes it straight through; the grid
 *     there would be one click back to where they already were.
 *
 * Which leaves the card's own `n recordings` pill, where "show me what it recorded" is exactly
 * the question a grid answers. See CardEvidence.
 */
const grid = ref(props.items.length > 1 && props.start === undefined);

/**
 * Whether the one in view was opened from the grid.
 *
 * Escape goes back to the grid rather than out - a set you are picking through is two keys, not
 * two keys and a re-open - but only from a grid you were actually on. Opened on a comment's
 * thumbnail, Escape is the way back to the comment, and dropping somebody into a grid they
 * never saw is not a way out.
 */
const cameFromGrid = ref(false);

const at = ref(props.start ?? 0);
const item = computed(() => props.items[at.value]);

const scale = ref(1);
const x = ref(0);
const y = ref(0);
const stage = ref<HTMLElement>();
const dragging = ref(false);
let from = { x: 0, y: 0, ox: 0, oy: 0 };

const MIN = 1;
const MAX = 6;

/** What a tile says it is. The card calls the set "recordings"; a tile has to be exact. */
const KIND = { image: 'Image', video: 'Recording' } as const;

function reset() {
  scale.value = 1;
  x.value = 0;
  y.value = 0;
}

function go(step: 1 | -1) {
  at.value = (at.value + step + props.items.length) % props.items.length;
}

/** A tile, opened. `reset` explicitly because `at` may already be where it is going. */
function openOne(n: number) {
  at.value = n;
  cameFromGrid.value = true;
  grid.value = false;
  reset();
}

const showAll = () => { grid.value = true; };

watch(at, reset);

/**
 * A recording's still, in two steps, because one of them is not enough.
 *
 * **The fragment paints something.** `preload="metadata"` fetches the header and nothing else,
 * which is what keeps a grid of five recordings the cost of five headers rather than five
 * videos; `#t=0.1` on top of it sets the element's initial seek position, so the browser decodes
 * and paints that frame instead of leaving a tile the colour of its own background. Measured in
 * Chrome 131 against a real 18.4s agent recording: the tile paints a decoded frame, and the
 * fragment is honoured as a seek - `#t=3` and `#t=8` of the same file paint visibly different
 * pictures.
 *
 * Left alone if the caller's URL already carries a fragment: `workspaceMediaFileUrl` builds a
 * query, not a hash, but a GitHub asset URL is somebody else's string and may hold anything.
 */
function firstFrame(src: string) {
  return src.includes('#') ? src : `${ src }#t=0.1`;
}

/**
 * **And the nudge makes it a picture of something.** The frame a tenth of a second in is very
 * often blank: a recording of a dashboard flow opens on the page before it has painted. On the
 * same 18.4s recording, every frame up to about 2.2s was plain white - three recordings of three
 * different fixes would have been three identical white tiles, which is the grid failing at the
 * one thing it is for.
 *
 * So once the metadata is in and the duration is known, the still moves to a quarter of the way
 * in, capped at three seconds. A quarter because it has to be inside the clip whatever its
 * length, and a cap because the seek is the one thing here that costs more than a header - three
 * seconds of video, once, per recording on screen.
 *
 * It runs after the fragment has already put a frame up, so a seek that never lands leaves the
 * tile with the opening frame rather than with nothing.
 */
function still(event: Event) {
  const video = event.target as HTMLVideoElement;
  const { duration } = video;

  if (Number.isFinite(duration) && duration > 0) {
    video.currentTime = Math.min(3, duration / 4);
  }
}

/** How old the evidence is, in the deck's own shorthand. Same scale as CardCommits' `when`. */
function when(iso: string) {
  const ms = Date.now() - Date.parse(iso || '');

  if (!Number.isFinite(ms)) {
    return '';
  }
  const hours = Math.round(ms / 3_600_000);

  return hours < 1 ? 'just now' : hours < 48 ? `${ hours }h` : `${ Math.round(hours / 24) }d`;
}

/** Zoom about a point, so what is under the cursor stays under the cursor. */
function zoomAt(factor: number, clientX?: number, clientY?: number) {
  const next = Math.min(MAX, Math.max(MIN, scale.value * factor));
  const box = stage.value?.getBoundingClientRect();

  if (box && clientX !== undefined && clientY !== undefined) {
    const px = clientX - box.left - box.width / 2;
    const py = clientY - box.top - box.height / 2;
    const ratio = next / scale.value;

    x.value = px - (px - x.value) * ratio;
    y.value = py - (py - y.value) * ratio;
  }
  scale.value = next;
  if (next === MIN) {
    x.value = 0;
    y.value = 0;
  }
}

function onWheel(event: WheelEvent) {
  event.preventDefault();
  zoomAt(event.deltaY < 0 ? 1.18 : 1 / 1.18, event.clientX, event.clientY);
}

function onDown(event: PointerEvent) {
  if (scale.value === MIN) {
    return;
  }
  dragging.value = true;
  from = { x: event.clientX, y: event.clientY, ox: x.value, oy: y.value };
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
}

function onMove(event: PointerEvent) {
  if (!dragging.value) {
    return;
  }
  x.value = from.ox + (event.clientX - from.x);
  y.value = from.oy + (event.clientY - from.y);
}

const onUp = () => { dragging.value = false; };

function onKey(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    if (cameFromGrid.value && !grid.value) {
      showAll();
    } else {
      emit('close');
    }
  }
  if (grid.value) {
    /*
     * The arrows and the zoom reset belong to the one in view, and on the grid there is no "one"
     * for them to mean anything about. The tiles are buttons, so Tab and Enter already walk them.
     */
    return;
  }
  if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
    event.preventDefault();
    go(1);
  }
  if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
    event.preventDefault();
    go(-1);
  }
  if (event.key === '0') {
    reset();
  }
}

/*
 * The deck also listens on the window, and it turns on the arrow keys. While this is open the
 * arrows belong to the pictures, so the deck is told to keep its hands down.
 */
onMounted(() => {
  holdOverlay();
  window.addEventListener('keydown', onKey);
});

onBeforeUnmount(() => {
  releaseOverlay();
  window.removeEventListener('keydown', onKey);
});
</script>

<template>
  <div class="viewer" @click.self="emit('close')">
    <header class="viewer__bar" @click.stop>
      <!--
        The way back to the set, offered whenever there is a set - including when the viewer
        opened on one artifact from a comment, where "there are four of these" is news.
      -->
      <button
        v-if="!grid && items.length > 1"
        type="button"
        class="viewer__back"
        :title="`Back to all ${ items.length } artifacts`"
        @click="showAll"
      >
        <AppIcon name="grid" :size="13" />
        All {{ items.length }}
      </button>

      <span class="viewer__label">{{ grid ? 'Artifacts' : item.label }}</span>
      <span v-if="grid" class="viewer__count">{{ items.length }} attached</span>
      <span v-else-if="items.length > 1" class="viewer__count">{{ at + 1 }} of {{ items.length }}</span>

      <span class="viewer__tools">
        <template v-if="!grid && item.kind === 'image'">
          <IconButton name="minus" label="Zoom out" :size="34" @click="zoomAt(1 / 1.4)" />
          <span class="viewer__scale">{{ Math.round(scale * 100) }}%</span>
          <IconButton name="plus" label="Zoom in" :size="34" @click="zoomAt(1.4)" />
          <IconButton name="expand" label="Fit to the window" :size="34" @click="reset" />
        </template>
        <IconButton name="cross" label="Close" :size="34" @click="emit('close')" />
      </span>
    </header>

    <!--
      All of them at once: the picker, and the view this opens on when a card hands over a set.
      Nothing plays here - a tile is the frame the recording opens on, for the reason CommentBody
      gives: five players in a dialog is five things making noise about where you have not looked.
    -->
    <div v-if="grid" class="viewer__grid" @click.self="emit('close')">
      <button
        v-for="(shot, n) in items"
        :key="`${ shot.src }-${ n }`"
        type="button"
        class="shot"
        :title="shot.caption ? `${ shot.label } — ${ shot.caption }` : `Open ${ shot.label }`"
        @click="openOne(n)"
      >
        <span class="shot__frame">
          <video
            v-if="shot.kind === 'video'"
            class="shot__media"
            :src="firstFrame(shot.src)"
            preload="metadata"
            muted
            playsinline
            @loadedmetadata="still"
          />
          <img
            v-else
            class="shot__media"
            :src="shot.src"
            :alt="shot.caption || shot.label"
            loading="lazy"
          >

          <span v-if="shot.kind === 'video'" class="shot__play"><AppIcon name="play" :size="16" /></span>
        </span>

        <!--
          The name, in full and on two lines if it needs them. Three near-identical screenshots
          of the same page is the normal case, so the file name is the whole difference between
          them and an ellipsis through the middle of it takes that away.
        -->
        <span class="shot__name">{{ shot.label }}</span>
        <span class="shot__meta">
          <AppIcon :name="shot.kind === 'video' ? 'play' : 'image'" :size="11" />
          {{ KIND[shot.kind] }}<template v-if="when(shot.at)"> · {{ when(shot.at) }}</template>
        </span>
      </button>
    </div>

    <div
      v-else
      ref="stage"
      class="viewer__stage"
      :class="{ 'viewer__stage--grab': scale > 1, 'viewer__stage--held': dragging }"
      @click.self="emit('close')"
      @wheel.prevent="item.kind === 'image' ? onWheel($event) : undefined"
    >
      <img
        v-if="item.kind === 'image'"
        :src="item.src"
        :alt="item.label"
        class="viewer__img"
        :style="{ transform: `translate(${ x }px, ${ y }px) scale(${ scale })`, transition: dragging ? 'none' : undefined }"
        draggable="false"
        @pointerdown="onDown"
        @pointermove="onMove"
        @pointerup="onUp"
        @pointercancel="onUp"
        @dblclick="scale > 1 ? reset() : zoomAt(2.4, $event.clientX, $event.clientY)"
      >

      <video
        v-else
        :src="item.src"
        class="viewer__video"
        controls
        autoplay
        loop
        playsinline
      />
    </div>

    <footer class="viewer__foot" @click.stop>
      <template v-if="grid">
        <p class="viewer__caption">Open one to read it full size, zoom into it or scrub it.</p>
      </template>
      <template v-else>
        <IconButton v-if="items.length > 1" name="chevron-left" label="Previous" :size="34" @click="go(-1)" />
        <p class="viewer__caption">{{ item.caption || item.label }}</p>
        <IconButton v-if="items.length > 1" name="chevron-right" label="Next" :size="34" @click="go(1)" />
      </template>
    </footer>
  </div>
</template>

<style scoped>
.viewer {
  position: fixed;
  inset: 0;
  z-index: 80;
  display: grid;
  grid-template-rows: auto minmax(0, 1fr) auto;
  gap: var(--s3);
  padding: var(--s4) clamp(var(--s4), 3vw, var(--s6)) var(--s5);
  background: color-mix(in srgb, var(--ground-deep) 88%, transparent);
  backdrop-filter: blur(14px);
  animation: viewer-in var(--base) var(--ease-out);
}

@keyframes viewer-in {
  from { opacity: 0; backdrop-filter: blur(0); }
}

.viewer__bar {
  display: flex;
  align-items: center;
  gap: var(--s3);
  min-width: 0;
}

.viewer__label {
  color: var(--text);
  font-size: var(--t-lg);
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.viewer__count { color: var(--text-muted); font-size: var(--t-sm); }
.viewer__tools { display: flex; align-items: center; gap: var(--s2); margin-left: auto; }
.viewer__scale { min-width: 4ch; color: var(--text-dim); font-size: var(--t-sm); text-align: center; }

/*
 * The way back, as a labelled control rather than one more round icon.
 *
 * The bar's right-hand end is four 34px circles already, and a fifth one meaning "back to the
 * grid" is indistinguishable from the four that zoom. `flex: 0 0 auto` because the label beside
 * it is `overflow: hidden` and shrinks - this one must not, or the route out of a single
 * artifact ellipsises away on a narrow deck.
 */
.viewer__back {
  display: inline-flex;
  align-items: center;
  flex: 0 0 auto;
  gap: var(--s2);
  height: var(--control-h);
  padding: 0 var(--s3);
  border: 1px solid var(--border);
  border-radius: var(--r-pill);
  background: var(--surface-raised);
  color: var(--text-dim);
  font: inherit;
  font-size: var(--t-sm);
  cursor: pointer;
  transition: border-color var(--fast) var(--ease-out), color var(--fast) var(--ease-out);
}

.viewer__back:hover { border-color: var(--border-strong); color: var(--text); }

.viewer__stage {
  display: grid;
  place-items: center;
  min-height: 0;
  overflow: hidden;
  border-radius: var(--r-lg);
}

.viewer__stage--grab { cursor: grab; }
.viewer__stage--held { cursor: grabbing; }

.viewer__img {
  max-width: 100%;
  max-height: 100%;
  border-radius: var(--r-md);
  box-shadow: var(--shadow-3);
  transform-origin: 50% 50%;
  transition: transform var(--base) var(--ease-out);
  user-select: none;
  -webkit-user-drag: none;
}

.viewer__video {
  max-width: 100%;
  max-height: 100%;
  border-radius: var(--r-md);
  /* The deepest ground, not a literal black: this view has a light theme and the letterbox
     around a portrait recording was the one part of the viewer that did not know. */
  background: var(--ground-deep);
  box-shadow: var(--shadow-3);
}

/* ── All of them at once ─────────────────────────────────────────────────────────────────── */
/*
 * The tiles occupy the same `minmax(0, 1fr)` row the single artifact does - they are an `v-else`
 * of each other, so the dialog still has exactly three children for its three tracks. The row
 * is what scrolls; the dialog never does.
 *
 * `align-content: start` because that row stretches: two artifacts in a full-height track with
 * stretched rows is two tiles the height of the window.
 */
.viewer__grid {
  display: grid;
  /*
   * `min(220px, 100%)` rather than a flat 220px: `auto-fill` with a minimum wider than the
   * container does not wrap, it overflows, and this is open at anything from 1024px down to a
   * phone. The `min()` lets the one remaining column shrink below the ideal tile instead.
   */
  grid-template-columns: repeat(auto-fill, minmax(min(220px, 100%), 1fr));
  /*
   * `max-content` rather than the implicit `auto`, and `align-content: start` rather than the
   * implicit stretch. Both are the same bug, measured at a 500px viewport with five artifacts:
   * an `auto` row in a scroller with a definite height is sized against the space available
   * rather than against its contents, so three rows of 207px tiles came out 152px each - the
   * thumbnail squeezed from 127px to 83px and the second line of every name sliced in half - and
   * nothing clipped it, so each row of tiles painted over the one under it. `max-content` sizes
   * a row to the tile; the scroller is then what the overflow goes to, which is its job.
   */
  grid-auto-rows: max-content;
  align-content: start;
  gap: var(--s4);
  min-height: 0;
  /* Room for a tile's hover lift and focus ring, which a flush scroller clips. */
  padding: var(--s1);
  overflow-y: auto;
}

/*
 * A tile: what it looks like, what it is called, what kind of thing it is.
 *
 * `min-height` far over the 30px floor and said out loud, because this is a control and the
 * design check reads heights rather than guessing from the contents.
 */
.shot {
  display: flex;
  flex-direction: column;
  gap: var(--s2);
  min-width: 0;
  min-height: 120px;
  padding: var(--s2);
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  background: var(--surface);
  text-align: left;
  cursor: pointer;
  transition:
    background var(--fast) var(--ease-out),
    border-color var(--fast) var(--ease-out),
    transform var(--base) var(--ease-out);
}

.shot:hover {
  border-color: var(--border-strong);
  background: var(--surface-raised);
  transform: translateY(-2px);
}

.shot:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

/* `flex: 0 0 auto` on the two parts that have a size of their own, because a flex child shrinks
   by default and these two are the ones with something to lose: an aspect-ratio box squeezed out
   of its ratio, and a two-line name cut through the middle of its second line. */
.shot__frame {
  position: relative;
  display: block;
  flex: 0 0 auto;
  aspect-ratio: 16 / 10;
  border-radius: var(--r-sm);
  /* A video paints its own background before a frame arrives, and an image that has not loaded
     paints nothing; the deepest ground rather than a literal, so both follow the light theme. */
  background: var(--ground-deep);
  overflow: hidden;
}

.shot__media {
  display: block;
  width: 100%;
  height: 100%;
  /*
   * `contain`, not `cover`. Several artifacts on one pull request are the same screen at
   * different moments, and a crop to a tidy 16:10 throws away the edges - the dialog that is
   * open, the row that is selected - which is the part that tells them apart.
   */
  object-fit: contain;
}

.shot__play {
  position: absolute;
  inset: 50% auto auto 50%;
  display: grid;
  place-items: center;
  width: 34px;
  height: 34px;
  border-radius: var(--r-pill);
  /* Tokens, so the scrim and its glyph follow `body.theme-light`. See CommentBody. */
  background: color-mix(in srgb, var(--ground) 72%, transparent);
  color: var(--text);
  transform: translate(-50%, -50%);
}

.shot__name {
  display: -webkit-box;
  flex: 0 0 auto;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  color: var(--text);
  font-size: var(--t-sm);
  font-weight: 600;
  line-height: 1.35;
  /* A name is one unbroken token - `0004-checks-after-the-fix.png` - so it breaks where it must
     rather than pushing the tile wider than its column. */
  overflow: hidden;
  overflow-wrap: anywhere;
}

/* Pushed to the floor of the tile, so the kind and the age line up across a row whether the
   name above them took one line or two. */
.shot__meta {
  display: flex;
  align-items: center;
  gap: var(--s1);
  margin-top: auto;
  color: var(--text-muted);
  font-size: var(--t-xs);
}

.viewer__foot {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--s4);
}

.viewer__caption {
  max-width: 78ch;
  color: var(--text-dim);
  font-size: var(--t-sm);
  line-height: 1.5;
  text-align: center;
}

@media (max-width: 860px) {
  .viewer { padding: var(--s3); }
  .viewer__label { font-size: var(--t-md); }
  /*
   * Two tiles across a phone rather than one: the grid is for comparing, and a single column of
   * them is the serial reader this replaced, with extra steps.
   *
   * 160 rather than 140, measured: at a 500px viewport a 140px minimum fits three columns of
   * 148px, and two lines of a 148px tile is about 34 characters - `0004-secret-detail-final-
   * state.png` loses its tail, which is the half of the name that says which shot it is. 160
   * fits two columns of 232px there and still four across 860px.
   */
  .viewer__grid { grid-template-columns: repeat(auto-fill, minmax(min(160px, 100%), 1fr)); gap: var(--s3); }
}
</style>
