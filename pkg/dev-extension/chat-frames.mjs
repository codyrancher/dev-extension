/**
 * The wire between a pane and the chat view.
 *
 * Everything the view needs about a conversation - which transcript, how long it is, the bytes
 * since the last read, each subagent's last line, the hook's state file, whether claude is
 * running, and the terminal itself - arrives as one string: the output of one script run in the
 * pod. There is no second channel, so the pieces have to be framed inside that string, and this
 * is the frame.
 *
 * It was `@@DATA` ... `@@ENDDATA`, found with `indexOf`, and the bug in that is the thing being
 * framed: a transcript is a record of a conversation, and a conversation about this code quotes
 * the markers. One `@@ENDDATA` anywhere in the last megabyte of transcript ended the block early,
 * so the view silently lost everything after it - and the conversations most likely to hit it are
 * the ones held while working on the chat view, which is exactly where it would be noticed and
 * blamed on something else.
 *
 * So every marker carries a nonce the caller makes fresh for each read. The transcript was
 * written before the nonce existed and cannot contain it; an older nonce quoted in the transcript
 * belongs to no live frame and is inert. The parsing is here, in one place, with the script that
 * writes it (chat-conversation.ts) naming the same markers from `markers()`.
 *
 * Plain JavaScript and no imports, so `node --test` loads it directly - see tests/chat-frames.test.mjs.
 */

/** A fresh token for one read: lowercase alphanumeric, so it is safe in a shell word and a regex. */
export function frameNonce() {
  const bytes = new Uint8Array(8);

  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }

  return Array.from(bytes, (b) => b.toString(36).padStart(2, '0')).join('');
}

/**
 * The marker for one frame, as both halves write it.
 *
 * The script interpolates `$N` for the nonce rather than the value, so the markers in the script
 * read the way they do here; `markers(nonce)` is what the parser matches.
 */
export function markers(nonce) {
  const tag = (name) => `@@${ name }-${ nonce }`;

  return {
    file:   tag('FILE'),
    size:   tag('SIZE'),
    data:   tag('DATA'),
    endData: tag('ENDDATA'),
    ssize:  tag('SSIZE'),
    sdata:  tag('SDATA'),
    endSData: tag('ENDSDATA'),
    tail:   tag('TAIL'),
    endTails: tag('ENDTAILS'),
    hook:   tag('HOOK'),
    endHook: tag('ENDHOOK'),
    alive:  tag('ALIVE'),
    pane:   tag('PANE'),
    noPane: tag('NOPANE'),
  };
}

/** The text between an opening marker's line and its closing marker, or null when absent. */
function between(out, open, close) {
  const at = out.indexOf(`${ open }\n`);

  if (at < 0) {
    return null;
  }
  const from = at + open.length + 1;
  const end = out.indexOf(`\n${ close }`, from);

  return end < from ? null : out.slice(from, end);
}

/** The number on a `@@SIZE-<nonce> 1234` line, or 0. */
function value(out, marker) {
  const found = new RegExp(`${ marker } (\\d+)`).exec(out);

  return found ? Number(found[1]) : 0;
}

/**
 * One read, taken apart.
 *
 * Every field says what the read found, and an absent frame is distinguishable from an empty one:
 * `data` and `sdata` are null when the script wrote no block at all (nothing new to send), and
 * `hook` is undefined when there was no state file or it was caught half-written - the caller
 * keeps what it had - against null for a file that is there and empty.
 */
export function readFrames(out, nonce) {
  const m = markers(nonce);
  const paneAt = out.indexOf(`${ m.pane }\n`);
  const paneText = paneAt >= 0 ? out.slice(paneAt + m.pane.length + 1) : '';
  const attached = paneAt >= 0 && !paneText.includes(m.noPane);
  const fileLine = new RegExp(`${ m.file }(.*)`).exec(out);

  let hook;

  const hookText = between(out, m.hook, m.endHook);

  if (hookText !== null) {
    const raw = hookText.trim();

    if (!raw) {
      hook = null;
    } else {
      try {
        hook = JSON.parse(raw);
      } catch { /* half-written; the next read gets a whole one */ }
    }
  }

  return {
    file:  fileLine ? fileLine[1].trim() : '',
    size:  value(out, m.size),
    data:  between(out, m.data, m.endData),
    ssize: value(out, m.ssize),
    sdata: between(out, m.sdata, m.endSData),
    tails: readTails(out, m),
    hook,
    // Before the pane's own text, so a terminal showing the word cannot claim claude is running.
    alive: attached && out.slice(0, paneAt).includes(m.alive),
    attached,
    // A pane that is not there has no text; the sentinel is the script's answer, not a terminal.
    pane:  attached ? paneText : '',
  };
}

/**
 * Each subagent's last assistant line: `@@TAIL-<nonce> <id> <mtime>` and then the line itself.
 *
 * Returned raw, because what is made of it - the tool summary, the first line, the 140 characters
 * - is the list's business and not the wire's.
 */
function readTails(out, m) {
  const at = out.indexOf(`${ m.tail } `);
  const end = out.indexOf(m.endTails);

  if (at < 0 || end < at) {
    return [];
  }

  return out.slice(at, end).split(`${ m.tail } `).slice(1).map((chunk) => {
    const [head, ...rest] = chunk.split('\n');
    const [id, mtime] = head.trim().split(/\s+/);

    return { id: id || '', at: Number(mtime) || 0, raw: rest.join('\n').trim() };
  }).filter(({ id }) => id);
}
