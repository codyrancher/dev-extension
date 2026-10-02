<script setup lang="ts">
/**
 * The rolodex.
 *
 * Three cards exist at a time: the one you are reading and two behind it, scaled down and
 * pushed back so the deck has depth without a stack of edges to look at. Moving is one
 * transition - the top card leaves in the direction of travel while the next scales up into
 * its place - and it is driven by three inputs that all end in the same call: drag, keyboard,
 * and the rail of dots.
 *
 * The drag is pointer events rather than a library: a card follows the finger with a little
 * rotation, and lets go past a threshold that scales with the viewport so the gesture feels the
 * same on a phone as on a desktop.
 */
import { computed, onMounted, onBeforeUnmount, ref } from 'vue';
import type { FocusTask, CardAction } from '../../focus';
import FocusCard from './FocusCard.vue';
import AppIcon from './AppIcon.vue';
import { overlayOpen } from './overlay';

const props = defineProps<{
  cards: FocusTask[];
  index: number;
  direction: 1 | -1;
  busy?: boolean;
  /** The agent's comments for the card on top, when its work is a review. See focus-review.ts. */
  notes?: unknown[];
  /** Everything else the card on top has to show. See focus-artifacts.ts; opaque here. */
  artifacts?: unknown;
  /**
   * A card is in the air between this deck and the pinned rail - see CardFlight.
   *
   * The deck does not turn while that is true, in either direction. Nothing is being dealt: the
   * card is going to the rail or coming back from it, and the flight is the whole of the
   * movement. Left to itself the deck would animate its own half as well, so pinning threw the
   * card off the bottom of the screen at the same time as the copy of it flew to the dock.
   */
  quiet?: boolean;
  /**
   * ...and that card is landing on top of this deck, so the top card is not drawn at all. The one
   * flying in is the same card, and two of it is one too many.
   */
  landing?: boolean;
}>();

const emit = defineEmits<{
  (e: 'go', step: 1 | -1): void;
  (e: 'jump', index: number): void;
  (e: 'act', payload: { task: FocusTask; action: CardAction }): void;
  (e: 'ask', task: FocusTask): void;
  (e: 'pin', task: FocusTask): void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (e: 'resolve', value: any): void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (e: 'discuss', value: any): void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (e: 'ask-code', value: any): void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (e: 'reply', value: any): void;
}>();

const current = computed(() => props.cards[props.index] || null);

/**
 * The stack above the card you are reading.
 *
 * Three are rendered and two are ever seen: the third sits at the second's exact position,
 * behind it and completely hidden by it. That is what a card mounts into. A deck that rendered
 * only what shows had to mount a new band on every turn, and a band appearing out of nothing at
 * the top of the screen is a pop no easing can cover - this way the new one is already there,
 * and the turn only uncovers it.
 */
const behind = computed(() => {
  const n = props.cards.length;

  // A ring, not a run: at the end of the deck the stack shows the cards it is about to come
  // back round to, so the last card looks like a card in a deck rather than the last page of
  // one. Capped at n - 1 so the card you are reading is never also stacked above itself.
  return Array.from({ length: Math.min(3, Math.max(0, n - 1)) }, (_, k) => props.cards[(props.index + k + 1) % n]);
});

const deck = ref<HTMLElement>();

/** How far back each step in the stack sits, shrinks and dims. */
const STEP_Y = 15;
const STEP_SCALE = 0.016;
const STEP_DIM = 0.14;
const DEEPEST = 2;

/** And how a card lies on the floor, below the screen. Mirrors `--floor-*` on `.deck`. */
const FLOOR_SCALE = 0.94;
const FLOOR_TILT = 9;

/**
 * On the floor, raised by however many pixels a hand has pulled it.
 *
 * Pixels rather than a fraction of the journey: the card under the finger moves with the
 * finger, and the one coming up from below has to move with it too or the two halves of the
 * gesture travel at different speeds. It stays flat and small the whole time it is down there -
 * the scale and the tilt are the turn's to resolve, which is what makes a released drag finish
 * as the same movement a wheel or a key starts.
 */
