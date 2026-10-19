/**
 * Reading something expensive, once.
 *
 * Every page in this product reads the same handful of things from the same handful of places,
 * and several of them ask at once: the workspace status and the rail's first column both want
 * the same pull request within a second of each other; a cold Focus deck fetched one Secret nine
 * times, because `githubToken()` goes through `secretValue` and nothing between them remembered
 * anything.
 *
 * So each call site grew its own answer, and they grew the same four rules, separately:
 *
 *   - keep the PROMISE, not the value, so calls that arrive together share one request;
 *   - keep it for a moment, not for ever;
 *   - do not keep a failure, so the next caller retries rather than inheriting a rejection;
 *   - let somebody who knows better throw it away - a token just pasted into Settings has to
 *     work on the next call.
 *
 * And then each added its own fifth rule, which is the reason this is a parameter rather than a
 * second copy: the Secret store never remembers an empty answer (its read swallows its own
 * failure and answers `{}`, and "no token is set" is the one wrong answer that looks like a
 * finished setup rather than a fault).
 *
 * That is all this is. Not a cache layer, not a data framework - the smallest thing that lets a
 * new source be a few lines instead of thirty: see tasks/tubes-library-survey.md, which looked
 * for something off the shelf and concluded that the honest version of it is this.
 *
 * Plain JavaScript and no imports, so `node --test` loads it directly, and the clock is an
 * argument so the tests do not wait - see tests/source-cache.test.mjs.
 */

/** JSON of the arguments: distinct for every distinct call, stable for the same one. */
function defaultKey(...args) {
  return args.length ? JSON.stringify(args) : '';
}

/**
 * A reader with the five rules above.
 *
 * `load` is the real read. The result is a function with the same arguments, plus:
 *   .forget(...args)  the entry for those arguments, dropped; no arguments, all of them
 *   .size()           how many entries are held, for a test or a diagnostic
 *
 * Options:
 *   ttl   how long an answer is good for, in ms. `Infinity` is "for the life of the page",
 *         which is right for things that do not change (a node's address) and wrong for
 *         everything else.
 *   keep  given the resolved value, whether it is worth remembering. The default keeps
 *         everything; a reader whose failure looks like a valid empty answer says so here.
 *   key   the cache key from the arguments, when JSON of them will not do.
 *   now   the clock, for tests.
 */
export function source(load, {
  ttl = 30_000, keep = () => true, key = defaultKey, now = Date.now,
} = {}) {
  const held = new Map();

  const read = (...args) => {
    const id = key(...args);
    const found = held.get(id);

    if (found && now() - found.at < ttl) {
      return found.value;
    }

    const value = (async() => load(...args))();

    held.set(id, { at: now(), value });

    // Dropped on the way past rather than awaited: the caller still gets this promise, and the
    // next caller gets a fresh read. Compared by identity, so a read that was already replaced
    // or forgotten while it was in flight does not remove its successor.
    value.then(
      (got) => {
        if (!keep(got) && held.get(id)?.value === value) {
          held.delete(id);
        }
      },
      () => {
        if (held.get(id)?.value === value) {
          held.delete(id);
        }
      },
    );

    return value;
  };

  read.forget = (...args) => {
    if (!args.length) {
      held.clear();

      return;
    }
    held.delete(key(...args));
  };

  read.size = () => held.size;

  return read;
}
