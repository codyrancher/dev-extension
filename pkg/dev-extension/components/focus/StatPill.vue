<script setup lang="ts">
/** One number with its name: files changed, lines added, hours waited. */
defineProps<{ label: string; value: string; tone?: 'default' | 'good' | 'warn' | 'bad' }>();
</script>

<template>
  <span class="stat" :class="`stat--${ tone || 'default' }`">
    <span class="stat__value">{{ value }}</span>
    <span class="stat__label">{{ label }}</span>
  </span>
</template>

<style scoped>
.stat {
  display: inline-flex;
  align-items: baseline;
  gap: var(--s2);
  padding: 6px 12px;
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  background: var(--surface-sunk);
}

.stat__value { font-size: var(--t-md); font-weight: 650; font-variant-numeric: tabular-nums; }
.stat__label { color: var(--text-muted); font-size: var(--t-xs); letter-spacing: 0.03em; text-transform: uppercase; }

.stat--good .stat__value { color: var(--success); }
.stat--warn .stat__value { color: var(--warning); }
.stat--bad  .stat__value { color: var(--danger); }
</style>
