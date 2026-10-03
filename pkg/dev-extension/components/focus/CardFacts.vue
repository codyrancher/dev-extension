<script setup lang="ts">
/**
 * The few facts that decide a security advisory or a dependency bump.
 *
 * Both cards used to show nothing. The advisory's `what` is `Advisory GHSA-…`, which carries no
 * `#number`, so nothing resolved for it and the card drew an empty body under a title. The bump
 * asked for the diff and the checks but not the version change - which is the only thing anybody
 * decides a bump on.
 *
 * So: what it is, what is vulnerable, what fixes it. And for a bump, the jump itself, with a
 * major crossing called out, because that is the difference between a formality and a change that
 * needs reading.
 */
import { computed } from 'vue';
import SectionHead from './SectionHead.vue';
import AppIcon from './AppIcon.vue';
import type { AdvisoryFacts, BumpFacts } from '../../focus-artifacts';

const props = defineProps<{ advisory?: AdvisoryFacts | null; bump?: BumpFacts | null }>();

const tone = computed(() => ({
  critical: 'bad', high: 'bad', medium: 'warn', low: 'muted', moderate: 'warn',
}[props.advisory?.severity || ''] || 'muted'));
</script>

<template>
  <section class="fx">
    <template v-if="advisory">
      <SectionHead label="The advisory" icon="clock">
        <span class="u-pill fx__sev" :class="`fx__sev--${ tone }`">{{ advisory.severity || 'unrated' }}</span>
      </SectionHead>

      <dl class="fx__rows">
        <template v-if="advisory.packages.length">
          <dt>Packages</dt>
          <dd><code>{{ advisory.packages.join(', ') }}</code></dd>
        </template>
        <template v-if="advisory.affected">
          <dt>Vulnerable</dt>
          <dd><code>{{ advisory.affected }}</code></dd>
        </template>
        <template v-if="advisory.patched">
          <dt>Fixed in</dt>
          <dd class="fx__good"><code>{{ advisory.patched }}</code></dd>
        </template>
        <template v-if="advisory.alerts">
          <dt>Alerts here</dt>
          <dd>{{ advisory.alerts }}</dd>
        </template>
      </dl>

      <p v-if="advisory.summary" class="fx__prose">{{ advisory.summary }}</p>
    </template>

    <template v-if="bump">
      <SectionHead label="The bump" icon="clock" />

      <div class="fx__jump">
        <code class="fx__from">{{ bump.from || '?' }}</code>
        <AppIcon name="arrow-right" :size="14" />
        <code class="fx__to">{{ bump.to || '?' }}</code>
        <span class="fx__pkg">{{ bump.package }}</span>
        <span v-if="bump.ecosystem" class="u-badge">{{ bump.ecosystem }}</span>
        <span v-if="bump.major" class="fx__major">crosses a major</span>
      </div>

      <p v-if="bump.major" class="fx__prose">
        A major version can change or remove what this repository uses. Worth reading the changelog
        before it goes in, which is what the question below is for.
      </p>
    </template>
  </section>
</template>

<style scoped>
.fx { display: flex; flex-direction: column; gap: var(--s3); min-width: 0; }

/* `.u-pill` carries the box. A severity is the one pill that shouts, so what is left here is
   the shouting: uppercase, tracked out, heavy. */
.fx__sev {
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.fx__sev--bad { background: color-mix(in srgb, var(--danger) 20%, transparent); color: var(--danger); }
.fx__sev--warn { background: color-mix(in srgb, var(--warning) 20%, transparent); color: var(--warning); }
.fx__sev--muted { background: var(--surface-raised); color: var(--text-muted); }

/* Label and value, aligned, because four facts in a row of prose is four facts nobody reads. */
.fx__rows {
  display: grid;
  grid-template-columns: 11ch minmax(0, 1fr);
  gap: 4px var(--s3);
  margin: 0;
  font-size: var(--t-sm);
}

.fx__rows dt { color: var(--text-faint); font-size: var(--t-xs); }
.fx__rows dd { margin: 0; min-width: 0; color: var(--text-dim); overflow-wrap: anywhere; }
.fx__rows code { font-family: var(--mono); font-size: var(--t-xs); }
.fx__good code { color: var(--success); }

.fx__jump {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--s2);
  color: var(--text-muted);
}

.fx__from,
.fx__to {
  padding: 2px 9px;
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  background: var(--surface-sunk);
  font-family: var(--mono);
  font-size: var(--t-sm);
}

.fx__to { border-color: color-mix(in srgb, var(--kind) 40%, transparent); color: var(--text); }
.fx__pkg { color: var(--text-dim); font-size: var(--t-sm); font-weight: 600; }
.fx__major { color: var(--danger); font-size: var(--t-xs); font-weight: 650; }

.fx__prose { margin: 0; max-width: 78ch; color: var(--text-dim); font-size: var(--t-sm); line-height: 1.6; }
</style>
