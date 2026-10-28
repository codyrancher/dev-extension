// Putting a prompt into a claude pane, and knowing whether it went in.
//
// One copy, because there were two and the second kept the bug the first had fixed. Both the
// rail's actions (conversations.ts, sendToPane) and the chat's own composer (chat-conversation
// .ts, say) paste into a tmux pane and press Enter, and both used to decide it had worked by
// one question: is the message still in the composer? A no was read as "it was submitted".
//
// A no also means "it was never there". Measured on pr-19714: the pane had just auto-compacted
// while idle, the paste reached nothing, the composer stayed empty - and the very first look
// said SENT, under a banner reading "The agent is reviewing the new commits". Two hours later
// the pane still read `❯` with nothing in it and the conversation had no such turn.
//
// So arrival is established before departure is asked about, and the hook's own log - which
// records one line per prompt claude accepts - is the first thing consulted rather than the
// last resort.

/** Six turns of roughly a second: long enough for a TUI to redraw, short enough for a click. */
const TRIES = 6;

/**
 * The shell for one send, as lines. Ends by echoing exactly one word: see PANE_SEND_RESULTS.
 *
 * @param {object} o
 * @param {string} o.pane The tmux target, quoted as the host needs it.
 * @param {string} o.file The file holding the text to paste.
 * @param {string} o.frag The file holding the probe - enough of the first line to recognise.
 * @param {string} o.events The pane's hook log, or '' when the host cannot name it.
 * @param {string} [o.buffer] The tmux buffer name to paste from.
 * @param {string} [o.as] A prefix that runs tmux as the pane's user ('' when already them).
 * @returns {string[]}
 */
export function paneSendScript({
  pane, file, frag, events, buffer = 'mc-send', as = '',
}) {
  const tmux = `${ as }tmux`;
  // Without a log to read, the two checks that need it are left out rather than faked: the
  // script then rests on the composer alone, which is all it ever had.
  const took = events
    ? [
      `  after=$(wc -c < ${ events } 2>/dev/null || echo 0)`,
      `  if [ "$after" != "$before" ] && tail -3 ${ events } 2>/dev/null | grep -q UserPromptSubmit; then done_ SENT; fi`,
    ]
    : [];

  return [
    `done_() { rm -f ${ file } ${ frag }; echo "$1"; exit 0; }`,
    // How long the hook's log is before anything is pasted, so a line appended to it below is
    // this prompt being accepted and not one from a minute ago.
    events ? `before=$(wc -c < ${ events } 2>/dev/null || echo 0)` : 'before=0',
    /*
     * What the bottom of the pane says before the paste.
     *
     * The weaker of the two arrival signals and the one that covers the case the probe cannot:
     * a paste big enough for the CLI to fold into `[Pasted text #1 +40 lines]` never puts its
     * own first line on screen. It still changes the composer, and a pane this is being typed
     * into is an idle or waiting one, so a bottom that is byte-for-byte what it was is a pane
     * that took nothing at all.
     */
    `start=$(${ tmux } capture-pane -p -t ${ pane } 2>/dev/null | tail -6)`,
    `${ tmux } load-buffer -b ${ buffer } ${ file } 2>/dev/null || done_ NOBUFFER`,
    `${ tmux } paste-buffer -b ${ buffer } -t ${ pane } -d -p 2>/dev/null || done_ NOPANE`,
    'seen=no',
    'moved=no',
    'n=0',
    `while [ $n -lt ${ TRIES } ]; do`,
    '  sleep 0.4',
    ...took,
    `  screen=$(${ tmux } capture-pane -p -t ${ pane } 2>/dev/null) || done_ NOPANE`,
    `  [ "$(printf '%s\\n' "$screen" | tail -6)" = "$start" ] || moved=yes`,
    `  if printf '%s\\n' "$screen" | grep -qF -f ${ frag }; then`,
    '    seen=yes',
    // It was on screen and is not now, and the composer is the only place it was: entered.
    '  elif [ "$seen" = yes ]; then',
    '    done_ SENT',
    '  fi',
    // Press, then look next time round: the paste has to have been read before Enter means
    // anything. An extra press on an empty composer submits nothing, so pressing again costs
    // nothing and is the only way past a TUI that swallowed the first one.
    `  ${ tmux } send-keys -t ${ pane } Enter 2>/dev/null || done_ NOPANE`,
    '  sleep 0.5',
    '  n=$((n+1))',
    'done',
    // Something arrived and no prompt was recorded: it is sitting there. Which is a safe thing
    // to be wrong about - the person opens the conversation and sees either the text or the
    // turn - where "sent" over a pane that took nothing is not.
    '[ "$seen" = yes ] || [ "$moved" = yes ] && done_ STUCK',
    'done_ NOTTYPED',
  ];
}

/** Every word the script can end with, and whether it means the prompt is with claude. */
export const PANE_SEND_RESULTS = ['SENT', 'NOBUFFER', 'NOPANE', 'STUCK', 'NOTTYPED'];
