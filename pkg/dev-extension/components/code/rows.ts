// One row of code, whatever is drawing it.
//
// Four places in this extension draw lines of code and until now each had its own idea of what a
// line is: the pull request tab's `DiffRow` (a table with expand rows and comment anchors), the
// review tab's copy of it, the rail's copy of that, and the Focus deck's `DiffLine`. The markup
// and the add/delete colours had been copied three times and had started to drift - one of them
// wrapped, two scrolled sideways, one highlighted syntax and the others did not.
//
// So: one row type, one renderer (CodeView), and adapters at the edges. A caller keeps the shape
// its API gave it and converts here; nothing has to change its data model to be drawn properly.

import { parsePatch } from '../../focus-review';
import type { DiffLine } from '../../focus-review';
import { highlightLines, escapeHtml } from '../pr/diff';
import type { DiffRow } from '../pr/diff';

/**
 * What a row is, for drawing.
 *
 * `hunk` is a `@@` header and `expand` is the "load the lines between" control the pull request
 * tab has; both are rows that take the whole width and have no line numbers. Keeping them in the
 * same list rather than special-casing them in each template is most of why those templates were
 * long.
 */
export interface CodeRow {
  kind: 'add' | 'del' | 'ctx' | 'hunk' | 'expand';
  /** Line number on the old side, or null where there is none. */
  old: number | null;
  /** Line number on the new side, or null. */
  new: number | null;
  text: string;
  /** Syntax-highlighted HTML for `text`, when it has been highlighted. Already escaped. */
  html?: string;
  /**
   * Marked on its own, rather than as part of a picked run.
   *
   * The rail marks the one line a comment is anchored to, inside a window of forty around it. A
   * range would do for that one case and not for the next: `marked` is per row, so a caller can
   * mark whatever set of lines it likes without the view knowing why.
   */
  marked?: boolean;
  /** Whatever the caller needs to get back on a click - its own row object, usually. */
  meta?: unknown;
}

/** The shape workspace-rail.ts builds, which predates this module. */
export interface RailRow {
  type: string;
  oldN: number | null;
  newN: number | null;
  html: string;
  marked?: boolean;
}

/** The rail's rows, as rows. Its html is already highlighted and already escaped. */
export function fromRailRows(rows: RailRow[]): CodeRow[] {
  return (rows || []).map((row) => ({
    kind:   KIND[row.type] || 'ctx',
    old:    row.oldN,
    new:    row.newN,
    text:   '',
    html:   row.html,
    marked: !!row.marked,
    meta:   row,
  }));
}

const KIND: Record<string, CodeRow['kind']> = {
  add: 'add', del: 'del', context: 'ctx', ctx: 'ctx', hunk: 'hunk', expand: 'expand',
};

/** The Focus deck's lines (focus-review.ts), as rows. */
export function fromDiffLines(lines: DiffLine[]): CodeRow[] {
  return (lines || []).map((line) => ({
    kind: KIND[line.type] || 'ctx',
    old:  line.old ?? null,
    new:  line.new ?? null,
    text: line.text,
    meta: line,
  }));
}

/** The pull request tab's rows (components/pr/diff.ts), as rows. */
export function fromDiffRows(rows: DiffRow[]): CodeRow[] {
  return (rows || []).map((row) => ({
    kind: KIND[row.type] || 'ctx',
    old:  row.oldN,
    new:  row.newN,
    text: row.text,
    meta: row,
  }));
}

/** A patch, straight to rows. */
export function fromPatch(patch: string): CodeRow[] {
  return fromDiffLines(parsePatch(patch || ''));
}

/**
 * A whole file, as rows numbered from one.
 *
 * Both gutters carry the same number: a file is not a diff, and leaving one of them blank draws a
 * column of nothing down the side of every line. See CodeView, which hides the second gutter when
 * no row in the list has two different numbers.
 */
export function fromText(text: string, path = '', from = 1): CodeRow[] {
  const lines = String(text ?? '').replace(/\n$/, '').split('\n');
  const html = path ? highlightLines(path, lines) : [];

  return lines.map((line, n) => ({
    kind: 'ctx' as const,
    old:  from + n,
    new:  from + n,
    text: line,
    html: html[n] ?? escapeHtml(line),
  }));
}

/**
 * A whole file, with this change's own lines still marked.
 *
 * "See the whole file" was drawing plain text: every line the same colour, so the thing you had
 * opened the file to put in context was the one thing you could no longer find. GitHub keeps the
 * diff colours when it expands a file and so does this.
 *
 * The patch says which lines on the new side were added, and which lines were removed and where
 * they sat. The file supplies everything between. Deletions are kept, in their place, because a
 * line that was taken out is not visible in the new file at all and is often the half that
 * explains the change.
 */
export function fromFileWithPatch(text: string, patch: string, path = ''): CodeRow[] {
  const file = fromText(text, path);

  if (!patch) {
    return file;
  }
  const added = new Set<number>();
  /** Removed lines, by the new-side line they came before. */
  const gone = new Map<number, CodeRow[]>();
  let at = 1;

  for (const line of parsePatch(patch)) {
    if (line.type === 'add' && line.new) {
      added.add(line.new);
      at = line.new + 1;
    } else if (line.type === 'del') {
      const here = gone.get(at) || [];

      here.push({
        kind: 'del', old: line.old ?? null, new: null, text: line.text,
      });
      gone.set(at, here);
    } else if (line.new) {
      at = line.new + 1;
    }
  }

  const out: CodeRow[] = [];

  for (const row of file) {
    const before = row.new === null ? undefined : gone.get(row.new);

    if (before) {
      out.push(...before);
    }
    out.push(added.has(row.new ?? -1) ? { ...row, kind: 'add' } : row);
  }
  // Anything removed from the end of the file, which no surviving line comes after.
  for (const [line, rows] of gone) {
    if (line > file.length) {
      out.push(...rows);
    }
  }

  return highlighted(out, path);
}

/** Syntax, added to rows that came from a diff. The `@@` and expand rows are left as they are. */
export function highlighted(rows: CodeRow[], path: string): CodeRow[] {
  if (!path) {
    return rows;
  }
  const codeAt: number[] = [];
  const texts: string[] = [];

  rows.forEach((row, n) => {
    if (row.kind !== 'hunk' && row.kind !== 'expand') {
      codeAt.push(n);
      texts.push(row.text);
    }
  });

  const html = highlightLines(path, texts);
  const out = rows.map((row) => ({ ...row }));

  codeAt.forEach((at, n) => {
    out[at].html = html[n];
  });

  return out;
}

/** Where in `rows` a line number falls, on whichever side it is numbered. -1 when it is not there. */
export function rowAtLine(rows: CodeRow[], line: number): number {
  return rows.findIndex((row) => row.new === line || (row.new === null && row.old === line));
}