function floorLifted(by = 0) {
  return `translate3d(0, calc(var(--floor-y) - ${ Math.round(by) }px), 0)`
    + ` scale(${ FLOOR_SCALE }) rotateX(${ FLOOR_TILT }deg)`;
}

/** How far up off the floor a drag is allowed to pull it, so a turn is always left to play. */
const REACH = 300;

/** `lift` is how many steps back in the stack, and takes fractions while a drag is pulling. */
function stackAt(lift: number) {
  return `translate3d(0, ${ (-STEP_Y * lift).toFixed(2) }px, 0) scale(${ (1 - STEP_SCALE * lift).toFixed(4) })`;
}

/**
 * Where a band sits, as a style rather than a custom property.
 *
 * It was `--depth` on the element and the arithmetic in CSS, which is tidier to read and does
 * not animate: the whole stack stepped down in one frame while the card it belonged to took
 * half a second to move. Written out as a transform, the browser has two values it understands
 * and interpolates between them.
 */
function bandStyle(depth: number) {
  const lift = Math.min(depth - progressValue(), DEEPEST);

  return {
    transform: stackAt(lift),
    filter: `brightness(${ (1 - STEP_DIM * lift).toFixed(3) })`,
    zIndex: 9 - depth,
  };
}

/*
 * ── Picking a turn up where the drag put it ───────────────────────────────
 *
 * A turn is two elements swapping, and Vue hands each of them a start state from a class - so
 * a card let go of halfway down snapped back to the top and fell again from there, which is the
 * one moment in the deck where the animation argued with the hand.
 *
 * The start states are read from these instead, set at the moment of release to wherever the
 * drag had got to, and unset afterwards so a turn from the keyboard or the rail starts from the
 * places the classes name.
 */
function carry(out: string | null, into: string | null, dim: string | null) {
  const el = deck.value;

  if (!el) {
    return;
  }
  for (const [name, value] of [['--carry-out', out], ['--carry-in', into], ['--carry-dim', dim]] as const) {
    if (value) {
      el.style.setProperty(name, value);
    } else {
      el.style.removeProperty(name);
    }
  }
}

const clearCarry = () => carry(null, null, null);

/**
 * Where the card on top is, for something outside the deck that has to fly to or from it.
 *
 * This replaces `enterFrom`, which tried to start the deck's own turn from the pinned rail by
 * setting `--carry-in`. Two things were wrong with that and neither was fixable from here. The
 * forward reading uncovers the arriving card from *underneath* the one leaving - on purpose, it
 * is the whole of what dealing a card looks like - so a card coming back from the rail arrived
 * behind the card on top. And the custom property was cleared by a transition end, so when the
 * card landed on the index that was already showing, no transition ran, nothing cleared, and the
 * animation played once and never again. A flight is not a turn; it is drawn as its own thing.
 */
function topRect(): DOMRect | null {
  return (deck.value?.querySelector('.deck__top') as HTMLElement | null)?.getBoundingClientRect() || null;
}

defineExpose({ topRect });

/** Every input ends here: the deck only carries a start state when a hand chose one. */
function go(step: 1 | -1) {
  clearCarry();
  emit('go', step);
}

/**
 * The card on its way out keeps the inline transform of the drag that sent it, because Vue
 * leaves rather than patches it - and an inline transform beats the class that is meant to be
 * moving it, so the card simply stopped. Handing it back to the stylesheet is what lets it go.
 */
function onBeforeLeave(el: Element) {
  (el as HTMLElement).style.transform = '';
  (el as HTMLElement).style.transition = '';
}

/**
 * The card before this one, kept on the page below the bottom edge.
 *
 * Going back used to mount it at the moment the turn began, so what came up from underneath
 * was an empty card that filled in as it arrived. It is rendered and laid out the whole time
 * now; the window clips it, which costs nothing and means the way back looks like the way
 * forward.
 */
