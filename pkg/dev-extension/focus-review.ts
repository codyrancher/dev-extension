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

import { listComments, prDetail, artifactUrl, DEFAULT_REPO } from './reviews';
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
  severity: 'blocker' | 'nit' | 'praise' | 'question' | 'finding';
  /** One line for the list; the body is the comment itself. */
  title: string;
  body: string;
  hunk: DiffLine[];
  /** Where it came from, shown under the comment. */
  because?: string;
  /** What the agent hung on it to prove it: the screenshot, the recording. */
  media: NoteMedia[];
}

/**
 * A file an agent attached to one of its comments.
 *
 * Served out of the workspace it was made in, not from GitHub - nothing has been posted yet, and
 * uploading needs a github.com session this dashboard does not have. See reviews.ts, artifactUrl.
 */
export interface NoteMedia {
  kind: 'image' | 'video';
  label: string;
  src: string;
  caption: string;
  /** The name as the comment's own `[[attach:...]]` marker writes it, for placing it inline. */
  name: string;
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
 * What the agent said this is, when it said.
 *
 * Only what the comment declares. This used to guess from the prose - a body containing "bug" or
 * "regression" was a blocker, anything left over was a nit - and on the reviews these agents
 * actually write it was wrong in the one direction that matters. They write findings as prose: a
 * paragraph on what breaks, a link to the line, a recording. Nothing in that declares a severity,
 * so every comment fell through to `nit`, and a regression that silently stops an extension
 * receiving updates was labelled a triviality on the card.
 *
 * So: a conventional-comment tag at the front is believed, a comment that is shaped like a
 * question is a question, and everything else is a finding with no claim made about it. An
 * unlabelled finding reads as what it is - something the agent thinks you should look at - which
 * is both true and more use than a label that is false.
 */
export function severityOf(body: string): ReviewNote['severity'] {
  const text = String(body || '');
  const tagged = /^[\s*_>#-]*(nit|blocker|praise|question|suggestion|issue)\b\s*[:\u2014-]/i.exec(text);

  if (tagged) {
    const word = tagged[1].toLowerCase();

    return word === 'suggestion' ? 'nit' : word === 'issue' ? 'blocker' : word as ReviewNote['severity'];
  }

  // Shape rather than vocabulary: a comment that ends in a question mark is asking something.
  if (/\?\s*$/.test(text.trim())) {
    return 'question';
  }

  return 'finding';
}

/** The first line of a comment, which is how the agents write them: a sentence, then the detail. */
function titleOf(body: string): string {
  const first = String(body || '').split('\n').map((line) => line.trim()).find(Boolean) || '';

  return first.replace(/^[*_>#\s-]+/, '').slice(0, 120);
}

/** What the agent wrote about the change as a whole, with the attachment markers taken out. */
export function reviewBodyOf(comments: { status?: string; level?: string; body?: string }[]): string {
  const whole = comments.find((comment) => comment.status === 'pending' && comment.level === 'pr');

  /*
   * `[[attach:...]]` is a marker, not prose. It is how a comment refers to a file in the
   * workspace, and `reviews.ts` turns it into GitHub markdown at submit time; on the card the
   * files themselves are already drawn, as the strip of recordings above this. Left in, the
   * body reads "...both on the Generic import form: [[attach:demo-changes-censored.mp4]]".
   */
  return String(whole?.body || '').replace(/\[\[attach:[^\]]+\]\]/g, '').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Every comment the agent has written and not filed, with its code.
 *
 * The findings are line-level only: a comment on the pull request as a whole has no lines to
 * show, and the pass is about the ones that point at something. What it does have to show is
 * the review's own body, which is a pending comment like any other and was being dropped on
 * the floor here - `onBody` hands it back, because a review that is all body and no findings
 * is a real review and was drawing an empty card.
 */
export async function reviewNotes(
  pr: number,
  repo = DEFAULT_REPO,
  withCode?: (notes: ReviewNote[]) => void,
  onBody?: (body: string) => void,
): Promise<ReviewNote[]> {
  /*
   * The comments first, and the code they point at after.
   *
   * This awaited both together, so a pass with twelve findings showed none of them until GitHub
   * had sent the whole diff of the pull request - hundreds of milliseconds to seconds, against
   * about fifty for the comments, which are in-cluster. Only `hunk` needs the diff; the severity,
   * the title, the path and the line are all in the comment.
   *
   * So a caller that passes `withCode` is handed the findings as soon as they are readable and
   * called again with the same list once each one has its code. One that does not still gets the
   * complete list, at the old latency, because some callers have nowhere to put a second answer.
   */
  const comments = await listComments(pr).catch(() => [] as LocalComment[]);

  onBody?.(reviewBodyOf(comments));

  /*
   * The review's own comment, first in the list and a note like any other.
   *
   * It points at no line, so it was filtered out here and the pass never saw it. Drawing it as
   * a block above the findings fixed the blank card and lost everything else the list gives a
   * comment: selecting it, editing it, discussing it, deciding it. It is a pending comment with
   * an id, which is all any of those need - so it is a note, with no path, and the one thing
   * that makes it different is that there is no code to show beside it.
   */
  const whole = comments.find((comment) => comment.status === 'pending' && comment.level === 'pr');
  const pending = comments.filter((comment) => comment.status === 'pending' && comment.level === 'line' && comment.path);

  // Keyed on `path`, which is what this API calls it. It was `file.filename` - GitHub's own name
  // for the field, and not the one the dev API re-maps it to - so every lookup missed, every
  // comment got an empty hunk, and the pass drew no code at all. The whole claim of this surface
  // is that the code comes to the comment; it had quietly stopped being true.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const patchesOf = (detail: any) => new Map<string, DiffLine[]>((detail?.files || []).map((file: any) => [file.path || file.filename, parsePatch(file.patch || '')]));

  /** The attachments of a comment, as the pass draws them. */
  const mediaOf = (comment: LocalComment): NoteMedia[] => (comment.attachments || [])
    .filter((item) => item.found && item.kind !== 'file')
    .map((item) => ({
      kind:    item.kind === 'video' ? 'video' as const : 'image' as const,
      label:   item.name || item.path,
      src:     artifactUrl(pr, item.path),
      caption: item.caption || '',
      name:    item.name || String(item.path).split('/').pop() || item.path,
    }));

  /*
   * The review body as a note. `path: ''` is the whole of what marks it out, and the surface
   * reads that rather than a flag: a note with nowhere to point is one about the change itself.
   * Its text has the attachment markers taken out for the same reason `reviewBodyOf` does.
   */
  const rootNote = (): ReviewNote[] => (whole ? [{
    id:        `c${ whole.id }`,
    commentId: whole.id,
    pr,
    path:      '',
    line:      0,
    severity:  severityOf(whole.body),
    title:     titleOf(whole.body) || 'The review',
    body:      reviewBodyOf([whole]),
    hunk:      [] as DiffLine[],
    because:   whole.author && whole.author !== 'you' ? `written by ${ whole.author }` : '',
    media:     mediaOf(whole),
  }] : []);

  const build = (patches: Map<string, DiffLine[]>): ReviewNote[] => rootNote().concat(pending
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
        media:     mediaOf(comment),
      };
    }));

  const detailSoon = prDetail(pr, repo).catch(() => null);

  if (!withCode) {
    return build(patchesOf(await detailSoon));
  }

  detailSoon.then((detail) => {
    if (detail) {
      withCode(build(patchesOf(detail)));
    }
  }).catch(() => undefined);

  return build(new Map());
}
