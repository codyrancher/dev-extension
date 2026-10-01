// The agent's review, as the deck's card needs it.
//
// A review workspace's agent writes its comments and files none of them: they sit as pending
// comments on the pull request until a person has been through them. That pass is the single
// highest thing in the queue (`review-findings`, 90) and it is the one card in the deck with
// real work inside it rather than a button that opens somewhere else - so the card carries the
// comments, and each comment carries the lines it is about.
//
// Which is the only interesting part of this file. GitHub hands a *filed* comment its own hunk;
// a pending one has only a path and a line, so the lines come from the pull request's patches,
// sliced around the comment. A comment you cannot see the code for is a comment you cannot
// judge, and judging them is the whole job.

import { listComments, prDetail, DEFAULT_REPO } from './reviews';
import type { LocalComment } from './reviews';

/** One line of a diff hunk, with the numbers from both sides so a comment can point at one. */
export interface DiffLine {
  type: 'context' | 'add' | 'del';
  old?: number;
  new?: number;
  text: string;
}

/** A comment the agent wrote, waiting for your pass, with the code it is about. */
export interface ReviewNote {
  id: string;
  /** The comment's own id, for the calls that change it. */
  commentId: number;
  pr: number;
  path: string;
  line: number;
  selects?: [number, number];
  severity: 'blocker' | 'nit' | 'praise' | 'question';
  /** One line for the list; the body is the comment itself. */
  title: string;
  body: string;
  hunk: DiffLine[];
  /** Where it came from, shown under the comment. */
  because?: string;
}

/** How many lines either side of the comment to carry. Enough to judge, short enough to read. */
const CONTEXT = 6;

/**
 * A patch, as lines with both sides' numbers.
 *
 * GitHub's patch is one string of unified diff with `@@` headers; the numbers that matter to a
 * comment are the new side's, which only the headers know.
 */
export function parsePatch(patch: string): DiffLine[] {
  const out: DiffLine[] = [];
  let oldNo = 0;
  let newNo = 0;

  for (const raw of String(patch || '').split('\n')) {
    const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);

    if (header) {
      oldNo = Number(header[1]);
      newNo = Number(header[2]);
      continue;
    }
    if (raw.startsWith('+')) {
      out.push({ type: 'add', new: newNo++, text: raw.slice(1) });
    } else if (raw.startsWith('-')) {
      out.push({ type: 'del', old: oldNo++, text: raw.slice(1) });
    } else if (raw.startsWith('\\')) {
      // "\ No newline at end of file": not a line of the file.
      continue;
    } else {
      out.push({
        type: 'context', old: oldNo++, new: newNo++, text: raw.replace(/^ /, ''),
      });
    }
  }

  return out;
}

/** The run of lines around the one a comment points at. */
export function hunkAround(lines: DiffLine[], line: number, startLine?: number | null): DiffLine[] {
  const at = lines.findIndex((entry) => entry.new === line);

  if (at < 0) {
    return lines.slice(0, CONTEXT * 2);
  }
  const first = startLine ? lines.findIndex((entry) => entry.new === startLine) : at;

  return lines.slice(Math.max(0, (first < 0 ? at : first) - CONTEXT), at + CONTEXT + 1);
}

/**
 * What the agent meant by it, from the comment's own words.
 *
 * The agents write their severity into the comment - a blocker says so, a nit says so - and the
 * card colours and sorts by it. Read rather than stored, because the comment is the record and
 * a second field that has to agree with it is a second field that will not.
 */
export function severityOf(body: string): ReviewNote['severity'] {
  const text = String(body || '').toLowerCase();

  if (/\b(blocker|must fix|bug|broken|regression|incorrect)\b/.test(text)) {
    return 'blocker';
  }
  if (/\?\s*$|^\s*(why|what|should|could|is there|does this)\b/m.test(text)) {
    return 'question';
  }
  if (/\b(nice|good catch|neat|well done|clear)\b/.test(text)) {
    return 'praise';
  }

  return 'nit';
}

/** The first line of a comment, which is how the agents write them: a sentence, then the detail. */
function titleOf(body: string): string {
  const first = String(body || '').split('\n').map((line) => line.trim()).find(Boolean) || '';

  return first.replace(/^[*_>#\s-]+/, '').slice(0, 120);
}

/**
 * Every comment the agent has written and not filed, with its code.
 *
 * Line-level only: a comment on the pull request as a whole has no lines to show, and the pass
 * is about the ones that point at something.
 */
export async function reviewNotes(pr: number, repo = DEFAULT_REPO): Promise<ReviewNote[]> {
  const [comments, detail] = await Promise.all([
    listComments(pr).catch(() => [] as LocalComment[]),
    prDetail(pr, repo).catch(() => null),
  ]);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const patches = new Map<string, DiffLine[]>((detail?.files || []).map((file: any) => [file.filename, parsePatch(file.patch || '')]));

  return comments
    .filter((comment) => comment.status === 'pending' && comment.level === 'line' && comment.path)
    .map((comment) => {
      const lines = patches.get(comment.path) || [];
      const line = Number(comment.line || 0);

      return {
        id:        `c${ comment.id }`,
        commentId: comment.id,
        pr,
        path:      comment.path,
        line,
        selects:   comment.start_line ? [Number(comment.start_line), line] as [number, number] : undefined,
        severity:  severityOf(comment.body),
        title:     titleOf(comment.body),
        body:      comment.body,
        hunk:      hunkAround(lines, line, comment.start_line),
        because:   comment.author && comment.author !== 'you' ? `written by ${ comment.author }` : '',
      };
    });
}
