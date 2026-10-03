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
/*
 * The band's height, not its own.
 *
 * Its `6px 12px` over a 15px line came out ~32px, beside a 24px check badge and a 26px live
 * pill on the same centred row - three heights, three baselines, one strip of facts. The row
 * is `--pill-h` throughout now; what distinguishes a stat from a badge is its border and its
 * big tabular number, which is what was meant to be doing the work.
 */
.stat {
  /*
   * Grid rather than flex for one reason: `align-content` works here. A flex row with
   * `align-items: baseline` pins its baseline group to the top of the box, so a fixed height
   * would hang the number from the top edge; grid lets the row keep its shared baseline and
   * sit on the centre of the pill.
   */
  display: inline-grid;
  grid-auto-flow: column;
  align-items: baseline;
  align-content: center;
  gap: var(--s2);
  height: var(--pill-h);
  padding: 0 var(--s3);
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
