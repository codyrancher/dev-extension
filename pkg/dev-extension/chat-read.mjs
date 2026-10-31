/**
 * The one read a chat makes, as a script.
 *
 * Everything the view needs about a conversation - which transcript, how long it is, the bytes
 * since the last read, each subagent's last line, the hook's state file, whether the CLI is
 * running, and the pane itself - is one script producing one string, framed by the markers in
 * chat-frames.mjs. This builds that script.
 *
 * It lived inside `poll()` in chat-conversation.ts, which was fine while the browser was the
 * only thing that ran it. The pod runs it now too - over HTTP, instead of the browser opening
 * a WebSocket and forking a process every 1.5 seconds - and two copies of a hundred lines of
 * shell is the kind of thing that is identical on the day it is written and never again. So it
 * is one function with seven arguments, and both callers are the same caller.
 *
 * Pure and importless, so `node --test` loads it directly and `scripts/gen-chat-read.mjs` can
 * render it into the seed.
 */

/**
 * @param {object} at
 * @param {string} at.id      The pane's id, e.g. `p-lte-issue-14904-1`.
 * @param {number|string} at.off   Bytes of the main transcript already read; 0 for a first read.
 * @param {string} at.sub     The subagent being followed, or '' for the main conversation.
 * @param {number|string} at.soff  Bytes of that subagent's transcript already read.
 * @param {string} at.nonce   This read's marker token. See frameNonce in chat-frames.mjs.
 * @param {string} at.projKey claude's directory name for the working directory.
 * @param {string} at.cli     Which CLI holds the pane: `claude` or `agy`.
 * @returns {string} A shell script whose stdout is the framed read.
 */
