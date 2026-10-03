<script setup lang="ts">
/**
 * The things you would have gone and looked up, on the card.
 *
 * Four of them, each drawn only when the card's work has it: how big the change is, what CI
 * says about it, what is running on a link you can click around in, and what the agent recorded
 * while it was working. None of them is the point of a card - the change itself or the agent's
 * review is - so all four live in one band above it, small, in the order you would ask.
 *
 * CI is one badge per state, not one per check: `4 failing` opens the list. Four e2e suites named
 * in full - `e2e-test (admin, @adminUser, @navigation, @extensions)` - took two rows of the card
 * above the change they were about. See CardChecks.
 *
 * The screenshots are evidence rather than the subject, so they are thumbnails that open: see
 * MediaViewer, which is where a recording is actually watchable.
 */
import { computed, ref } from 'vue';
import AppIcon from './AppIcon.vue';
import StatPill from './StatPill.vue';
import MediaViewer from './MediaViewer.vue';
import CardChecks from './CardChecks.vue';
import type { CardArtifacts } from '../../focus-artifacts';

const props = defineProps<{ artifacts: CardArtifacts }>();

/*
 * Teleported rather than opened in place: this card is inside a transformed, clipped element,
 * and a `position: fixed` child of a transform is fixed to the transform rather than to the
 * window. The deck transforms every card it holds.
 */
const viewerAt = ref<number | null>(null);

/**
 * Who has already said yes.
 *
 * A fact about the work rather than a surface for it: the card that offers to merge your own
 * pull request justified the merge with the line 'approved and still open' and never named the
 * person. `reviewersOf` reads it off the same `prDetail` response the stat and the checks come
 * from, so it is free - and it belongs here, beside them, for the same reason they do.
 */
const approved = computed(() => props.artifacts.reviewers?.approved || []);

const has = computed(() => Boolean(
  props.artifacts.stat
  || props.artifacts.checks.length
  || props.artifacts.live.length
  || props.artifacts.media.length
  || approved.value.length,
));

/** Failures first: the reason to look at CI at all is the thing that is red. */
const checks = computed(() => [...props.artifacts.checks].sort((a, b) => (
  (a.state === 'failed' ? 0 : a.state === 'running' ? 1 : 2) - (b.state === 'failed' ? 0 : b.state === 'running' ? 1 : 2)
)));

</script>

<template>
  <div v-if="has" class="ev">
    <!-- How big it is, and what the robots think of it. -->
    <div v-if="artifacts.stat || checks.length || approved.length" class="ev__row">
      <template v-if="artifacts.stat">
        <StatPill label="files" :value="String(artifacts.stat.files)" />
        <StatPill label="added" :value="`+${ artifacts.stat.added }`" tone="good" />
        <StatPill label="removed" :value="`−${ artifacts.stat.removed }`" tone="bad" />
      </template>

      <CardChecks v-if="checks.length" :checks="checks" />

      <!-- Who said yes. Named, because "approved" with nobody attached to it is not a fact. -->
      <span v-for="who in approved" :key="who" class="u-pill ev__yes">
        <AppIcon name="check" :size="11" />
        {{ who }}
      </span>
    </div>

    <!-- Something running, on a link: the build of this branch you can actually click around in. -->
    <div v-if="artifacts.live.length" class="ev__row">
      <component
        :is="live.url ? 'a' : 'span'"
        v-for="live in artifacts.live"
        :key="live.kind"
        class="u-pill live"
        :class="`live--${ live.state }`"
        :href="live.url || undefined"
        target="_blank"
        rel="noopener"
        :title="live.detail || live.label"
      >
        <span class="live__dot" />
        <span class="live__label">{{ live.label }}</span>
        <span v-if="live.state !== 'serving'" class="live__state">{{ live.state }}</span>
        <AppIcon v-else name="expand" :size="11" />
      </component>
    </div>

    <!-- What it recorded while it worked. Newest first, because that is the run you mean. -->
    <div v-if="artifacts.media.length" class="ev__shots">
      <figure
        v-for="(item, n) in artifacts.media"
        :key="item.src"
        class="shot"
      >
        <button
          type="button"
          class="shot__frame"
          :title="`Open ${ item.label }`"
          @click="viewerAt = n"
        >
          <img
            v-if="item.kind === 'image'"
            class="shot__img"
            :src="item.src"
            :alt="item.label"
            loading="lazy"
          >
          <video
            v-else
            class="shot__img"
            :src="item.src"
            muted
            preload="metadata"
          />
          <span v-if="item.kind === 'video'" class="shot__play"><AppIcon name="play" :size="16" /></span>
          <span class="shot__open"><AppIcon name="expand" :size="12" /></span>
        </button>
        <figcaption class="shot__label">{{ item.label }}</figcaption>
      </figure>
    </div>

    <Teleport to="body">
      <div class="dev-focus">
        <MediaViewer
          v-if="viewerAt !== null"
          :items="artifacts.media"
          :start="viewerAt"
          @close="viewerAt = null"
        />
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.ev { display: flex; flex-direction: column; gap: var(--s2); min-width: 0; }

