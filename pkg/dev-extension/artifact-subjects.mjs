/**
 * Which issue or pull request a workspace is about, read off its name.
 *
 * The Artifacts page grouped kept sets by this and is gone; the name is still how the housekeeping
 * sweep and the workspace API tell a fix's artifacts from a review's.
 *
 * Plain JavaScript and no imports, so `node --test` loads it directly - see
 * tests/artifact-subjects.test.mjs.
 */

/** The issue and PR a workspace name is about: `lte-issue-14904` is issue 14904. */
export function numbersIn(name) {
  return {
    issue: Number(/(?:^|-)issue-(\d+)(?:-|$)/.exec(name || '')?.[1]) || 0,
    pr:    Number(/(?:^|-)pr-(\d+)(?:-|$)/.exec(name || '')?.[1]) || 0,
  };
}

/** When a source last had anything written into it, as a number; 0 when it never said. */
function whenOf(source) {
  const at = source?.at || source?.capturedAt || source?.createdAt || '';
  const ms = typeof at === 'number' ? at : Date.parse(at);

  return Number.isFinite(ms) ? ms : 0;
}
