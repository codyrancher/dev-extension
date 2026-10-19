/**
 * What this product did, written down where a person can see it.
 *
 * Nine places called `console.warn` or `console.error` with a `[dev]` prefix, each one the only
 * record that something failed - a status that could not be read, a workspace that could not be
 * prepared, a certificate controller that would not go on. That is a log, in the sense that the
 * lines exist; it is not a log anybody reads, because reading it means knowing to open devtools
 * before the thing happens again.
 *
 * So: one ring, every line through it, and a page that can show it. The console still gets
 * everything - a browser's own log is where a developer looks, and taking that away to make a
 * point would be a worse product - but the lines are also kept, in order, with their scope, so
 * the question "why is this page empty?" has an answer inside the page.
 *
 * The data reads go through it too, from source-cache.mjs: which source, which key, how long,
 * and whether the answer was fresh, shared with a caller already waiting, or a failure. That is
 * the half that cannot be reconstructed from the console, because nothing was ever printed for
 * a read that worked.
 *
 * A ring, not a list: a page open all afternoon makes thousands of reads, and the interesting
 * ones are always the last few. `makeLog` exists so the tests can hold the clock; everything in
 * the product uses the shared `log` below.
 *
 * Plain JavaScript and no imports, so `node --test` loads it directly - see tests/dev-log.test.mjs.
 */

/** How many lines are kept. Two hundred is a few minutes of a busy page. */
export const LOG_KEEP = 200;

/**
 * A log.
 *
 * `note(scope, what, detail)` is the one for things that went wrong, and echoes to the console
 * the way the calls it replaces did. `record(entry)` is the one for everything a machine writes -
 * the reads - and is silent, because a line per read in the console is a console nobody can use.
 */
export function makeLog({ now = Date.now, keep = LOG_KEEP, console: out = null } = {}) {
  const lines = [];
  const watchers = new Set();

  function push(entry) {
    const line = { at: now(), ...entry };

    lines.push(line);
    if (lines.length > keep) {
      lines.splice(0, lines.length - keep);
    }
    for (const watcher of watchers) {
      try {
        watcher(line);
      } catch { /* a watcher that throws is not the log's problem, and must not lose the line */ }
    }

    return line;
  }

  return {
    /** Something went wrong, said once, kept and printed. `detail` is usually the error. */
    note(scope, what, detail) {
      const line = push({
        kind: 'note', scope, what, detail: detail === undefined ? '' : String(detail?.message || detail),
      });

      if (out) {
        out.warn(`[${ scope }] ${ what }`, detail ?? '');
      }

      return line;
    },

    /** A read happened. Silent: the console is for what went wrong. */
    record(entry) {
      return push({ kind: 'read', ...entry });
    },

    /** Newest first, because that is the end anybody reads. */
    lines(limit = keep) {
      return lines.slice(-limit).reverse();
    },

    /** Someone watching for new lines, so a page open on the log fills as things happen. */
    watch(fn) {
      watchers.add(fn);

      return () => watchers.delete(fn);
    },

    clear() {
      lines.length = 0;
    },

    size() {
      return lines.length;
    },
  };
}

/** The product's log. One per page load; nothing outlives the tab. */
export const log = makeLog({ console: typeof console === 'undefined' ? null : console });

/** The shorthand the call sites use, so a line is `note('dev', 'what failed', e)`. */
export function note(scope, what, detail) {
  return log.note(scope, what, detail);
}