const previous = computed(() => (props.cards.length > 1
  ? props.cards[(props.index - 1 + props.cards.length) % props.cards.length]
  : null));

/* ── The drag ─────────────────────────────────────────────────────────────── */
/*
 * Vertical, like the thing it is named after: a rolodex turns around a horizontal axis, so the
 * card lifts away upward and the next one comes up from underneath. The card tilts as it goes
 * (rotateX, against the deck's perspective) rather than sliding flat, which is what makes the
 * stack read as a stack of cards rather than a carousel of panels.
 */
const dragY = ref(0);
const dragging = ref(false);
let startY = 0;
let pointer = 0;
let pressed = false;

/** How far the hand has to move before this is a drag rather than a click. */
const SLOP = 6;

/** Past this and letting go turns the card; short of it the card springs back. */
const threshold = () => Math.min(170, Math.max(80, window.innerHeight * 0.12));

function onDown(event: PointerEvent) {
  // Only a drag that starts on the card's own surface, not on a button inside it.
  if ((event.target as HTMLElement).closest('button, a, input, textarea')) {
    return;
  }
  pressed = true;
  startY = event.clientY;
  pointer = event.pointerId;
}

/**
 * A press is not a drag until it has gone somewhere.
 *
 * The capture used to be taken on pointerdown, which is tidy and wrong: a captured pointer
 * sends its click to the element that captured it, so every click inside a card - a line of a
 * diff, a file in the tree, anything that is not a real button - was being delivered to the
 * deck and quietly swallowed. Nothing is captured until the hand has moved past the slop, and
 * by then it really is a drag.
 */
function onMove(event: PointerEvent) {
  if (!pressed) {
    return;
  }
  const moved = event.clientY - startY;

  if (!dragging.value) {
    if (Math.abs(moved) < SLOP) {
      return;
    }
    dragging.value = true;
    (event.currentTarget as HTMLElement).setPointerCapture(pointer);
  }
  dragY.value = moved;
}

function onUp() {
  pressed = false;
  if (!dragging.value) {
    return;
  }
  const moved = dragY.value;
  const turned = Math.abs(moved) > threshold();
  const pull = progress.value;


  dragging.value = false;
  if (turned) {
    // Both halves of the turn start from where the hand left them: this card from under the
    // finger, and the one arriving from however far the drag had already brought it forward.
    carry(
      moved > 0
        ? `translate3d(0, ${ moved }px, 0) rotateX(${ (moved * 0.02).toFixed(2) }deg)`
        : stackAt(pull),
      moved > 0 ? stackAt(1 - pull) : floorLifted(Math.min(-moved, REACH)),
      // Whichever card is dimming: the one being uncovered going forward, the one stepping
      // back going back.
      `brightness(${ (1 - STEP_DIM * (moved > 0 ? 1 - pull : pull)).toFixed(3) })`,
    );
  }
  dragY.value = 0;
  if (turned) {
    // The rest of the deck is stacked above this card, so pulling this one down takes the next
    // one out of the stack; pushing it up puts it back and returns the one before.
    emit('go', moved > 0 ? 1 : -1);
  }
}

/**
 * The card below, brought up with an upward drag.
 *
 * Without this it sat on the floor until the gesture finished and then jumped up to meet the
 * hand. Dragging back now lifts it, so letting go only finishes a movement that is already
 * most of the way there.
 */
const prevStyle = computed(() => {
  const lifted = dragY.value < 0 ? Math.min(-dragY.value, REACH) : 0;

  return lifted
    ? { transform: floorLifted(lifted), transition: dragging.value ? 'none' : undefined }
    : {};
});

/** How far through a turn the drag is, for the cards behind to come forward as it goes. */
const progress = computed(() => Math.min(1, Math.abs(dragY.value) / threshold()));

/*
 * Signed, and read by `bandStyle`, which is declared before the drag it depends on.
 *
 * Pulling down takes the stack a step towards you; pushing up takes it a step away, because the
 * card you are holding is about to join it. Either way the whole deck moves with the hand.
 */
