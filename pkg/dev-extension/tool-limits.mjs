/**
 * How many workspaces may hold a tool at the same time, and what the one asking over it is told.
 *
 * Each workspace leases its own dev server (`dev-<workspace>-dev-server`), and each is about 2 GB
 * and a webpack build that takes every core it is given. Three at once is the ceiling the user
 * set (2026-11-12): a fourth ask is refused, naming who holds the three and when their leases
 * end, rather than starting a server that slows all the others down.
 *
 * Pure and import-free: dev-api inlines it (scripts/gen-dev-api.mjs) and checks it on every
 * start, the Tools page reads the same numbers for its "2 of 3 in use", and node --test loads it.
 */

/** Ceilings, by tool kind. A kind not listed has none. */
export const TOOL_LIMITS = { 'dev-server': 3 };

/** The ceiling for a kind, or 0 for none. */
export function toolLimit(kind) {
  return TOOL_LIMITS[kind] || 0;
}

/** How long until a lease ends, said the way a person reads it: `in 42 min`, `in 1 h 5 min`. */
export function leaseLeft(expires, now = Date.now()) {
  const ms = Date.parse(expires || '') - now;

  if (!Number.isFinite(ms)) {
    return 'with no lease';
  }
  if (ms <= 0) {
    return 'now';
  }
  const minutes = Math.max(1, Math.round(ms / 60000));

  return minutes < 60 ? `in ${ minutes } min` : `in ${ Math.floor(minutes / 60) } h${ minutes % 60 ? ` ${ minutes % 60 } min` : '' }`;
}

/**
 * Whether `workspace` may start a `kind`, given who holds one now.
 *
 * `holders` are `{ workspace, expires }` for every one that exists and is not being removed.
 * Returns '' when it may - including when this workspace already holds one, since asking again
 * renews it and takes no new place - and otherwise the refusal, written for whoever reads it: an
 * agent's `tools start` prints it as it is.
 */
export function toolSlotRefusal(kind, workspace, holders = [], now = Date.now()) {
  const limit = toolLimit(kind);

  if (!limit || holders.some((h) => h.workspace === workspace) || holders.length < limit) {
    return '';
  }
  const label = kind === 'dev-server' ? 'dev servers' : `${ kind } tools`;
  const who = holders
    .slice()
    .sort((a, b) => (Date.parse(a.expires) || Infinity) - (Date.parse(b.expires) || Infinity))
    .map((h) => `${ h.workspace } (lease ends ${ leaseLeft(h.expires, now) })`)
    .join(', ');

  return `All ${ limit } ${ label } are in use: ${ who }. One has to be stopped first - \`tools stop ${ kind }\` in its workspace, or Stop on the Tools page - or wait for a lease to end.`;
}
