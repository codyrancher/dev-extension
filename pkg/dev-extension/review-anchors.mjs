/**
 * Where a review comment is allowed to land, worked out from the pull request's own diff.
 *
 * GitHub will only take an inline comment on a line that appears in the diff - an added line,
 * or a context line beside one - and it rejects the *whole* review when any single comment
 * misses, with `422 Line could not be resolved` and no word about which comment it meant. A
 * five-finding review with uploaded evidence is lost to one line being one off, and the only
 * clue is a status code.
 *
 * So the anchors are checked here first, against the same patches GitHub is about to check them
 * against. A range whose start has slipped out of the hunk is pulled back in - the finding is
 * still about the line it ends on, which is the line GitHub anchors a range to - and anything
 * that genuinely has nowhere to go is named, with the lines that *are* open to it, before a
 * single byte is uploaded.
 *
 * Nothing is imported: `reviews.ts` needs it in the browser and `node --test` needs it here.
 *
 * @typedef {{ right: Set<number>, left: Set<number> }} FileLines
 * @typedef {{ path?: string|null, line?: number|null, start_line?: number|null, side?: string|null }} Anchor
 */

/**
 * The lines one file's patch opens up, per side.
 *
 * A hunk header gives the first line number on each side; from there a `+` advances the new
 * file, a `-` the old, and a context line both. `\ No newline at end of file` and GitHub's own
 * blank trailing line advance neither.
 *
 * @param {string} patch
 * @returns {FileLines}
 */
export function patchLines(patch) {
  const right = new Set();
  const left = new Set();
  let newLine = 0;
  let oldLine = 0;

  for (const row of String(patch || '').split('\n')) {
    const head = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(row);

    if (head) {
      oldLine = Number(head[1]);
      newLine = Number(head[2]);
      continue;
    }

    if (row.startsWith('\\')) {
      continue;
    }

    if (row.startsWith('+')) {
      right.add(newLine++);
    } else if (row.startsWith('-')) {
      left.add(oldLine++);
    } else if (row.startsWith(' ')) {
      right.add(newLine++);
      left.add(oldLine++);
    }
  }

  return { right, left };
}

/**
 * Every file in the pull request, by path.
 *
 * A file with no `patch` is left out rather than recorded as empty: GitHub omits the patch for
 * a file too big to show, and treating "we were not told" as "nothing is commentable" would
 * refuse a review that would have posted. Unknown means unchecked, here and in `resolveAnchor`.
 *
 * @param {Array<{ filename?: string, patch?: string }>} files
 * @returns {Map<string, FileLines>}
 */
export function diffAnchors(files) {
  const byPath = new Map();

  for (const file of files || []) {
    if (file?.filename && file?.patch) {
      byPath.set(file.filename, patchLines(file.patch));
    }
  }

  return byPath;
}

/** `183-197, 203` - the lines a comment on this side may use, as a reader wants them. */
export function describeLines(lines) {
  const runs = [];

  for (const line of [...(lines || [])].sort((a, b) => a - b)) {
    const last = runs[runs.length - 1];

    if (last && line === last[1] + 1) {
      last[1] = line;
    } else {
      runs.push([line, line]);
    }
  }

  return runs.map(([from, to]) => (from === to ? `${ from }` : `${ from }-${ to }`)).join(', ');
}

/**
 * Settle one comment's anchor against the diff.
 *
 * Three answers. `ok` with nothing changed is the common one. `ok` with `moved` is a range
 * whose `start_line` had fallen outside the hunk and was pulled up to the first line of the
 * diff that the range still covers - at worst as far as `line` itself, which turns it into the
 * single-line comment it would have been anyway. `ok: false` is a line the diff does not
 * contain at all: that one cannot be repaired without moving the finding somewhere it is not
 * about, so it is reported instead.
 *
 * @param {Anchor} comment
 * @param {FileLines|undefined} lines - what the diff allows, or undefined when it is unknown
 * @returns {{ ok: boolean, line?: number|null, start_line?: number|null, side: string, moved?: string, why?: string }}
 */
export function resolveAnchor(comment, lines) {
  const side = comment?.side || 'RIGHT';
  const line = comment?.line ?? null;
  const start = comment?.start_line ?? null;

  // A comment on the pull request rather than a line of it, and a file whose patch GitHub did
  // not send, are both out of scope: pass them through as they are.
  if (!comment?.path || line === null || !lines) {
    return {
      ok: true, line, start_line: start, side,
    };
  }

  const allowed = side === 'LEFT' ? lines.left : lines.right;

  if (!allowed.has(line)) {
    return {
      ok:   false,
      side,
      why:  `line ${ line } is not in this pull request's diff of ${ comment.path }${ allowed.size ? ` (it covers ${ describeLines(allowed) })` : '' }`,
    };
  }

  if (start === null || (allowed.has(start) && start < line)) {
    return {
      ok: true, line, start_line: start, side,
    };
  }

  // The first line of the diff the range still covers. There is always one - `line` itself -
  // and landing there drops `start_line`, because a range that starts where it ends is not a
  // range and GitHub rejects it as one.
  let from = line;

  for (let at = Math.min(start, line); at < line; at++) {
    if (allowed.has(at)) {
      from = at;
      break;
    }
  }

  const slipped = start >= line ? `${ comment.path } range ${ start }-${ line } does not run forwards` : `${ comment.path } ${ start }-${ line } starts outside the diff`;

  return {
    ok:         true,
    line,
    start_line: from < line ? from : null,
    side,
    moved:      `${ slipped }; narrowed to ${ from < line ? `${ from }-${ line }` : `line ${ line }` }`,
  };
}

/**
 * Every comment's anchor, and what to say if some of them have nowhere to go.
 *
 * @template {Anchor & { id?: number }} T
 * @param {T[]} comments
 * @param {Map<string, FileLines>} byPath
 */
export function resolveAnchors(comments, byPath) {
  const resolved = [];
  const moved = [];
  const lost = [];

  for (const comment of comments || []) {
    const anchor = resolveAnchor(comment, comment?.path ? byPath.get(comment.path) : undefined);

    if (anchor.ok) {
      resolved.push({ comment, anchor });

      if (anchor.moved) {
        moved.push(anchor.moved);
      }
    } else {
      lost.push(`Comment ${ comment.id ?? '?' }: ${ anchor.why }`);
    }
  }

  return { resolved, moved, lost };
}

/** What to tell someone whose review will not post, and what they can do about it. */
export function lostMessage(lost) {
  return [
    `${ lost.length } comment${ lost.length === 1 ? '' : 's' } cannot be posted - GitHub only takes a comment on a line the pull request's diff contains, and it refuses the whole review over one.`,
    ...lost,
    'The branch has probably moved since the finding was written. Re-anchor or delete them, then submit again.',
  ].join('\n');
}

/**
 * What to add to "posted N comments" when an anchor had to be pulled in to fit the diff.
 *
 * Said rather than done quietly: the comment is public now and it is not quite where it was
 * written, so the person who sent it should hear which one moved and where it went.
 */
export function movedNote(moved) {
  return moved?.length ? ` ${ moved.length === 1 ? 'One range was' : `${ moved.length } ranges were` } narrowed to fit the diff: ${ moved.join('; ') }.` : '';
}
