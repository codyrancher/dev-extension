<script setup lang="ts">
/**
 * The things you would have gone and looked up, as one line of facts under the card's lede.
 *
 * How big the change is, what CI says about it, who said yes, what is running on a link, what the
 * agent recorded, how long it has sat, and the description if there is one to read. None of them
 * is the point of a card - the change itself or the agent's review is - so all of them are one
 * 26px line above it, in the order you would ask.
 *
 * **It was a toolbar, and it was a sideways scroller.** Every one of those facts was a bordered
 * box: three `StatPill`s at an 8px radius beside four `.u-pill` capsules at 999px on the same
 * 26px row, in a strip with `overflow: auto` and a 24px fade. What that cost, all measured on the
 * live deck:
 *
 *   - `.card__strip` scrollWidth/clientWidth 593/472, 601/543, 740/524, 596/563 - overflowing on
 *     4 of the 11 cards walked, with a hidden scrollbar and a fade as the only sign of it.
 *   - on the red-pr card, `.ck` - the one control that card exists for, the list of failures -
 *     measured x812 to r1025 against a window of 1024: off the screen.
 *   - on the review-asked card the strip arrived already scrolled (`scrollLeft` 216 with no
 *     interaction), because `.u-fade-x > * { scroll-snap-align: start }` landed on this
 *     component's own `display: contents` root, which measures 0px wide - so the zero-box wrapper
 *     was the snap target and the real pills inside it were not. The first thing on the fact line
 *     was 60px of a pill reading "OVED", with `+13281 added` and `-507 removed` off the card to
 *     the left.
 *   - and when everything on a row has a border, nothing on it reads as a control.
 *
 * So: the numbers are text, coloured, with `·` between them, on one line that ellipsises and
 * never scrolls. A border is kept for the two or three things that are actually pressable, and
 * anything past that collapses into one `+n` chip that opens a `.u-popover` - the pattern
 * CardChecks already uses. `StatPill` is gone; it was the only box on the row that did not know
 * it was on a row.
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import AppIcon from './AppIcon.vue';
import MediaViewer from './MediaViewer.vue';
import CardChecks from './CardChecks.vue';
import { under } from './popover';
import type { CardArtifacts } from '../../focus-artifacts';

const props = defineProps<{
  artifacts: CardArtifacts;
  /**
   * The fact the card's 36px lede has already said, which this row may not say again.
   *
   * `13 files changed` at 36px with `13 FILES` 50px beside it, on 9 of the deck's 26 cards; the
   * same with `157`. The deltas stay - they are the pair nobody reads off the lede - and the
   * count goes, because one of them earns its place and not both. See `claimed` in FocusCard.
   */
  claimed?: string;
  /** How long it has sat, in the card's own words, or '' where the lede already said it. */
  waited?: string;
  /**
   * What the description would be called, where there is one to read and a surface it would eat.
   *
   * The control for it belongs on this line with the other things you go and look at, rather than
   * in a second row of the card's own - which is what made the band wrap to 71px and 105px.
   */
  prose?: string;
  /**
   * How many comments there are, where the card's subject is not the comments.
   *
   * The start-fix card withheld the only evidence its issue had: the screenshot is in a comment,
   * the head printed "2 comments" and nothing opened them. This is the control that does, the way
   * the recordings pill opens the recordings.
   */
  talk?: number;
}>();

const emit = defineEmits<{ (e: 'read'): void; (e: 'talk'): void }>();

/*
 * Teleported rather than opened in place: this card is inside a transformed, clipped element,
 * and a `position: fixed` child of a transform is fixed to the transform rather than to the
 * window. The deck transforms every card it holds.
 */
/*
 * Open with no `start`, which is how the viewer is asked for the tiled view of the set rather
 * than the first artifact with arrows under it. This pill says `4 recordings`, so the thing it
 * was pressed to answer is "which four" - it used to open the first one and make you click
 * through the rest to find out. See MediaViewer.
 */
const shots = ref(false);

