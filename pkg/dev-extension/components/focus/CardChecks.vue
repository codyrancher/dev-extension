<script setup lang="ts">
/**
 * What CI says, as one badge per state rather than one per check.
 *
 * A pull request with four failing e2e suites listed them all by name, and each name is
 * `e2e-test (admin, @adminUser, @navigation, @extensions)` - so four of them took two full rows
 * of the card, above the change they are about. The count is what you read; the names are what
 * you read next, and only sometimes.
 *
 * So: `4 failing` opens a list. Each row is the check, what it reported in its own words, and a
 * link to the run - which is the thing you actually wanted when you started reading the names.
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import AppIcon from './AppIcon.vue';
import SectionHead from './SectionHead.vue';
import type { CardCheck } from '../../focus-artifacts';

const props = defineProps<{ checks: CardCheck[] }>();

const open = ref(false);
const root = ref<HTMLElement | null>(null);

const failing = computed(() => props.checks.filter((check) => check.state === 'failed'));
const running = computed(() => props.checks.find((check) => check.state === 'running'));
const passed = computed(() => props.checks.find((check) => check.state === 'passed'));

/** Clicked rather than hovered, so reading the list does not depend on keeping the pointer still. */
function away(event: MouseEvent) {
  if (open.value && root.value && !root.value.contains(event.target as Node)) {
    open.value = false;
  }
}

onMounted(() => window.addEventListener('click', away, true));
onBeforeUnmount(() => window.removeEventListener('click', away, true));
</script>

<template>
  <div ref="root" class="ck">
    <!-- The failures, behind a count. -->
    <button
      v-if="failing.length"
      type="button"
      class="u-pill ck__badge ck__badge--bad"
      :class="{ 'ck__badge--on': open }"
      :title="open ? 'Hide which ones' : 'See which ones are failing'"
      :aria-expanded="open ? 'true' : 'false'"
      @click="open = !open"
    >
      <AppIcon name="cross" :size="11" />
      {{ failing.length }} failing
      <AppIcon :name="open ? 'chevron-up' : 'chevron-down'" :size="11" />
    </button>

    <!-- The other two states are already one badge each, so they stay as they are. -->
    <span v-if="running" class="u-pill ck__badge ck__badge--run">
      <AppIcon name="spinner" :size="11" />
      {{ running.name }}
    </span>
    <span v-if="passed" class="u-pill ck__badge ck__badge--ok">
      <AppIcon name="check" :size="11" />
      {{ passed.name }}
    </span>

    <Transition name="ck">
      <div v-if="open && failing.length" class="u-popover ck__list">
        <SectionHead label="Failing checks" icon="cross" :count="String(failing.length)" />
        <component
          :is="check.url ? 'a' : 'div'"
          v-for="check in failing"
          :key="check.name"
          class="ck__row"
          :href="check.url || undefined"
          :target="check.url ? '_blank' : undefined"
          :rel="check.url ? 'noopener' : undefined"
        >
          <span class="ck__name">{{ check.name }}</span>
          <span v-if="check.detail" class="ck__why">{{ check.detail }}</span>
          <AppIcon v-if="check.url" name="arrow-right" :size="12" class="ck__go" />
        </component>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
/* The band's height, so a row of evidence is a row and not three boxes near each other. */
.ck { position: relative; display: inline-flex; align-items: center; gap: var(--s2); height: var(--pill-h); }

/*
 * `.u-pill` carries the box; this carries what makes it a check.
 *
 * The 24px here was wrong and said so in a comment - "the height everything else in the
 * evidence band is" - while its two neighbours on that row were 32px and 26px.
 */
.ck__badge {
  border: 1px solid var(--border);
  background: transparent;
  color: var(--text-muted);
  font-family: var(--font);
  font-weight: 600;
}

.ck__badge--bad { border-color: color-mix(in srgb, var(--danger) 42%, transparent); color: var(--danger); cursor: pointer; }
.ck__badge--bad:hover,
.ck__badge--on { background: color-mix(in srgb, var(--danger) 12%, transparent); }
.ck__badge--run { color: var(--text-dim); font-weight: 400; }
.ck__badge--ok { border-color: color-mix(in srgb, var(--success) 30%, transparent); color: var(--success); font-weight: 400; }

/* Opening downward: the band is at the top of the card and there is nothing above it. */
.ck__list { top: calc(100% + 6px); left: 0; }

/*
 * The header this popover used to hand-roll - its own margin, `--text-faint`, `--t-xs`, weight
 * 400 - is SectionHead now, which is what every other named part of a card is. It was the only
 * surface on the deck that looked like it came from somewhere else. The gap below it is the
 * list's, not the header's.
 */
.ck__list > :deep(.sh) { margin-bottom: var(--s2); }

.ck__row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: baseline;
  gap: 2px var(--s2);
  min-height: 30px;
  padding: var(--s2);
  border-radius: var(--r-sm);
  color: var(--text-dim);
  text-decoration: none;
}

a.ck__row:hover { background: var(--surface-raised); color: var(--text); }

.ck__name {
  font-family: var(--mono);
  font-size: var(--t-xs);
  overflow-wrap: anywhere;
}

/* What it reported, which is the half that says whether it is yours. */
.ck__why {
  grid-column: 1 / -1;
  color: var(--text-faint);
  font-size: var(--t-xs);
  line-height: 1.45;
}

.ck__go { flex: 0 0 auto; color: var(--text-faint); }

.ck-enter-active { transition: opacity var(--fast) var(--ease-out), transform var(--fast) var(--ease-out); }
.ck-leave-active { transition: opacity var(--fast) linear; }
.ck-enter-from,
.ck-leave-to { opacity: 0; transform: translateY(-4px); }
</style>