function progressValue() {
  return dragY.value > 0 ? progress.value : -progress.value;
}

/*
 * Forward, this card is leaving, so it goes with the finger and keeps going.
 *
 * Back, it is not leaving at all - it steps back into the stack while the card below is laid
 * over it - so it moves the fifteen pixels it has to move and no further. It used to follow the
 * finger the whole way up and then come back down to the stack when let go, which is the one
 * place in the deck where the card went one way and then the other, and no easing hides that.
 * Damped like this, letting go finishes the movement that was already happening: the same turn
 * a wheel or a key starts, picked up part-way through.
 */
const topStyle = computed(() => {
  const y = dragY.value;

  if (!dragging.value && !y) {
    return {};
  }
  const held = dragging.value ? 'none' : undefined;

  if (y < 0) {
    const p = progress.value;

    return { transform: stackAt(p), filter: `brightness(${ (1 - STEP_DIM * p).toFixed(3) })`, transition: held };
  }

  return {
    transform: `translate3d(0, ${ y }px, 0) rotateX(${ (y * 0.02).toFixed(2) }deg)`,
    transition: held,
  };
});

/* ── The wheel ────────────────────────────────────────────────────────────── */
/*
 * A wheel over the deck turns it, and a wheel over a card's own scrolling body scrolls that
 * body until it has no more to give - which is the behaviour every long page has taught
 * people, and the only way a card with a list in it can have both.
 *
 * Accumulated and locked: one notch of a mouse wheel is 100-ish pixels and one swipe of a
 * trackpad is forty events, so without a floor and a lockout a trackpad would riffle the whole
 * deck in a second.
 */
let wheelLock = 0;
let wheelSum = 0;

/**
 * Anything under the pointer that can still scroll the way the wheel is going.
 *
 * It used to ask only about `.card__body`, which was true while a card was prose and a few
 * pills. A card with a list of review comments in it has scrollers inside scrollers, and a
 * wheel over one of those has to scroll it - turning the deck instead loses the place in a list
 * somebody was reading.
 */
function scrollingUnder(target: HTMLElement | null, down: boolean): boolean {
  let el: HTMLElement | null = target;

  while (el && el !== deck.value) {
    const room = el.scrollHeight - el.clientHeight > 1;
    const more = down ? el.scrollTop + el.clientHeight < el.scrollHeight - 1 : el.scrollTop > 0;

    if (room && more) {
      const how = getComputedStyle(el).overflowY;

      if (how === 'auto' || how === 'scroll') {
        return true;
      }
    }
    el = el.parentElement;
  }

  return false;
}

function onWheel(event: WheelEvent) {
  if (overlayOpen.value) {
    return;
  }
  if (scrollingUnder(event.target as HTMLElement, event.deltaY > 0)) {
    return;
  }
  event.preventDefault();
  const now = Date.now();

  if (now < wheelLock) {
    return;
  }
  wheelSum += event.deltaY;
  if (Math.abs(wheelSum) < 42) {
    return;
  }
  go(wheelSum > 0 ? 1 : -1);
  wheelSum = 0;
  wheelLock = now + 340;
}

/* ── The keyboard ─────────────────────────────────────────────────────────── */
function onKey(event: KeyboardEvent) {
  const typing = (event.target as HTMLElement)?.closest?.('input, textarea, [contenteditable]');

  // Something open over the deck owns the arrows while it is open.
  if (typing || overlayOpen.value) {
    return;
  }
  if (event.key === 'ArrowDown' || event.key === 'ArrowRight' || event.key === 'j' || event.key === ' ') {
    event.preventDefault();
    go(1);
  }
  if (event.key === 'ArrowUp' || event.key === 'ArrowLeft' || event.key === 'k') {
    event.preventDefault();
    go(-1);
  }
}

onMounted(() => window.addEventListener('keydown', onKey));
onBeforeUnmount(() => window.removeEventListener('keydown', onKey));
</script>