/** The overflow, when there are more things to go and look at than fit on a 26px line. */
const moreOpen = ref(false);
const root = ref<HTMLElement | null>(null);

function away(event: MouseEvent) {
  const inMenu = (event.target as HTMLElement)?.closest?.('.ev__menu');

  if (moreOpen.value && root.value && !root.value.contains(event.target as Node) && !inMenu) {
    moreOpen.value = false;
  }
}

onMounted(() => window.addEventListener('click', away, true));
onBeforeUnmount(() => window.removeEventListener('click', away, true));

/**
 * Who has already said yes.
 *
 * A fact about the work rather than a surface for it: the card that offers to merge your own
 * pull request justified the merge with the line 'approved and still open' and never named the
 * person. `reviewersOf` reads it off the same `prDetail` response the stat and the checks come
 * from, so it is free - and it belongs here, beside them, for the same reason they do.
 */
const approved = computed(() => props.artifacts.reviewers?.approved || []);

/** One tone per kind of number, so the colour does the work the borders were doing badly. */
type Tone = '' | 'good' | 'bad' | 'warn';
interface Fact { n: string; of: string; tone: Tone }

/**
 * The facts, as a sentence.
 *
 * Deliberately in the order somebody asks them - how big, did it build, who looked at it, how
 * long has it been there - rather than in the order the artifacts happen to arrive.
 */
const facts = computed<Fact[]>(() => {
  const a = props.artifacts;
  const out: Fact[] = [];

  if (a.stat) {
    if (props.claimed !== 'files') {
      out.push({ n: String(a.stat.files), of: a.stat.files === 1 ? 'file' : 'files', tone: '' });
    }
    out.push({ n: `+${ a.stat.added }`, of: '', tone: 'good' });
    out.push({ n: `−${ a.stat.removed }`, of: '', tone: 'bad' });
  }
  if (a.ci?.pending) {
    out.push({ n: String(a.ci.pending), of: 'still running', tone: 'warn' });
  }
  if (a.ci?.passed) {
    out.push({ n: String(a.ci.passed), of: 'passed', tone: 'good' });
  }
  for (const who of approved.value) {
    out.push({ n: who, of: 'approved', tone: 'good' });
  }
  if (props.waited) {
    out.push({ n: props.waited, of: 'waiting', tone: '' });
  }

  return out;
});

/**
 * Something you go and look at: a link, a recording, the description.
 *
 * The failing checks are not in here - they are CardChecks, which carries its own popover and is
 * the subject of the card whose build is red, so it is never the thing that collapses.
 */
interface Go {
  key: string;
  label: string;
  icon: 'expand' | 'play' | 'pencil' | 'send';
  url: string;
  /** For a live build: which of the four states its dot is in. */
  state: string;
  title: string;
}

const goes = computed<Go[]>(() => {
  const a = props.artifacts;
  const out: Go[] = a.live.map((live) => ({
    key:   `live-${ live.kind }`,
    label: live.state === 'serving' ? live.label : `${ live.label } ${ live.state }`,
    icon:  'expand' as const,
    url:   live.url || '',
    state: live.state,
    title: live.detail || live.label,
  }));

  if (a.media.length) {
    out.push({
      key:   'shots',
      label: `${ a.media.length } ${ a.media.length === 1 ? 'recording' : 'recordings' }`,
      icon:  'play',
      url:   '',
      state: '',
      title: `Watch what it recorded: ${ a.media.map((item) => item.label).join(', ') }`,
    });
  }
  if (props.talk) {
    const label = `${ props.talk } ${ props.talk === 1 ? 'comment' : 'comments' }`;

    out.push({
      key: 'talk', label, icon: 'send', url: '', state: '', title: `Read what was said: ${ label }`,
    });
  }
  if (props.prose) {
    out.push({
      key: 'prose', label: `Read ${ props.prose.toLowerCase() }`, icon: 'pencil', url: '', state: '', title: `Read ${ props.prose.toLowerCase() }`,
    });
  }

  return out;
});

