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
 * new source be a line instead of thirty: see tasks/tubes-library-survey.md, which looked for
 * something off the shelf and concluded that the honest version of it is this. A new one reads:
 *
 *   export const thing = source(
 *     (id) => devFetch(`${ DEV_API }/thing/${ id }`),
 *     { name: 'thing', ttl: 30_000 },
 *   );
 *
 * and arrives with the sharing, the expiry, the retry-on-failure and a line in the log.
 *
 * Every read is also written to the product's log (dev-log.mjs) - which source, which key, how
 * long, and whether the answer was fresh, shared with a caller already waiting, or a failure.
 * That is the half of "what is this page doing" that cannot be reconstructed from the console,
 * because nothing was ever printed for a read that worked.
 *
 * Plain JavaScript, and the clock is an argument so the tests do not wait - see
 * tests/source-cache.test.mjs.
 */
import { log as devLog } from './dev-log.mjs';

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
 *   name  what this source is called in the log. A source with no name still works and is
 *         still logged; it is just harder to recognise, which is the only argument for the
 *         option being required-in-practice rather than required.
 *   log   where reads are recorded. The product's log by default; a test passes its own.
 */
export function source(load, {
  ttl = 30_000, keep = () => true, key = defaultKey, now = Date.now, name = '', log = devLog,
} = {}) {
  const held = new Map();

  const read = (...args) => {
    const id = key(...args);
    const found = held.get(id);
    const began = now();

    if (found && began - found.at < ttl) {
      log?.record({
        source: name, key: id, ms: 0, outcome: 'kept',
      });

      return found.value;
    }

    const value = (async() => load(...args))();

    held.set(id, { at: began, value });

    // One pass over the answer, doing both things that happen after it: the log line, and the
    // decision to keep it. Dropped on the way past rather than awaited - the caller still gets
    // this promise, and the next caller gets a fresh read. The entry is compared by identity, so
    // a read that was already replaced or forgotten while it was in flight does not remove its
    // successor.
    value.then(
      (got) => {
        const wanted = keep(got);

        log?.record({
          source: name, key: id, ms: now() - began, outcome: wanted ? 'read' : 'dropped',
        });
        if (!wanted && held.get(id)?.value === value) {
          held.delete(id);
        }
      },
      (e) => {
        log?.record({
          source: name, key: id, ms: now() - began, outcome: 'failed', detail: String(e?.message || e),
        });
        if (held.get(id)?.value === value) {
          held.delete(id);
        }
      },
    );

    return value;
  };

  /**
   * Change what is held for one set of arguments, without reading it again.
   *
   * For the case where the caller already knows the new value because it just made the change:
   * editing a pull request's own draft comment is a local write that answers with the comment
   * it wrote, and the only reason to re-read the pull request afterwards was to get that one
   * field back into this map. That re-read is half a dozen GitHub calls and up to twenty
   * seconds on a large pull request, paid every time somebody fixes a typo in a finding.
   *
   * `change` is given the held value and returns the new one; returning undefined keeps what
   * was there, so a change that cannot find what it meant to amend does nothing rather than
   * emptying the entry. Nothing is amended if nothing is held - there is no value to correct,
   * and inventing one would mean serving an answer this source never read. It does not reset
   * the age: an amended entry still expires when the read it came from would have.
   *
   * A held entry is a promise, so this chains rather than assigns, and a rejected one is left
   * exactly as it is: a failed read must not be turned into a successful one by an amendment.
   */
  read.amend = (change, ...args) => {
    const id = key(...args);
    const found = held.get(id);

    if (!found) {
      return false;
    }

    found.value = found.value.then((value) => {
      const next = change(value);

      return next === undefined ? value : next;
    });

    // The chain above must not become an unhandled rejection in its own right; the original
    // promise is still what callers hold, and they handle their own failures.
    found.value.catch(() => undefined);

    return true;
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