<template>
  <section ref="deck" class="deck" aria-label="Tasks needing your attention" @wheel="onWheel">
    <!-- The two behind, drawn first so the top card sits over them without a z-index fight. -->
    <div
      v-for="(task, depth) in behind"
      :key="task.id"
      class="deck__behind"
      :class="{ 'deck__behind--dragging': dragging }"
      :style="bandStyle(depth + 1)"
      aria-hidden="true"
    >
      <FocusCard :task="task" />
    </div>

    <!--
      No `mode`: both cards are on screen at once, which is the whole effect. Going forward the
      top one falls off the bottom of the screen and uncovers the one that was behind it; going
      back that card comes up off the floor and is laid on top of this one.
    -->
    <!-- Off the bottom edge, drawn and ready: the card the deck goes back to. -->
    <!--
      Keyed: when the deck turns, this becomes a different card, and a fresh element starts on
      the floor rather than sliding down to it from wherever the last drag had lifted it.
    -->
    <div v-if="previous" :key="previous.id" class="deck__prev" :style="prevStyle" aria-hidden="true">
      <FocusCard :task="previous" />
    </div>

    <Transition
      :name="quiet ? 'turn-none' : (direction === 1 ? 'turn-fwd' : 'turn-back')"
      @before-leave="onBeforeLeave"
      @after-leave="clearCarry"
      @after-enter="clearCarry"
    >
      <div
        v-if="current"
        :key="current.id"
        class="deck__top"
        :class="{ 'deck__top--dragging': dragging, 'deck__top--landing': landing }"
        :style="topStyle"
        @pointerdown="onDown"
        @pointermove="onMove"
        @pointerup="onUp"
        @pointercancel="onUp"
      >
        <FocusCard
          :task="current"
          interactive
          :busy="busy"
          :pinned="current.pinned"
          :notes="(notes as any)"
          :artifacts="(artifacts as any)"
          @act="(action) => emit('act', { task: current!, action })"
          @ask="emit('ask', current!)"
          @pin="emit('pin', current!)"
          @resolve="emit('resolve', $event)"
          @discuss="emit('discuss', $event)"
          @ask-code="emit('ask-code', $event)"
          @reply="emit('reply', $event)"
        />
      </div>

      <div v-else class="deck__empty">
        <span class="deck__empty-mark"><AppIcon name="check" :size="28" /></span>
        <h2>Nothing is waiting on you</h2>
        <p>Eight things came in today and all of them are dealt with. The next one will land here.</p>
      </div>
    </Transition>

    <!--
      The rail: where you are in the deck, and what is coming, in the colours of the kinds.

      The hue comes off `task.card.kind` and not `task.kind`: a FocusTask is a queue item with a
      card attached, and the kind belongs to the card. `task.kind` is undefined, which is not an
      error anywhere - the class is just `deck__dot--undefined`, `--dot` goes unset, and every
      dot quietly falls back to grey.
    -->
    <nav v-if="cards.length" class="deck__rail" aria-label="Deck position">
      <button
        class="deck__step"
        type="button"
        title="Previous card (←)"
        aria-label="Previous card"
        @click="go(-1)"
      ><AppIcon name="chevron-up" :size="16" /></button>

      <ol class="deck__dots">
        <li v-for="(task, n) in cards" :key="task.id">
          <button
            type="button"
            class="deck__dot"
            :class="[`deck__dot--${ task.card.kind }`, { 'deck__dot--on': n === index }]"
            :title="task.title"
            :aria-label="`Card ${ n + 1 }: ${ task.title }`"
            :aria-current="n === index"
            @click="emit('jump', n)"
          />
        </li>
      </ol>

      <button
        class="deck__step"
        type="button"
        title="Next card (→)"
        aria-label="Next card"
        @click="go(1)"
      ><AppIcon name="chevron-down" :size="16" /></button>
    </nav>
  </section>
</template>

