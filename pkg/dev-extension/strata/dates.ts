/** A server time (UTC, `YYYY-MM-DD HH:MM:SS`) as Strata's cards say it: Just now, 5m ago, 3h ago, or the date. */
export function relativeStamp(stamp: string, now = Date.now()): string {
  const at = new Date(`${ String(stamp || '').replace(' ', 'T') }Z`);

  if (Number.isNaN(at.getTime())) {
    return '';
  }
  const diff = now - at.getTime();

  if (diff < 60_000) {
    return 'Just now';
  }
  if (diff < 3_600_000) {
    return `${ Math.floor(diff / 60_000) }m ago`;
  }
  if (diff < 86_400_000) {
    return `${ Math.floor(diff / 3_600_000) }h ago`;
  }

  return at.toLocaleDateString();
}
