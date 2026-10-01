<script setup lang="ts">
/**
 * The deck before the first read comes back.
 *
 * Drawn as the deck rather than as a loading state: the same frame at the same size in the same
 * place, the same two bands above it, and inside it the shapes a card is actually made of - the
 * chip and the repository, a title of two lines, a byline, a rule, some body, and the row of
 * actions along the bottom. Three grey rectangles told you a rectangle was coming and then the
 * whole layout changed under you; this way the only thing that happens when the cards land is
 * that the words appear.
 */
</script>

<template>
  <div class="skel" role="status" aria-label="Gathering what needs you">
    <!-- The stack above, in the deck's own steps. -->
    <div v-for="n in 2" :key="n" class="skel__band" :style="{ '--depth': n }" />

    <article class="skel__card">
      <header>
        <div class="skel__row">
          <span class="skel__bar skel__bar--chip" />
          <span class="skel__bar" style="width: 148px" />
        </div>

        <div class="skel__title">
          <span class="skel__bar skel__bar--title" style="width: 58%" />
          <span class="skel__bar skel__bar--title" style="width: 34%" />
        </div>

        <span class="skel__bar skel__bar--summary" style="width: 42%" />

        <div class="skel__row skel__by">
          <span class="skel__mark" />
          <span class="skel__bar" style="width: 92px" />
          <span class="skel__bar" style="width: 64px" />
        </div>
      </header>

      <div class="skel__body">
        <span class="skel__bar" style="width: 46%" />
        <span class="skel__bar" style="width: 38%" />
        <div class="skel__row">
          <span class="skel__tile" />
          <span class="skel__tile" />
        </div>
      </div>

      <footer class="skel__foot">
        <span class="skel__bar skel__bar--action" style="width: 196px" />
        <span class="skel__bar skel__bar--action" style="width: 142px" />
        <span class="skel__bar skel__bar--action skel__bar--quiet" style="width: 158px" />
      </footer>
    </article>
  </div>
</template>

<style scoped>
/* The deck's frame, to the pixel: nothing shifts when the real one replaces this. */
.skel {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  place-items: stretch center;
  height: 100%;
  padding: 34px 62px var(--s3) clamp(var(--s3), 2vw, var(--s6));
}

.skel__card,
.skel__band {
  grid-area: 1 / 1;
  width: min(1680px, 100%);
  min-width: 0;
  max-width: 100%;
  min-height: 0;
  border: 1px solid var(--border);
  border-radius: var(--r-xl);
  background: var(--surface);
  transform-origin: 50% 0;
}

/* The bands, at the deck's steps and its dimming, but with no colour to give yet. */
.skel__band {
  z-index: calc(3 - var(--depth));
  transform: translate3d(0, calc(var(--depth) * -15px), 0) scale(calc(1 - var(--depth) * 0.016));
  filter: brightness(calc(1 - var(--depth) * 0.14));
}

.skel__card {
  z-index: 5;
  display: flex;
  flex-direction: column;
  padding: clamp(var(--s5), 3.2vw, var(--s7));
  box-shadow: var(--shadow-card);
  overflow: hidden;
}

/* Every shape is one of these: a block of the surface a shade up, quietly breathing. */
.skel__bar,
.skel__mark,
.skel__tile {
  display: block;
  border-radius: var(--r-sm);
  background: var(--surface-raised);
  animation: skel-breathe 2.2s var(--ease-in-out) infinite;
}

.skel__bar { height: 12px; }
.skel__bar--chip { width: 104px; height: 24px; border-radius: var(--r-pill); }
.skel__bar--title { height: clamp(26px, 3.1vw, 40px); border-radius: var(--r-md); }
.skel__bar--summary { height: 17px; margin-top: var(--s3); }
.skel__bar--action { height: 48px; border-radius: var(--r-md); }
.skel__bar--quiet { margin-left: auto; opacity: 0.5; }

.skel__mark { width: 28px; height: 28px; border-radius: var(--r-pill); }

.skel__tile {
  width: 232px;
  height: 132px;
  border-radius: var(--r-md);
}

.skel__row { display: flex; align-items: center; gap: var(--s3); flex-wrap: wrap; }
.skel__title { display: grid; gap: var(--s2); margin-top: var(--s4); }

.skel__by {
  gap: var(--s2);
  margin-top: var(--s4);
  padding-bottom: var(--s4);
  border-bottom: 1px solid var(--border);
}

.skel__body {
  display: flex;
  flex-direction: column;
  gap: var(--s3);
  flex: 1;
  min-height: 0;
  margin-top: var(--s5);
}

.skel__foot {
  display: flex;
  align-items: center;
  gap: var(--s3);
  margin-top: var(--s4);
  padding-top: var(--s4);
  border-top: 1px solid var(--border);
  flex-wrap: wrap;
}

/* Staggered along the card, so it reads as one thing waiting rather than a grid flashing. */
.skel__bar:nth-child(2) { animation-delay: 120ms; }
.skel__bar:nth-child(3) { animation-delay: 240ms; }
.skel__title .skel__bar:last-child { animation-delay: 160ms; }
.skel__body .skel__bar:last-of-type { animation-delay: 200ms; }
.skel__tile:last-child { animation-delay: 260ms; }

@keyframes skel-breathe {
  50% { opacity: 0.45; }
}

@media (max-width: 860px) {
  .skel { padding: 30px var(--s3) var(--s5); }
  .skel__tile { width: 132px; height: 96px; }
  .skel__bar--action { width: 140px !important; }
  .skel__bar--quiet { margin-left: 0; }
}
</style>