<style scoped>
.deck {
  position: relative;
  display: grid;
  /*
   * `minmax(0, …)`, not `auto`: a grid track sized to its content takes the widest thing
   * inside it, and the card's actions are a row that does not wrap on a phone - so the track,
   * the card and then the page all grew wider than the screen, and the whole thing scrolled
   * sideways. The track is told it may be narrower than its content; the row keeps its own
   * scroller.
   */
  grid-template-columns: minmax(0, 1fr);
  /*
   * Stretched down the block axis, centred across it. A card sized with `height: 100%` was
   * resolving against the row rather than against the room left inside this padding, so it
   * ran past the bottom and under the chat bar; stretching hands it exactly the space there
   * is.
   */
  place-items: stretch center;
  height: 100%;
  /*
   * The card takes the room. What is left is only what something else needs: a lane on the
   * right for the rail, a line at the bottom for what is coming next, and a hair at the top so
   * the card does not touch the header.
   */
  padding: 34px 62px var(--s3) clamp(var(--s3), 2vw, var(--s6));
  /* The axis the deck turns around is horizontal and in front of the screen. */
  perspective: 2200px;
  perspective-origin: 50% 45%;

  /*
   * The two places a card is, other than here.
   *
   * In the stack: a step up, a hair smaller, a shade darker. On the floor: off the bottom of
   * the screen entirely, which is why the travel is the card's own height plus a piece of the
   * viewport rather than a percentage that leaves a corner showing on a short window.
   *
   * Every transition below is written against these, so the place a card leaves for is exactly
   * the place the card that replaces it is drawn - nothing is ever in two positions for a
   * frame.
   */
  --stack-y: -15px;
  --stack-scale: 0.984;
  --stack-dim: 0.86;
  --floor-y: calc(100% + 24vh);
  --floor-scale: 0.94;
  --floor-tilt: 9deg;

  /*
   * Falling is quicker than being placed, and accelerates; arriving decelerates and settles.
   * Neither overshoots: a card that bounces reads as a widget, and this one is meant to read as
   * a piece of card with somewhere to be.
   */
  --turn-fall: 430ms;
  --turn-reveal: 400ms;
  --turn-place: 440ms;
  --turn-settle: 380ms;
  --ease-fall: cubic-bezier(0.42, 0, 0.72, 0.36);
  --ease-reveal: cubic-bezier(0.22, 0.74, 0.3, 1);
  --ease-place: cubic-bezier(0.16, 0.84, 0.28, 1);
}

.deck__top,
.deck__behind,
.deck__prev {
  grid-area: 1 / 1;
  /* Nearly the page, as asked: the card is the page, and the deck's padding is the frame. */
  width: min(1680px, 100%);
  min-width: 0;
  max-width: 100%;
  min-height: 0;
  /*
   * Every card in the deck is measured from its top edge - the edge the stack is made of - so
   * a scaled card in the stack and a card scaled by a transition land on the same pixel.
   */
  transform-origin: 50% 0;
  backface-visibility: hidden;
  /* The deck owns the vertical gesture now, so the browser keeps the horizontal one. */
  touch-action: pan-x;
}

.deck__top {
  /* Above the stack, and opaque: the bands are only ever an edge above this card's own edge. */
  z-index: 10;
  cursor: grab;
  will-change: transform;
  transform-style: preserve-3d;
  transition: transform var(--base) var(--ease-spring), filter var(--base) var(--ease-spring);
}
.deck__top--dragging { cursor: grabbing; }

/*
 * The rest of the deck, stacked above the card you are reading.
 *
 * Each one is set back and lifted by its depth, so what shows of it is a band along the top -
 * and that band is its own colour, which is the point: the stack says what is coming without
 * anything having to be read. They are pulled down as a drag gets closer to turning, so the
 * deck answers the gesture before it commits to it.
 */
/*
 * Position, depth and dimming all come from `bandStyle` in script. What is left here is how
 * they move: with the card that is being revealed, and at once with the drag that is pulling
 * them.
 *
 * Opaque, always. Fading these made the ground and the card below show through the band, which
 * reads as a smear rather than as another card - so depth is carried by the scale and by each
 * one being a step darker than the one in front of it, and never by transparency.
 */
