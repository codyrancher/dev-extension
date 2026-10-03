<script setup lang="ts">
/**
 * The failing checks, behind one control.
 *
 * A pull request with four failing e2e suites listed them all by name, and each name is
 * `e2e-test (admin, @adminUser, @navigation, @extensions)` - so four of them took two full rows
 * of the card, above the change they are about. The count is what you read; the names are what
 * you read next, and only sometimes.
 *
 * **This is only the failures now.** `N still running` and `N passed` were two more badges on the
 * same row, and the facts line draws those as text beside the rest of the arithmetic - see
 * CardEvidence, which is where the row's one voice lives. A badge that states a number is a fact;
 * this one opens a list, which is the only reason it is a control.
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import AppIcon from './AppIcon.vue';
import CheckList from './CheckList.vue';
import { under } from './popover';
import type { CardCheck, CardCi } from '../../focus-artifacts';

const props = defineProps<{
  /**
   * What the pull request says about its own checks: the counts, all of them.
   *
   * Every number on this badge row used to be a count of *display rows*. `ciOf` returns at
   * most six named failures, so `checks.filter(state === 'passed').length` was 1 on a pull request
   * with 40 passing checks and `failing.length` was 6 on one with 46 failures. Measured on two
   * live cards: `1 passed` where 40 passed, `1 passed` where 42 did. The rows are the names of
   * the failures; this is the arithmetic.
   */
  ci: CardCi;
  checks: CardCheck[];
  /**
   * The fact the card's 36px lede already said. See `claimed` in FocusCard.
   *
   * On a red-pr card the lede is `6 of 46 checks failing` and this badge read `6 failing` 10px
   * below it. CardEvidence has carried `claimed` for exactly this since the first StatPill said
   * `13 FILES` under a lede saying `13 files changed`; this was the one thing on the row it was
   * never passed to. The chevron stays - it is the only way to the names - and the number goes.
   */
  claimed?: string;
}>();

const open = ref(false);
const root = ref<HTMLElement | null>(null);
const badge = ref<HTMLElement | null>(null);
const spot = ref<Record<string, string>>({});

/** The ones with names, which is what the popover is for. See `ci` for how many there are. */
const named = computed(() => props.checks.filter((check) => check.state === 'failed'));

function toggle() {
  open.value = !open.value;
  if (open.value) {
    spot.value = under(badge.value, 420);
  }
}

/** Clicked rather than hovered, so reading the list does not depend on keeping the pointer still. */
function away(event: MouseEvent) {
  const inList = (event.target as HTMLElement)?.closest?.('.ck__list');

  if (open.value && root.value && !root.value.contains(event.target as Node) && !inList) {
    open.value = false;
  }
}

onMounted(() => window.addEventListener('click', away, true));
onBeforeUnmount(() => window.removeEventListener('click', away, true));
</script>

<template>
  <div ref="root" class="ck">
    <button
      v-if="ci.failing"
      ref="badge"
      type="button"
      class="u-pill ck__badge"
      :class="{ 'ck__badge--on': open }"
      :title="open ? 'Hide which ones' : 'See which ones are failing'"
      :aria-expanded="open ? 'true' : 'false'"
      @click="toggle"
    >
      <AppIcon name="cross" :size="11" />
      {{ claimed === 'checks' ? 'which ones' : `${ ci.failing } failing` }}
      <AppIcon :name="open ? 'chevron-up' : 'chevron-down'" :size="11" />
    </button>

    <!--
      Teleported, because every box between this badge and the page clips it.

      `.ev`, `.card__facts`, `.card__body` and `.card` are all `overflow: hidden`, each for its own
      good reason, and the deck transforms the card besides - so an absolute popover is cut off at
      the fact line and a fixed one is fixed to the transform. It goes to the body carrying
      `.dev-focus`, which is where this view's tokens are declared, and `under` gives it somewhere
      to be. Same shape as MediaViewer and TextModal, for the same reason.
    -->
    <Teleport to="body">
      <div class="dev-focus">
        <Transition name="ck">
          <div v-if="open && named.length" class="u-popover ck__list" :style="spot">
            <CheckList :checks="named" :failing="ci.failing" />
          </div>
        </Transition>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
/* The row's height, so a control on a line of facts is on the line. */
.ck { position: relative; display: inline-flex; align-items: center; height: var(--pill-h); flex: 0 0 auto; }

/*
 * `.u-pill` carries the box; this carries what makes it a check.
 *
 * The 24px here was wrong and said so in a comment - "the height everything else in the
 * evidence band is" - while its two neighbours on that row were 32px and 26px.
 */
.ck__badge {
  border: 1px solid color-mix(in srgb, var(--danger) 42%, transparent);
  background: transparent;
  color: var(--danger);
  font-family: var(--font);
  font-weight: 600;
  cursor: pointer;
}

.ck__badge:hover,
.ck__badge--on { background: color-mix(in srgb, var(--danger) 12%, transparent); }

.ck__list { max-height: 60vh; overflow: hidden auto; }

.ck-enter-active { transition: opacity var(--fast) var(--ease-out), transform var(--fast) var(--ease-out); }
.ck-leave-active { transition: opacity var(--fast) linear; }
.ck-enter-from,
.ck-leave-to { opacity: 0; transform: translateY(-4px); }
</style>
