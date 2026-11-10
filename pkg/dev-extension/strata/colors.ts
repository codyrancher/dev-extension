/** Strata's label palette. */
export const LABEL_COLORS = [
  '#f87171', '#fb923c', '#fbbf24', '#a3e635', '#4ade80',
  '#34d399', '#2dd4bf', '#22d3ee', '#60a5fa', '#818cf8',
  '#a78bfa', '#c084fc', '#e879f9', '#f472b6', '#fb7185',
];

/** How long a press is held before it counts as a long press. */
export const LONG_PRESS_MS = 250;

/** A colour for a new label: one no label has yet, while there are any. */
export function randomLabelColor(used: string[]): string {
  const taken = new Set(used);
  const free = LABEL_COLORS.filter((c) => !taken.has(c));
  const pool = free.length ? free : LABEL_COLORS;

  return pool[Math.floor(Math.random() * pool.length)];
}
