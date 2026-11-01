/**
 * The two agent-pod reads that were still execs, as scripts both halves can run.
 *
 * Same arrangement as chat-read.mjs, and for the same reason: the browser imports this to run
 * the script over `pods/exec`, and the pod's state service imports the very same module to run
 * it in-process. One definition, so the two paths cannot drift into answering differently - the
 * thing that matters most about a read with two routes to it.
 *
 * It started with the two reads that ran on a timer, for ever, on every open page, and now also
 * holds the ones every page load made once. What stays on exec is a write, where an exit code is
 * worth the socket, or a read of something only the workspace's own pod can see.
 *
 * Nothing here may run a tool over a workspace's checkout. The agent pod is cluster-admin and a
 * tree's contents are whatever last ran in that workspace, so git on a tree belongs in the
 * workspace's pod: see readBranch in workspace-rail.ts. A chat's reads differ only in that the
 * pane they read already runs in this pod, as this user, and the exec they replace did too.
 *
 * Every script here takes values that have already been checked. The service checks them with
 * its regexes before they get this far, and the browser's come from the pod's own answers.
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

/** What claude says it can be set to, on its own: the slow half of `optionsScript`. */
export function optionsHelpScript() {
  return [
    'echo @@HELP',
    'claude --help 2>/dev/null',
  ].join('\n');
}

/**
 * The help without its marker, for the service to keep, and nothing kept when there is none.
 *
 * A pod still installing claude prints nothing, and that must not be remembered for ten minutes.
 */
export function optionsHelpRead() {
  return 'out=$(claude --help 2>/dev/null); [ -n "$out" ] || exit 3; printf \'%s\\n\' "$out"';
}

/**
 * What decides a new session's model and effort: the pane's argv, the environment and the two
 * settings files. The fast half of `optionsScript`, which must never be cached: a read after
 * `/model` has to see the change.
 */
export function optionsStateScript() {
  return [
    'echo @@ARGV',
    "ps -eo args= 2>/dev/null | grep -m1 '^claude' || true",
    'echo @@ENV',
    'printenv ANTHROPIC_MODEL 2>/dev/null || true',
    'echo @@FILES',
    // Four lines, always all four, so a blank first line still means "settings.json sets no
    // model" rather than shifting ~/.claude.json's answer into its place.
    `node -e 'const fs=require("fs");const g=(f,k)=>{try{return String(JSON.parse(fs.readFileSync(f,"utf8"))[k]||"")}catch(e){return ""}};const s=process.env.HOME+"/.claude/settings.json";const c=process.env.HOME+"/.claude.json";console.log(g(s,"model"));console.log(g(c,"model"));console.log(g(s,"effort")||g(s,"effortLevel"));let m={};try{m=JSON.parse(fs.readFileSync(s,"utf8")).modelSettings||{}}catch(e){}console.log(JSON.stringify(m))' 2>/dev/null`,
    'echo @@END',
  ].join('\n');
}

/** What claude in this pod can be set to. `parseOptions` in chat-options.ts reads this. */
export function optionsScript() {
  return `${ optionsHelpScript() }\n${ optionsStateScript() }`;
}

/** Whether claude thinks before answering, from the same key /config's "Thinking mode" flips. */
export function thinkingScript() {
  return `node -e "const s=require(process.env.HOME+'/.claude/settings.json');console.log(s.alwaysThinkingEnabled===false?'off':'on')" 2>/dev/null || echo on`;
}

/**
 * The commands that are files in this pod: the project's, the user's, and the skills.
 *
 * `@@END` is there because no commands at all is a real answer: it is what tells that apart from
 * a read that never ran. The parser matches only `CMD` and `SKILL` lines, so it ignores it.
 */
export function commandsScript() {
  return [
    'cd "$(dirname "$HOME")" 2>/dev/null || cd /',
    'for root in "$HOME/.claude" ".claude" "$PWD/.claude"; do',
    '  [ -d "$root/commands" ] && find "$root/commands" -name "*.md" -maxdepth 2 2>/dev/null | sed "s|^|CMD |"',
    '  [ -d "$root/skills" ] && find "$root/skills" -maxdepth 2 -name SKILL.md 2>/dev/null | sed "s|^|SKILL |"',
    'done',
    'echo @@END',
  ].join('\n');
}

/** Every marker saying who started a conversation, as `id<TAB>who` per line. */
export function originsScript() {
  return `cd ${ AGENT_WORKSPACE }/sessions 2>/dev/null || exit 0; for f in *.by; do [ -f "$f" ] && printf "%s\t%s\n" "\${f%.by}" "$(cat "$f")"; done; true`;
}

/**
 * The page of transcript before `start`, for the chat to join onto the front of what it holds.
 *
 * @param at.file The transcript's path.
 * @param at.start The offset of the first byte already held.
 * @param at.nonce What every marker carries; see chat-frames.mjs.
 */
export function earlierScript({ file, start, nonce }) {
  return [
    `FILE=${ JSON.stringify(file) }; START=${ start }; CAP=262144; N=${ JSON.stringify(nonce) }`,
    'FROM=$((START - CAP)); [ "$FROM" -lt 0 ] && FROM=0',
    'echo "@@FROM-$N $FROM"',
    'if [ -f "$FILE" ] && [ "$START" -gt "$FROM" ]; then echo "@@BACK-$N"; tail -c +$((FROM+1)) "$FILE" | head -c $((START - FROM)); echo; echo "@@ENDBACK-$N"; fi',
  ].join('\n');
}
