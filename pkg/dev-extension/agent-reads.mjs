/**
 * The two agent-pod reads that were still execs, as scripts both halves can run.
 *
 * Same arrangement as chat-read.mjs, and for the same reason: the browser imports this to run
 * the script over `pods/exec`, and the pod's state service imports the very same module to run
 * it in-process. One definition, so the two paths cannot drift into answering differently - the
 * thing that matters most about a read with two routes to it.
 *
 * Why these two and not the rest: everything left on exec is either a write, where an exit code
 * is worth the socket, or something somebody clicked. These two ran on a timer, for ever, on
 * every open page - the last reads doing that.
 */

/** The agent pod's durable directory and the home inside it. Spelled here so the pod needs nothing. */
const AGENT_WORKSPACE = '/workspace';
const AGENT_HOME = `${ AGENT_WORKSPACE }/.home`;
const PATH_LINE = 'export PATH=/workspace/.home/.local/bin:/usr/local/bin:/usr/bin:/bin:$PATH';

/**
 * Conversations that were told what to do and never started.
 *
 * A prompt waits in `.queue` from the moment a button is pressed until a pane takes it. If the
 * tab that pressed it goes away first - a reload, a close, a Rancher that restarted under the
 * wait - nothing finishes the job, so any page of the product picks it up later. That is why it
 * runs on a timer and why it keeps running when the queue is empty: an empty answer is the
 * answer, and it is only interesting on the one poll where it stops being empty.
 *
 * tmux is asked as the pane's own user, because a tmux server belongs to a user and root's has
 * nothing in it.
 */
export function queuedScript() {
  return [
    PATH_LINE,
    `for f in ${ AGENT_WORKSPACE }/.queue/*; do`,
    '  [ -f "$f" ] || continue',
    '  id=$(basename "$f")',
    '  if [ "$(id -u)" = 0 ]; then setpriv --reuid=1000 --regid=1000 --init-groups env HOME=/workspace/.home tmux has-session -t "mc-$id" 2>/dev/null || echo "$id"; else tmux has-session -t "mc-$id" 2>/dev/null || echo "$id"; fi',
    'done',
  ].join('\n');
}

/**
 * The last thing the agent actually said about a workspace.
 *
 * The newest transcript in that workspace's project directory, read backwards for the last
 * assistant turn with text a person would read - no sidechains, no meta, and nothing opening
 * with a tag, which is how the tool chatter and the hook summaries announce themselves.
 *
 * `node -e` rather than shell, because this is JSON per line and the alternative is a grep that
 * is wrong on any message containing a brace. The output is two lines: `@@FILE <path>` so the
 * caller knows which conversation said it, then the JSON.
 *
 * @param workdir The workspace's checkout - what a conversation about it starts in. claude keys
 *   its transcript directory off that path with the slashes turned into dashes.
 */
export function reportScript(workdir) {
  const dir = `${ AGENT_HOME }/.claude/projects/${ String(workdir).replace(/\//g, '-') }`;
  const js = [
    'const fs=require("fs");const f=process.argv[1];const lines=fs.readFileSync(f,"utf8").split("\\n");',
    'let out=null;for(let i=lines.length-1;i>=0&&!out;i--){let e;try{e=JSON.parse(lines[i])}catch{continue}',
    'if(e.type!=="assistant"||e.isSidechain||e.isMeta)continue;const c=e.message&&e.message.content;if(!Array.isArray(c))continue;',
    'const t=c.filter(b=>b.type==="text"&&b.text&&b.text.trim()&&!/^</.test(b.text.trim())).map(b=>b.text).join("\\n").trim();',
    'if(t)out={at:e.timestamp||"",text:t.slice(0,2000)}}',
    'process.stdout.write(JSON.stringify(out));',
  ].join('');

  return [
    PATH_LINE,
    `f=$(ls -t ${ dir }/*.jsonl 2>/dev/null | head -1)`,
    '[ -n "$f" ] || { echo null; exit 0; }',
    'echo "@@FILE $f"',
    `node -e '${ js.replace(/'/g, "'\\''") }' "$f"`,
  ].join('\n');
}