/*
 * One strip of facts, one height.
 *
 * Every direct child of this row is `--pill-h` now - the stats, the check badges, the live
 * pills - so centring them lines up their boxes and their text together. It was three heights
 * (32, 24, 26) centred on one line, which is three baselines across something that reads as a
 * single sentence of numbers.
 */
.ev__row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--s2);
  min-width: 0;
}

/* ── CI ───────────────────────────────────────────────────────────────────────────────────── */




/* The check's own sentence, which is usually the whole reason it is on the card. */

/* ── What is up on a link ─────────────────────────────────────────────────────────────────── */
/* `.u-pill` carries the box - this was the only one of the three band heights that happened to
   be right, and the only one that said nothing about it. What is left is the hue and the link. */
.live {
  border: 1px solid color-mix(in srgb, var(--kind) 34%, transparent);
  background: color-mix(in srgb, var(--kind) 9%, transparent);
  color: var(--text-dim);
  text-decoration: none;
  transition: background var(--fast), color var(--fast);
}

/* The band's own green: an approval is the one fact on this row that is good news. */
.ev__yes {
  border: 1px solid color-mix(in srgb, var(--success) 38%, transparent);
  background: color-mix(in srgb, var(--success) 10%, transparent);
  color: var(--success);
  font-weight: 600;
}

a.live:hover { background: color-mix(in srgb, var(--kind) 18%, transparent); color: var(--text); }

.live__dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--text-faint);
}

.live--serving .live__dot { background: var(--success); }
/* `--warning` is declared in focus.css; the fallback was a second, slightly different yellow
   waiting to be used the day somebody renamed the token. */
.live--building .live__dot { background: var(--warning); animation: live-pulse 1.4s ease-in-out infinite; }
.live--failed .live__dot { background: var(--danger); }

@keyframes live-pulse { 50% { opacity: 0.35; } }

.live__label { font-weight: 600; }
.live__state { color: var(--text-faint); }

/* ── What it recorded ─────────────────────────────────────────────────────────────────────── */
.ev__shots {
  display: flex;
  gap: var(--s2);
  min-width: 0;
  padding-bottom: 2px;
  overflow-x: auto;
  scrollbar-width: thin;
}

.shot { flex: 0 0 auto; width: 132px; margin: 0; }

.shot__frame {
  position: relative;
  display: block;
  width: 100%;
  height: 74px;
  padding: 0;
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  background: var(--surface-sunk);
  cursor: pointer;
  overflow: hidden;
  transition: border-color var(--fast), transform var(--fast);
}

.shot__frame:hover { border-color: var(--kind); transform: translateY(-1px); }

.shot__img { width: 100%; height: 100%; object-fit: cover; display: block; }

/*
 * The scrim over a thumbnail, in tokens.
 *
 * It was `rgba(8, 10, 16, 0.66)` and `#fff`, which is this view's dark ground and its dark
 * text written out by hand - so in light theme the play scrim and its glyph were the only
 * things on the page that ignored the theme switch, a dark disc with white ink on a white card.
 */
.shot__play,
.shot__open {
  position: absolute;
  display: grid;
  place-items: center;
  border-radius: var(--r-pill);
  background: color-mix(in srgb, var(--ground) 72%, transparent);
  color: var(--text);
}

.shot__play { inset: 50% auto auto 50%; width: 28px; height: 28px; transform: translate(-50%, -50%); }
.shot__open { top: 5px; right: 5px; width: 20px; height: 20px; opacity: 0; transition: opacity var(--fast); }
.shot__frame:hover .shot__open { opacity: 1; }

.shot__label {
  margin-top: 4px;
  overflow: hidden;
  color: var(--text-faint);
  font-size: var(--t-2xs);
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
