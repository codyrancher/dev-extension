/**
 * A pull request's description, as something you can act on rather than read.
 *
 * The column already counted the boxes - "7 of 9 boxes ticked" - and then drew the list with
 * every box greyed out, because that is what a markdown renderer does with a task list: an
 * `<input type="checkbox" disabled>`. So the one piece of a pull request that is a form, and
 * the thing a draft is usually waiting on, was the one piece you had to go to GitHub to touch.
 *
 * Ticking a box means rewriting the description, so the hard part is not the click: it is
 * knowing which `[ ]` in the markdown the box you pressed corresponds to. The renderer's boxes
 * and the source's brackets have to be counted the same way, and the places they can disagree
 * are the interesting ones:
 *
 *   - a fenced code block holding `- [ ]` renders as text, not a box, so it must not be counted;
 *   - a bracket that is not a task item (`[ ]` mid-sentence, a `[link]`) is not a box either;
 *   - `- [X]`, `* [ ]`, `+ [x]` and an indented sub-item are all task items.
 *
 * So the source is scanned here with those rules, and the renderer's boxes are numbered in the
 * same order - see `numberTaskBoxes`. The Nth box the person pressed is then the Nth position
 * this found, and nothing else in the description is touched: the rewrite replaces one
 * character, which is what makes it safe to PUT back a description somebody else may be editing.
 *
 * Plain JavaScript and no imports, so `node --test` loads it directly - see tests/pr-body.test.mjs.
 */

/** A task item: list marker, then a bracket holding a space or an x. */
const TASK = /^(\s*(?:[-*+]|\d+[.)])\s+\[)([ xX])(\])/;

/**
 * Where each task box is in the source, in the order a renderer would draw them.
 *
 * Returns one entry per box: the index of the character inside the brackets, and whether it is
 * ticked. Lines inside a fenced code block are skipped, because the renderer draws them as code.
 */
export function taskPositions(body) {
  const text = String(body || '');
  const found = [];
  let at = 0;
  let fence = '';

  for (const line of text.split('\n')) {
    const open = /^\s*(```+|~~~+)/.exec(line);

    if (fence) {
      // Closed by a fence of the same kind, at least as long as the one that opened it.
      if (open && open[1][0] === fence[0] && open[1].length >= fence.length) {
        fence = '';
      }
    } else if (open) {
      fence = open[1];
    } else {
      const task = TASK.exec(line);

      if (task) {
        found.push({ at: at + task[1].length, done: task[2].toLowerCase() === 'x' });
      }
    }
    at += line.length + 1;
  }

  return found;
}

/**
 * The description with its Nth box toggled, or unchanged when there is no Nth box.
 *
 * One character replaced. A rewrite that re-rendered the markdown would also reformat whatever
 * the author wrote - their line breaks, their HTML comments, the template's own spacing - which
 * is a diff nobody asked for on a document several people are editing.
 */
export function toggleTask(body, n) {
  const boxes = taskPositions(body);
  const box = boxes[n];

  if (!box) {
    return String(body || '');
  }
  const text = String(body);

  return text.slice(0, box.at) + (box.done ? ' ' : 'x') + text.slice(box.at + 1);
}

/** How many boxes there are and how many are ticked. The column's "7 of 9" line. */
export function taskCount(body) {
  const boxes = taskPositions(body);

  return { ticked: boxes.filter((box) => box.done).length, total: boxes.length };
}

/**
 * The rendered task boxes, numbered and live.
 *
 * A markdown renderer writes `<input type="checkbox" disabled>` for a task item. They are
 * numbered here in document order - the same order `taskPositions` counts - and the `disabled`
 * is dropped, so the column can hand a press back as "box 4".
 *
 * Only the boxes a task list produced: the attribute is added to inputs this finds in the
 * rendered HTML, and a description cannot put an `<input>` of its own in, because the renderer
 * escapes raw HTML it does not trust.
 */
export function numberTaskBoxes(html) {
  let n = 0;

  return String(html || '').replace(/<input([^>]*?type="checkbox"[^>]*?)>/g, (whole, attrs) => {
    const cleaned = attrs.replace(/\s*disabled(?:="[^"]*")?/g, '');

    return `<input${ cleaned } data-task="${ n++ }">`;
  });
}