.deck__behind {
  transition: transform var(--turn-reveal) var(--ease-reveal), filter var(--turn-reveal) var(--ease-reveal);
  pointer-events: none;
}

/* A drag is the hand's, not the deck's: the stack follows the finger frame for frame. */
.deck__behind--dragging { transition: none; }

/*
 * Only the top edge of these is ever seen, so from here a card wears its band - the layer the
 * card itself carries, which a turn can fade off as it comes forward.
 */
.deck__behind :deep(.card__band) { opacity: 1; }
.deck__behind :deep(.card) { box-shadow: var(--shadow-2); }

/*
 * The cards in the stack are drawn in full, contents and all.
 *
 * They used to be blanked - only the coloured band shows, so why lay out a card nobody can
 * see - but that is exactly what made the turn feel like a pop: the band slid down into place
 * as an empty card and its contents appeared at the end of the journey. The card that arrives
 * is now the card that was already there, finished, the whole way.
 *
 * Nothing of it is visible above the card in front anyway: the band is fifteen pixels and a
 * card's own padding is three times that.
 */

/*
 * The card the deck came from, parked where a card leaves to. Same transform as
 * `.turn-fwd-leave-to`, on purpose: going back, this is what comes up, and it should come up
 * from where the last one went down.
 */
.deck__prev {
  z-index: 0;
  transform: translate3d(0, var(--floor-y), 0) scale(var(--floor-scale)) rotateX(var(--floor-tilt));
  transition: transform var(--turn-settle) var(--ease-reveal);
  pointer-events: none;
}

/*
 * ── The turn ──────────────────────────────────────────────────────────────
 *
 * Two readings, one for each direction, and the difference between them is mostly which card
 * is in front.
 *
 * Forward, the card you have finished with falls: it stays on top, accelerates off the bottom
 * of the screen, and uncovers the card that was behind it. That card barely moves - a step down
 * out of the stack, brightening as it comes - because it is being revealed, not thrown in. A
 * card that flew in from somewhere would be a second event competing with the first.
 *
 * Back, the reading is a hand putting a card down: the one that left comes up off the floor and
 * is laid over the top of the deck, which settles a step back under it without going anywhere.
 *
 * Both ends are seams rather than fades. A card leaves for exactly where the element that
 * replaces it is already drawn - the floor for `.deck__prev`, the first step of the stack for
 * `.deck__behind` - so when Vue takes the leaving element away, nothing on the screen changes.
 */

/* Forward: this one falls, in front, all the way off. */
.turn-fwd-leave-active {
  z-index: 30;
  transition: transform var(--turn-fall) var(--ease-fall);
}
.turn-fwd-leave-from,
.turn-back-leave-from { transform: var(--carry-out, none); }

/* `--carry-dim` belongs to whichever card is between brightnesses; only one ever is. */
.turn-back-leave-from { filter: var(--carry-dim, none); }

.turn-fwd-leave-to {
  transform: translate3d(0, var(--floor-y), 0) scale(var(--floor-scale)) rotateX(var(--floor-tilt));
}

/* Forward: this one is uncovered where it already was, and stops being a band as it comes. */
.turn-fwd-enter-active {
  transition: transform var(--turn-reveal) var(--ease-reveal), filter var(--turn-reveal) var(--ease-reveal);
}
.turn-fwd-enter-from {
  transform: var(--carry-in, translate3d(0, var(--stack-y), 0) scale(var(--stack-scale)));
  filter: var(--carry-dim, brightness(var(--stack-dim)));
}
.turn-fwd-enter-active :deep(.card__band) { transition: opacity calc(var(--turn-reveal) * 0.6) linear; }
.turn-fwd-enter-from :deep(.card__band) { opacity: 1; }

/* Back: this one is picked up off the floor and laid on top. */
.turn-back-enter-active {
  z-index: 30;
  transition: transform var(--turn-place) var(--ease-place);
}
.turn-back-enter-from {
  transform: var(--carry-in, translate3d(0, var(--floor-y), 0) scale(var(--floor-scale)) rotateX(var(--floor-tilt)));
}