/**
 * How many of them get a chip of their own.
 *
 * Three controls on a 26px line is about 390px of the ~480px this row has beside a 36px lede, and
 * the failing-checks badge is one of them where it exists. Past that the line could only grow or
 * scroll, and both of those are what this row was being fixed for.
 */
const room = computed(() => (props.artifacts.ci?.failing ? 2 : 3));
const shown = computed(() => goes.value.slice(0, room.value));
const over = computed(() => goes.value.slice(shown.value.length));

function pressed(go: Go) {
  moreOpen.value = false;
  if (go.key === 'shots') {
    shots.value = true;
  } else if (go.key === 'prose') {
    emit('read');
  } else if (go.key === 'talk') {
    emit('talk');
  }
}

const has = computed(() => Boolean(facts.value.length || props.artifacts.ci?.failing || goes.value.length));

/** Measured from the chip that opens it; see `under` for why it cannot just be absolute. */
const moreAt = ref<Record<string, string>>({});

function openMore() {
  moreOpen.value = !moreOpen.value;
  if (moreOpen.value) {
    moreAt.value = under(more.value, 280);
  }
}

const more = ref<HTMLElement | null>(null);
</script>

<template>
  <div v-if="has" ref="root" class="ev">
    <!-- The numbers, as one line of text that loses its tail rather than scrolling. -->
    <p v-if="facts.length" class="ev__line">
      <template v-for="(fact, n) in facts" :key="`${ fact.n }-${ fact.of }`">
        <span v-if="n" class="ev__sep">·</span><span class="ev__fact" :class="`ev__fact--${ fact.tone || 'plain' }`"><span class="ev__n">{{ fact.n }}</span><span v-if="fact.of" class="ev__of">{{ fact.of }}</span></span>
      </template>
    </p>

    <!-- The failures, which are the one thing on this row that is a card's whole subject. -->
    <CardChecks v-if="artifacts.ci?.failing" :ci="artifacts.ci" :checks="artifacts.checks" :claimed="claimed" />

    <!-- Everything you go and look at, bordered because it is pressed. -->
    <component
      :is="go.url ? 'a' : 'button'"
      v-for="go in shown"
      :key="go.key"
      class="u-pill ev__go"
      :class="[`ev__go--${ go.key.split('-')[0] }`, go.state ? `ev__go--${ go.state }` : '']"
      :type="go.url ? undefined : 'button'"
      :href="go.url || undefined"
      :target="go.url ? '_blank' : undefined"
      :rel="go.url ? 'noopener' : undefined"
      :title="go.title"
      @click="go.url ? undefined : pressed(go)"
    >
      <span v-if="go.state" class="ev__dot" />
      <AppIcon v-else :name="go.icon" :size="11" />
      {{ go.label }}
    </component>

    <!-- And the rest behind one chip, rather than off the edge of the card. -->
    <template v-if="over.length">
      <button
        ref="more"
        type="button"
        class="u-pill ev__go"
        :title="over.map((go) => go.label).join(', ')"
        :aria-expanded="moreOpen ? 'true' : 'false'"
        @click="openMore"
      >
        +{{ over.length }}
        <AppIcon :name="moreOpen ? 'chevron-up' : 'chevron-down'" :size="11" />
      </button>

      <!-- Teleported for the reason CardChecks' list is: four boxes between here and the page
           clip, and the deck transforms the card. See `under`. -->
      <Teleport to="body">
        <div class="dev-focus">
          <div v-if="moreOpen" class="u-popover ev__menu" :style="moreAt">
            <component
              :is="go.url ? 'a' : 'button'"
              v-for="go in over"
              :key="go.key"
              class="ev__row"
              :type="go.url ? undefined : 'button'"
              :href="go.url || undefined"
              :target="go.url ? '_blank' : undefined"
              :rel="go.url ? 'noopener' : undefined"
              :title="go.title"
              @click="go.url ? (moreOpen = false) : pressed(go)"
            >
              <AppIcon :name="go.icon" :size="12" />
              {{ go.label }}
            </component>
          </div>
        </div>
      </Teleport>
    </template>

    <Teleport to="body">
      <div class="dev-focus">
        <MediaViewer
          v-if="shots"
          :items="artifacts.media"
          @close="shots = false"
        />
      </div>
    </Teleport>
  </div>
