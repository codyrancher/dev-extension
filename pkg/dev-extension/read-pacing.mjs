/**
 * Two ways of asking a workspace's pod less often, each worth an exec saved per use.
 *
 * Reads a page repeats cost a WebSocket and a forked process in somebody's pod. These are small and
 * have no dependencies, so the tests run them as they are.
 */

/**
 * One read per key, shared while it runs and for `freshMs` after it lands.
 *
 * Counted from the landing rather than the asking, so a slow read does not use up its own window.
 * A failure is not remembered: the next caller may as well try again.
 *
 * @returns A function taking the key, with `.forget(key)` for when the answer is known to be old.
 */
export function sharedRead(read, freshMs) {
  const asked = new Map();

  const ask = (key) => {
    const held = asked.get(key);

    if (held && (!held.landed || Date.now() - held.landed < freshMs)) {
      return held.answer;
    }

    const entry = { landed: 0, answer: null };

    entry.answer = Promise.resolve().then(() => read(key));
    asked.set(key, entry);
    entry.answer.then(() => {
      entry.landed = Date.now();
    }, () => {
      if (asked.get(key) === entry) {
        asked.delete(key);
      }
    });

    return entry.answer;
  };

  ask.forget = (key) => asked.delete(key);

  return ask;
}

/**
 * Run something on a beat, only while the page can be seen, and once on coming back if a beat or
 * more went by without it.
 *
 * The beat restarts on that return, so the read it caused is not followed straight away by another.
 *
 * @returns A function that stops it.
 */
export function everyWhileShown(run, everyMs, doc = document) {
  let last = Date.now();
  let timer = null;

  const tick = () => {
    if (doc.visibilityState === 'hidden') {
      return;
    }
    last = Date.now();
    run();
  };

  const onChange = () => {
    if (doc.visibilityState === 'hidden' || Date.now() - last < everyMs) {
      return;
    }
    clearInterval(timer);
    timer = setInterval(tick, everyMs);
    tick();
  };

  timer = setInterval(tick, everyMs);
  doc.addEventListener('visibilitychange', onChange);

  return () => {
    clearInterval(timer);
    doc.removeEventListener('visibilitychange', onChange);
  };
}
