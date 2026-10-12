<script setup lang="ts">
/**
 * One card's body, in more than one view of the same subject.
 *
 * A tab strip and nothing else: it owns which tab is on and draws the panes it is handed, and
 * knows nothing about what is in them. That is what makes it usable from any card - it is in
 * `CARD_COMPONENTS`, so a card module's template can ask for it by name the way it asks for
 * `CardSurface`.
 *
 * What it does *not* do is keep its own state across cards. The deck reuses one component per
 * position as it turns, so a tab index living here would follow you onto the next card and show
 * its second tab first. `key` is the card's id where this is used; the selection resets with it.
 *
 * Panes are slots rather than components, so a tab can be anything - a surface, a summary, a
 * sentence - and a card that has nothing for a tab leaves it out of `tabs` rather than passing
 * an empty one. See `review-pass`, which drops Issue when the pull request names none.
 */
import { ref, computed, watch } from 'vue';

export interface CardTab {
  /** Matches the slot name. */
  id: string;
  label: string;
  /** Shown beside the label when there is a number worth knowing - findings, comments. */
  count?: number | null;
}

const props = withDefaults(defineProps<{
  tabs: CardTab[];
  /** Which one opens. Falls back to the first, which is the card's own subject. */
  start?: string;
}>(), { start: '' });

const emit = defineEmits<{ (e: 'show', id: string): void }>();

const on = ref(props.start || props.tabs[0]?.id || '');

/*
 * A tab that stops existing gives the strip back to the first one.
 *
 * `tabs` is computed on the card - Issue appears only when the pull request names an issue, and
 * the artifacts it is read from arrive after the card is drawn. Without this, a card whose tabs
 * change under it keeps an `on` that matches nothing and draws no pane at all.
 */
watch(() => props.tabs.map((tab) => tab.id).join(','), () => {
  if (!props.tabs.some((tab) => tab.id === on.value)) {
    on.value = props.tabs[0]?.id || '';
  }
});

const shown = computed(() => on.value);

function show(id: string) {
  on.value = id;
  emit('show', id);
}

defineExpose({ show, shown });
</script>

<template>
  <div class="tabs">
    <!--
      `role="tablist"` and the arrow keys that go with it: this is a tab strip in the sense the
      platform means, and a keyboard should move along it without reaching for the pointer.
    -->
    <div class="tabs__strip" role="tablist">
      <button
        v-for="tab in tabs"
        :id="`tab-${ tab.id }`"
        :key="tab.id"
        type="button"
        role="tab"
        class="tabs__tab"
        :class="{ 'tabs__tab--on': tab.id === shown }"
        :aria-selected="tab.id === shown ? 'true' : 'false'"
        :tabindex="tab.id === shown ? 0 : -1"
        @click="show(tab.id)"
      >
        {{ tab.label }}
        <span v-if="tab.count || tab.count === 0" class="tabs__count">{{ tab.count }}</span>
      </button>
    </div>

    <!--
      One pane, and the others not rendered at all.

      `v-show` would keep every tab mounted, which for these panes means a diff and two bodies
      of markdown laid out to be looked at one at a time. The cost of re-rendering one on each
      press is less than the cost of three on every card the deck turns to.
    -->
    <div class="tabs__pane" role="tabpanel" :aria-labelledby="`tab-${ shown }`">
      <slot :name="shown" />
    </div>
  </div>
</template>

<style scoped>
.tabs {
  display: flex;
  flex-direction: column;
  /* The body's whole height, so the pane below scrolls rather than the card growing. */
  flex: 1 1 auto;
  min-height: 0;
  min-width: 0;
}

.tabs__strip {
  display: flex;
  align-items: center;
  gap: var(--s1, 4px);
  flex: 0 0 auto;
  /* The rule runs the width of the body, and the tabs sit on it rather than above it. */
  border-bottom: 1px solid var(--border);
  margin-bottom: var(--s3);
}

.tabs__tab {
  display: inline-flex;
  align-items: center;
  gap: var(--s2);
  padding: var(--s2) var(--s3);
  /* Space for the 2px marker below, so nothing moves when a tab becomes the one that is on. */
  border: 0;
  border-bottom: 2px solid transparent;
  margin-bottom: -1px;
  background: none;
  color: var(--text-muted);
  font: inherit;
  font-size: var(--t-sm);
  cursor: pointer;
  transition: color var(--fast), border-color var(--fast);
}

.tabs__tab:hover { color: var(--text); }

.tabs__tab--on {
  border-bottom-color: var(--kind, var(--accent));
  color: var(--text);
}

/* The figures' font, so a count does not shift the label it sits beside as it changes. */
.tabs__count {
  color: var(--text-faint);
  font-family: var(--mono);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}

.tabs__tab--on .tabs__count { color: var(--text-muted); }

.tabs__pane {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-height: 0;
  min-width: 0;
}
</style>