</template>


<style scoped>
/*
 * One line of facts, one height, never squeezed and never scrolled.
 *
 * It was `display: contents` so that the card's own two pills could join the row - which is also
 * what made it a 0px-wide snap target that arrived pre-scrolled. The card hands those two in as
 * props now (`waited`, `prose`), so this is the row itself and there is one owner of it.
 */
.ev {
  position: relative;
  display: flex;
  align-items: center;
  flex: 1 1 auto;
  flex-wrap: nowrap;
  gap: var(--s2);
  min-width: 0;
  height: var(--pill-h);
  /* No scroller. What does not fit is a `+n` chip or an ellipsis, both of which say so. */
  overflow: hidden;
}

/* ── The numbers, as a sentence ──────────────────────────────────────────────────────────── */
/*
 * The one thing on this row allowed to lose its tail, because it is the only thing on it that is
 * prose. The controls beside it are pinned: an ellipsised control is a control you cannot read.
 */
.ev__line {
  flex: 1 1 auto;
  min-width: 0;
  color: var(--text-muted);
  font-size: var(--t-sm);
  line-height: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ev__sep { margin: 0 6px; color: var(--text-faint); }
.ev__n { font-weight: 650; font-variant-numeric: tabular-nums; }
.ev__fact--plain .ev__n { color: var(--text); }
.ev__fact--good .ev__n { color: var(--success); }
.ev__fact--bad .ev__n { color: var(--danger); }
.ev__fact--warn .ev__n { color: var(--warning); }
/*
 * The gap after the number, as a margin.
 *
 * It was a literal space in the template - `<span class="ev__of"> {{ fact.of }}</span>` - and the
 * compiler condensed it away, so the line read "157files·+13281·−507". Whitespace that has to
 * survive a template compiler is not whitespace, it is spacing.
 */
.ev__of { margin-left: var(--s1); color: var(--text-muted); }

/* ── The things you go and look at ───────────────────────────────────────────────────────── */
/*
 * `.u-pill` carries the box. What is left here is the hue and the fact that it is pressed: on a
 * row where only the controls have a border, a border is what says "this does something".
 */
.ev__go {
  flex: 0 0 auto;
  border: 1px solid color-mix(in srgb, var(--kind) 34%, var(--border));
  background: transparent;
  color: var(--kind);
  cursor: pointer;
  text-decoration: none;
  transition: background var(--fast), color var(--fast);
}

.ev__go:hover { background: color-mix(in srgb, var(--kind) 12%, transparent); color: var(--text); }

/* What is up on a link says so with a dot, as it always did. */
.ev__dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--text-faint);
}

.ev__go--serving .ev__dot { background: var(--success); }
/* `--warning` is declared in focus.css; the fallback was a second, slightly different yellow
   waiting to be used the day somebody renamed the token. */
.ev__go--building .ev__dot { background: var(--warning); animation: live-pulse 1.4s ease-in-out infinite; }
.ev__go--failed .ev__dot { background: var(--danger); }

@keyframes live-pulse { 50% { opacity: 0.35; } }

/* The overflow, which is what keeps this a line. `.u-popover` is the surface; `under` places it. */
.ev__menu {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.ev__row {
  display: flex;
  align-items: center;
  gap: var(--s2);
  min-height: var(--control-h);
  padding: 0 var(--s3);
  border: 0;
  border-radius: var(--r-sm);
  background: none;
  color: var(--text-dim);
  font: inherit;
  font-size: var(--t-sm);
  text-align: left;
  text-decoration: none;
  cursor: pointer;
  white-space: nowrap;
}

.ev__row:hover { background: var(--surface-raised); color: var(--text); }
</style>