export function chatReadScript({ id, off, sub, soff, nonce, projKey, cli }) {
  return [
    // CAP bounds the FIRST read of a transcript. A conversation that has run for hours has a
    // transcript of many megabytes, and shipping the whole of it through one exec (base64
    // over the WebSocket, inside the poll's timeout) does not arrive - so the @@DATA block
    // never lands whole, parseTranscript sees nothing, and the chat sits on "Nothing has been
    // said yet." even though the pane (read separately, below) is full. So on the first read
    // (OFF is 0) only the last CAP bytes are taken: the recent history, which is what the
    // view is for, small enough to arrive every time. A partial first line from cutting
    // mid-file is dropped by parseTranscript, and the browser sets its offset to the true
    // size, so every read after this one is just the delta.
    `ID=${ JSON.stringify(id) }; OFF=${ off }; SUB=${ JSON.stringify(sub) }; SOFF=${ soff }; CAP=1048576; N=${ JSON.stringify(nonce) }`,
    `PROJ="$HOME/.claude/projects/${ projKey }"`,
    'uuid=$(cat "$(dirname "$HOME")/sessions/$ID.id" 2>/dev/null)',
    'FILE=""',
    /*
     * Where the transcript is, which is the one thing about reading a conversation that the
     * CLI decides.
     *
     * claude keeps one file per conversation in a directory named for the working directory;
     * agy keeps a directory per conversation with the transcript inside it. Both are found
     * from the same id file - the pane writes it (claude-session.sh, agy-session.sh) - so the
     * difference here is a path and nothing else.
     *
     * Without an id file, claude falls back to the directory's transcript - but only one no
     * other conversation has claimed. Conversations share a working directory, because every
     * conversation of a workspace runs in its checkout, so "the newest transcript" is
     * somebody else's as often as not.
     *
     * "Exactly one transcript" was the guard and it is not enough. A workspace with two
     * conversations where only the first has ever run has exactly one transcript, and the
     * second - which has no id file, because it has never started - was handed the first's.
     * Two tabs, the same history under both, which is what it looks like from outside.
     *
     * So the candidate is refused when another conversation's `.id` file names it. Those
     * files hold the transcript's uuid, so this asks the question directly and without
     * taking an id apart in shell - the thing conversation-id.mjs exists so that nothing
     * does. The case the fallback is actually for still works: a conversation whose id file
     * has not landed yet, in a workspace where nothing else claims the transcript.
     *
     * agy gets no such fallback at all: its id lives in a map keyed by that shared
     * directory, so the guess there is not "probably somebody else's" but "certainly whoever
     * ran last" - see claimed_elsewhere in agy-session.sh.
     */
    ...(cli === 'agy' ? [
      'BRAIN="$HOME/.gemini/antigravity-cli/brain"',
      'if [ -n "$uuid" ] && [ -f "$BRAIN/$uuid/.system_generated/logs/transcript.jsonl" ]; then FILE="$BRAIN/$uuid/.system_generated/logs/transcript.jsonl"; fi',
    ] : [
      'if [ -n "$uuid" ] && [ -f "$PROJ/$uuid.jsonl" ]; then FILE="$PROJ/$uuid.jsonl";',
      'elif [ "$(ls "$PROJ"/*.jsonl 2>/dev/null | wc -l)" -eq 1 ]; then',
      '  CAND=$(ls "$PROJ"/*.jsonl 2>/dev/null | head -1); CU=$(basename "$CAND" .jsonl)',
      '  SESS="$(dirname "$HOME")/sessions"',
      '  if ! grep -lFx "$CU" "$SESS"/*.id 2>/dev/null | grep -qv "^$SESS/$ID\.id$"; then FILE="$CAND"; fi',
      'fi',
    ]),
    'echo "@@FILE-$N $FILE"',
    'if [ -n "$FILE" ] && [ -f "$FILE" ]; then size=$(wc -c < "$FILE"); echo "@@SIZE-$N $size"; FROM=$OFF; if [ "$OFF" -eq 0 ] && [ "$size" -gt "$CAP" ]; then FROM=$((size - CAP)); fi; echo "@@FROM-$N $FROM"; if [ "$size" -gt "$FROM" ]; then echo "@@DATA-$N"; tail -c +$((FROM+1)) "$FILE"; echo; echo "@@ENDDATA-$N"; fi; fi',
    /*
     * The chosen subagent's own transcript, capped the same way as the session's.
     *
     * claude keeps them beside the session's file, in a directory named for it. agy gives
     * each subagent a brain of its own - a directory under the same root as the parent's,
     * named for the subagent's conversation id - so there is no "beside" to point at, only
     * another session read exactly like this one.
     */
    ...(cli === 'agy' ? [
      'if [ -n "$SUB" ]; then SF="$BRAIN/$SUB/.system_generated/logs/transcript.jsonl"; fi',
    ] : [
      'if [ -n "$SUB" ] && [ -n "$FILE" ]; then SF="${FILE%.jsonl}/subagents/agent-$SUB.jsonl"; fi',
    ]),
    'if [ -n "$SF" ] && [ -f "$SF" ]; then ssize=$(wc -c < "$SF"); echo "@@SSIZE-$N $ssize"; SFROM=$SOFF; if [ "$SOFF" -eq 0 ] && [ "$ssize" -gt "$CAP" ]; then SFROM=$((ssize - CAP)); fi; if [ "$ssize" -gt "$SFROM" ]; then echo "@@SDATA-$N"; tail -c +$((SFROM+1)) "$SF"; echo; echo "@@ENDSDATA-$N"; fi; fi',
    /*
     * Every subagent's last line and when it was written, for the list of them.
     *
     * The head line carries the subagent's NAME after its mtime for agy, because that is
     * the only place agy says what one is for: claude names a subagent in the Agent call
     * that started it, which the transcript already has, and agy records it in a file of
     * its own - `{"subagentDescriptor":{"typeName":"repro-recorder","role":"Misc bug
     * recorder"}}`. The reader takes everything after the mtime as the name, so claude's
     * lines, which have nothing after it, are unchanged.
     *
     * NOTE the quoting. This grep used to be written `grep "\"type\":\"assistant\""`,
     * and in a single-quoted JavaScript string `\"` is just `"` - so the shell was handed
     * `grep ""type":"assistant""`, which it concatenates into the pattern `type:assistant`.
     * That matches nothing in a transcript, so every subagent's last line has been empty
     * since this was written; only the mtime beside it (and so "6 working") ever worked.
     * Single quotes inside a template literal, which survive both languages intact.
     */
    ...(cli === 'agy' ? [
      'SUBS="$BRAIN/$uuid/.system_generated/subagents"',
      'if [ -n "$uuid" ] && [ -d "$SUBS" ]; then for f in "$SUBS"/*.json; do [ -f "$f" ] || continue; id=$(basename "$f" .json); T="$BRAIN/$id/.system_generated/logs/transcript.jsonl"; [ -f "$T" ] || continue;',
      /*
       * The backslashes are doubled on purpose.
       *
       * A template literal refuses `\(` as an invalid escape and `\1` as an octal one, and
       * a single-quoted string - how the broken grep above was written - drops the
       * backslash silently and hands sed a pattern with no group in it. `\\(` in the
       * source is `\(` in the string, which is what sed's BRE wants.
       */
      `  role=$(sed -n 's/.*"role":"\\([^"]*\\)".*/\\1/p' "$f" | head -1)`,
      '  echo "@@TAIL-$N $id $(stat -c %Y "$T") $role"',
      `  tail -c 6000 "$T" | grep -F '"source":"MODEL"' | tail -n 1 | cut -c1-3000`,
      'done; echo "@@ENDTAILS-$N"; fi',
    ] : [
      'if [ -n "$FILE" ] && [ -d "${FILE%.jsonl}/subagents" ]; then for f in "${FILE%.jsonl}"/subagents/agent-*.jsonl; do [ -f "$f" ] || continue; id=$(basename "$f" .jsonl); id=${id#agent-}; echo "@@TAIL-$N $id $(stat -c %Y "$f")";',
      `  tail -c 6000 "$f" | grep -F '"type":"assistant"' | tail -n 1 | cut -c1-3000`,
      'done; echo "@@ENDTAILS-$N"; fi',
    ]),
    // The hook state file (seed/chat-hook.mjs): the last thing claude said it was doing.
    'echo "@@HOOK-$N"; cat "$(dirname "$HOME")/sessions/$ID.state.json" 2>/dev/null; echo; echo "@@ENDHOOK-$N"',
    /*
     * Whether the CLI is running in the pane at all. The pane's own command is the loop that
     * runs it (claude-session.sh, agy-session.sh), so the CLI is that loop's child - and a
     * pane with the loop but no child is a shell, whatever the transcript's last line says.
     *
     * The program's name is the CLI's: this asked for `claude` on every pane, so an
     * Antigravity pane with agy running in it reported nothing, and the chat said
     * "Antigravity is not running in this pane" under a conversation that was answering.
     */
    `if tmux has-session -t "mc-$ID" 2>/dev/null; then P=$(tmux display -p -t "mc-$ID" "#{pane_pid}" 2>/dev/null); [ -n "$P" ] && pgrep -P "$P" -x ${ cli } >/dev/null 2>&1 && echo "@@ALIVE-$N"; fi`,
    'echo "@@PANE-$N"',
    'if tmux has-session -t "mc-$ID" 2>/dev/null; then tmux capture-pane -p -t "mc-$ID" | tail -n 40; else echo "@@NOPANE-$N"; fi',
  ].join('\n');
}