/*
 * Back: this one settles into the stack under it, taking on the band as it goes and arriving
 * as the thing that is already drawn there. The last of the opacity is the only fade in the
 * whole turn, and it is a card dissolving into its own copy, a step from the top of the
 * screen, under the card that has just been put down.
 */
.turn-back-leave-active {
  transition:
    transform var(--turn-settle) var(--ease-reveal),
    filter var(--turn-settle) var(--ease-reveal),
    opacity calc(var(--turn-settle) * 0.3) linear calc(var(--turn-settle) * 0.7);
}
.turn-back-leave-to {
  transform: translate3d(0, var(--stack-y), 0) scale(var(--stack-scale));
  filter: brightness(var(--stack-dim));
  opacity: 0;
}
.turn-back-leave-active :deep(.card__band) { transition: opacity calc(var(--turn-settle) * 0.6) linear; }
.turn-back-leave-to :deep(.card__band) { opacity: 1; }

/* ── Nothing left ─────────────────────────────────────────────────────────── */
.deck__empty {
  grid-area: 1 / 1;
  display: grid;
  justify-items: center;
  gap: var(--s3);
  max-width: 44ch;
  text-align: center;
  color: var(--text-dim);
}

.deck__empty-mark {
  display: grid;
  place-items: center;
  width: 64px;
  height: 64px;
  margin-bottom: var(--s2);
  border-radius: var(--r-pill);
  background: var(--success-wash);
  color: var(--success);
}

.deck__empty h2 { font-size: var(--t-xl); color: var(--text); }

/* ── The rail ─────────────────────────────────────────────────────────────── */
.deck__rail {
  position: absolute;
  top: 50%;
  right: clamp(6px, 1.6vw, 22px);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--s2);
  transform: translateY(-50%);
}

.deck__step {
  display: grid;
  place-items: center;
  width: 30px;
  height: 30px;
  border: 1px solid var(--border);
  border-radius: var(--r-pill);
  background: var(--surface);
  color: var(--text-muted);
  cursor: pointer;
  transition: color var(--fast), border-color var(--fast), transform var(--fast) var(--ease-spring);
}

.deck__step:hover { color: var(--text); border-color: var(--border-strong); transform: scale(1.06); }

/*
 * Not drawn, but still laid out: the card flying in needs to know where it is going, and
 * `visibility` keeps the box measurable where `display: none` would not. See CardFlight.
 */
.deck__top--landing { visibility: hidden; }

.deck__dots { display: flex; flex-direction: column; gap: 6px; margin: var(--s2) 0; padding: 0; list-style: none; }

.deck__dot {
  width: 9px;
  height: 9px;
  padding: 0;
  border: 0;
  border-radius: var(--r-pill);
  background: var(--dot, var(--text-faint));
  opacity: 0.45;
  cursor: pointer;
  transition: opacity var(--fast), height var(--base) var(--ease-spring), transform var(--fast);
}

.deck__dot:hover { opacity: 0.85; transform: scale(1.25); }
.deck__dot--on { height: 22px; opacity: 1; }

.deck__dot--review   { --dot: var(--kind-review); }
.deck__dot--issue    { --dot: var(--kind-issue); }
.deck__dot--agent    { --dot: var(--kind-agent); }
.deck__dot--question { --dot: var(--kind-question); }
.deck__dot--signal   { --dot: var(--kind-signal); }

@media (max-width: 860px) {
  .deck { padding: 30px var(--s3) var(--s5); }
  .deck__top,
  .deck__behind { min-height: 0; }
  .deck__rail {
    top: auto;
    right: auto;
    bottom: 0;
    left: 50%;
    flex-direction: row;
    transform: translateX(-50%);
  }
  .deck__dots { flex-direction: row; margin: 0 var(--s2); }
  .deck__dot--on { height: 9px; width: 22px; }
}
</style>
