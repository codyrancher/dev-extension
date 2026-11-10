/**
 * Preparing a workspace's pod: the scripts, shared.
 *
 * A workspace is made ready for an agent by five steps run in its pod - directories and system
 * packages, the seed (skills, rules, the tunnel), gh and jq, the environment file with its tokens,
 * and the checkout's remotes and identity. workspace-tools.ts runs them from the dashboard, through
 * the person's Rancher session; dev-api runs them itself when a review starts with no dashboard
 * open. They are the same scripts, so they are here, once: each function returns the text of one
 * step, and the caller runs it with `rootCommand` or `nodeCommand` in whatever way it execs.
 *
 * Nothing here puts a token anywhere but the workspace's own .env, gh's hosts.yml and git's
 * credential store - 0600 and owned by the pane's user. Pure: tests/workspace-provision.test.mjs.
 */

export const GH_VERSION = '2.76.1';
export const JQ_VERSION = '1.7.1';
export const TOOLS_WANTED = `gh-${ GH_VERSION },jq-${ JQ_VERSION }`;

// Paths inside the workspace, as the pod's shell sees them: `$WS` is set by the wrappers below.
export const BIN = '$WS/bin';
/** One copy of a downloaded tool for the whole node; each workspace's bin links to it. */
export const SHARED_TOOLS = '/workspaces/.shared/tools';
export const ENV_FILE = '$WS/.env';
export const SEED_MARKER = '$WS/.dev-seed';
export const READY_STAMP = '$WS/.dev-ready';

/** A workspace's tree, on every pod that has the shared disk. */
export const workspaceTree = (name) => `/workspaces/${ name }`;

/** What `.dev-seed` holds once this seed is laid out for this workspace. */
export function seedMark(version, ctx, workspace) {
  return `${ version }:${ ctx?.issue || '' }:${ ctx?.pr || '' }:${ workspace }`;
}

/** A script as root, with `WS` set to the workspace's tree (`/workspaces/<name>`, as the caller has it). */
export function rootScript(tree, script) {
  return `WS=${ tree }\n${ script }`;
}

/** A script as the pane's user, with its home, its tools and the workspace's .env. */
export function nodeScript(tree, script) {
  return [
    `WS=${ tree }`,
    `export HOME=$WS/.home; export PATH=${ BIN }:$WS/.home/.local/bin:$PATH`,
    `set -a; [ -f ${ ENV_FILE } ] && . ${ ENV_FILE }; set +a`,
    script,
  ].join('\n');
}

/**
 * The exec argv for a wrapped script, as root: it travels base64 and is run from a file, so nothing
 * in it is ever quoted for a shell - a token, a JSON document, an apostrophe all arrive intact.
 */
export function rootCommand(encoded, file) {
  return ['/bin/sh', '-c', `echo ${ encoded } | base64 -d > ${ file } && /bin/bash ${ file } 2>&1; rc=$?; rm -f ${ file }; exit $rc`];
}

/** The same, as the pane's user. */
export function nodeCommand(encoded, file) {
  return ['/bin/sh', '-c', `echo ${ encoded } | base64 -d > ${ file } && chmod 755 ${ file } && if [ "$(id -u)" = 0 ]; then su node -s /bin/bash -c "/bin/bash ${ file }" 2>&1; else /bin/bash ${ file } 2>&1; fi; rc=$?; rm -f ${ file }; exit $rc`];
}

/** Directories, ownership, and the system packages a recording needs, as root. Prints BASE-OK. */
export function baseScript() {
  return [
    'set -e',
    // From here until the last step succeeds, nothing vouches for this workspace: a run that fails
    // partway must not leave an older stamp saying everything is in place.
    `rm -f ${ READY_STAMP } 2>/dev/null || true`,
    `mkdir -p ${ BIN } $WS/.claude $WS/artifacts/a11y $WS/.kube $WS/.queue $WS/.home/.local/bin $WS/.home/.config/gh`,
    // In the background: a review should not wait a minute for ffmpeg it may never use. setsid so
    // it outlives the exec, and a marker older than any real run is not stopping anything.
    'if ! command -v ffmpeg >/dev/null 2>&1 || ! command -v lsof >/dev/null 2>&1; then',
    '  find /tmp/.dev-apt -mmin +15 -delete 2>/dev/null || true',
    `  if [ ! -f /tmp/.dev-apt ]; then touch /tmp/.dev-apt; setsid sh -c 'apt-get -o DPkg::Lock::Timeout=300 update -qq && DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=300 install -y -qq ffmpeg jq lsof iproute2 >/dev/null 2>&1; rm -f /tmp/.dev-apt' >$WS/.apt.log 2>&1 </dev/null & fi`,
    'fi',
    `git config --global --add safe.directory $WS/dashboard 2>/dev/null || true`,
    `chown -R node:node ${ BIN } $WS/.claude $WS/artifacts $WS/.kube $WS/.queue $WS/.home/.local $WS/.home/.config 2>/dev/null || true`,
    'echo BASE-OK',
  ].join('\n');
}

/** Whether the seed this version would lay out is already there: its marker, and the tunnel it writes. */
export function seedCheckScript() {
  return `cat ${ SEED_MARKER } 2>/dev/null || true; [ -x $WS/bin/dev-shell ] && echo TUNNEL-OK`;
}

/** Whether a check found the seed in place: TUNNEL-OK and the marker naming this version. */
export function seedCurrent(checked, version) {
  return checked.includes('TUNNEL-OK') && checked.split('\n')[0].trim() === version;
}

/**
 * The seed laid out: fetched from dev-api as one document, and its own `layout.mjs` run over it,
 * which renders the `.hbs` files with the workspace's name and its issue or pull request. Prints
 * SEED-OK.
 */
export function seedScript({
  workspace, issue = '', pr = '', cluster = 'local', version, devApi,
}) {
  return [
    'set -e',
    'S=/tmp/dev-seed.$$.json; L=/tmp/dev-layout.$$.mjs',
    `curl -fsS ${ devApi }/agent-seed -o $S`,
    `node -e "const s=require(process.argv[1]);require('fs').writeFileSync(process.argv[2],s['layout.mjs'])" $S $L`,
    `DEV_PROJECT=${ workspace } DEV_ISSUE=${ issue || '' } DEV_PR=${ pr || '' } DEV_CLUSTER=${ cluster } DEV_SEED_FILE=$S DEV_ROOT=$WS DEV_WORKDIR=$WS/dashboard DEV_HOME=$WS/.home node $L`,
    `echo '${ version }' > ${ SEED_MARKER }`,
    'rm -f $S $L',
    'echo SEED-OK',
  ].join('\n');
}

const TOOLS = [
  { tool: 'gh', version: GH_VERSION },
  { tool: 'jq', version: JQ_VERSION },
];

/** Which of gh and jq are linked at the wanted version: the names it prints. */
export function toolsCheckScript() {
  return TOOLS.map(({ tool, version }) => (
    `[ "$(readlink ${ BIN }/${ tool } 2>/dev/null)" = "${ SHARED_TOOLS }/${ tool }-${ version }" ] && printf '%s ' ${ tool }`
  )).concat('true').join('\n');
}

/** The tools a check did not find. */
export function toolsMissing(checked) {
  return TOOLS.filter(({ tool }) => !checked.includes(tool));
}

/**
 * The missing tools, downloaded once for the node and linked. The download lands on a temporary
 * name and `mv -n` puts it in place, so two workspaces seeding at once do not trample each other.
 * Prints TOOLS-OK.
 */
export function toolsScript(missing) {
  const steps = ['set -e', `mkdir -p ${ SHARED_TOOLS }`];

  for (const { tool, version } of missing) {
    const shared = `${ SHARED_TOOLS }/${ tool }-${ version }`;
    const temp = `${ shared }.$$`;
    const fetch = tool === 'jq'
      ? `curl -fsSL -o ${ temp } https://github.com/jqlang/jq/releases/download/jq-${ version }/jq-linux-amd64`
      : `curl -fsSL https://github.com/cli/cli/releases/download/v${ version }/gh_${ version }_linux_amd64.tar.gz | tar -xz -C /tmp && mv /tmp/gh_${ version }_linux_amd64/bin/gh ${ temp } && rm -rf /tmp/gh_${ version }_linux_amd64`;

    steps.push(
      `if [ ! -x ${ shared } ]; then ${ fetch } && chmod +x ${ temp } && mv -n ${ temp } ${ shared }; rm -f ${ temp }; fi`,
      `ln -sf ${ shared } ${ BIN }/${ tool }`,
      `ln -sf ${ shared } $WS/.home/.local/bin/${ tool }`,
    );
  }
  steps.push('echo TOOLS-OK');

  return steps.join('\n');
}

/**
 * The Rancher token already in the workspace's .env, printed if it still answers on any host it
 * might be for - its target, the one .env records, or `browser` - and nothing otherwise.
 */
export function rancherTokenScript(browser = '') {
  return [
    `T=$(grep '^RANCHER_TOKEN=' ${ ENV_FILE } 2>/dev/null | cut -d= -f2-)`,
    'U="${API:-$RANCHER_URL}"',
    `BR='${ browser }'`,
    `PREV=$(grep '^RANCHER_URL=' ${ ENV_FILE } 2>/dev/null | cut -d= -f2-)`,
    '[ -n "$T" ] || exit 0',
    'for C in "$U" "$PREV" "$BR"; do',
    '  [ -n "$C" ] || continue',
    // `--max-time`: three candidates times an untimed connect to a Rancher that has gone is past
    // the exec's budget, and the failure it produces has no reason in it.
    '  if [ "$(curl -sk --max-time 10 -o /dev/null -w "%{http_code}" -H "Authorization: Bearer $T" "$C/v3/users?me=true")" = 200 ]; then echo "$T"; exit 0; fi',
    'done',
  ].join('\n');
}

/**
 * The first of some tokens that answers on `host`, printed, or nothing. For dev-api, which has no
 * Rancher session to mint one with: a new workspace is given one of the person's own that already
 * works, from another of their workspaces.
 */
export function firstWorkingTokenScript(tokens, host) {
  return [
    `H='${ host }'`,
    ...tokens.map((t) => `T='${ t }'; [ "$(curl -sk --max-time 10 -o /dev/null -w "%{http_code}" -H "Authorization: Bearer $T" "$H/v3/users?me=true")" = 200 ] && { echo "$T"; exit 0; }`),
    'true',
  ].join('\n');
}

/**
 * The workspace's .env, ~/.bashrc, gh's hosts.yml, git's credential store and a kubeconfig.
 *
 * The host written is the one the token answers on: the workspace's own target first, then the
 * .env host already there, then `browser` - so a token minted on one Rancher is never filed under
 * another's address. Prints ENV-OK.
 */
export function environmentScript({
  workspace, rancher = '', github = '', login = '', browser = '', browserCdp, githubCdp, devApi,
}) {
  return [
    'set -e',
    'U="${API:-$RANCHER_URL}"',
    `BR='${ browser }'`,
    `T='${ rancher }'`,
    `PREV=$(grep '^RANCHER_URL=' ${ ENV_FILE } 2>/dev/null | cut -d= -f2-)`,
    'PICK=""',
    'for C in "$U" "$PREV" "$BR"; do',
    '  [ -n "$C" ] || continue',
    '  if [ -n "$T" ] && [ "$(curl -sk --max-time 10 -o /dev/null -w "%{http_code}" -H "Authorization: Bearer $T" "$C/v3/users?me=true")" = 200 ]; then PICK="$C"; break; fi',
    'done',
    'if [ -n "$PICK" ]; then U="$PICK"; fi',
    'H=$(echo "$U" | sed -e "s|^https\\?://||" -e "s|/.*$||")',
    // A GitHub token read as empty (a transient secret-read failure) keeps the working one.
    `GH_KEEP="$(grep -m1 '^GH_TOKEN=' ${ ENV_FILE } 2>/dev/null | cut -d= -f2-)"`,
    'umask 077',
    `cat > ${ ENV_FILE } <<EOF`,
    'API=$U',
    'RANCHER_URL=$U',
    'RANCHER_HOST_NAME=$H',
    `RANCHER_TOKEN=${ rancher }`,
    `HARNESS_API=${ devApi }`,
    `CLAUDE_HARNESS_API=${ devApi }`,
    `HARNESS_PROJECT=${ workspace }`,
    `PROJECT_NAME=${ workspace }`,
    // The browser an agent here drives: its own for an all-in-one workspace, the shared one, by
    // IP, for a leased one. `.env` is sourced after the container's env, so this has to be right.
    `CLAUDE_BROWSER_CDP=${ browserCdp }`,
    // The shared github-browser, which holds the one GitHub login, for media uploads.
    `GITHUB_BROWSER_CDP=${ githubCdp }`,
    `GH_TOKEN=${ github || '$GH_KEEP' }`,
    `GITHUB_TOKEN=${ github || '$GH_KEEP' }`,
    'KUBECONFIG=$WS/.kube/config',
    'YARN_CACHE_FOLDER=/workspaces/.shared/yarn',
    'npm_config_cache=/workspaces/.shared/npm',
    'CYPRESS_CACHE_FOLDER=/workspaces/.shared/cypress',
    'PLAYWRIGHT_BROWSERS_PATH=/workspaces/.shared/playwright',
    'EOF',
    `chown node:node ${ ENV_FILE } && chmod 600 ${ ENV_FILE }`,
    `touch $WS/.home/.bashrc`,
    `grep -q 'source $WS/.env' $WS/.home/.bashrc || printf '%s\\n' '# dev extension (the harness put the same in init.sh)' 'set -a; source $WS/.env; set +a' 'export PATH=$WS/bin:$PATH' >> $WS/.home/.bashrc`,
    `chown node:node $WS/.home/.bashrc`,
    github ? `cat > $WS/.home/.config/gh/hosts.yml <<EOF
github.com:
    oauth_token: ${ github }
    user: ${ login || 'codyrancher' }
    git_protocol: https
EOF
chown -R node:node $WS/.home/.config/gh && chmod 600 $WS/.home/.config/gh/hosts.yml
echo "https://${ login || 'codyrancher' }:${ github }@github.com" > $WS/.git-credentials && chown node:node $WS/.git-credentials && chmod 600 $WS/.git-credentials` : 'true',
    rancher ? `cat > $WS/.kube/config <<EOF
apiVersion: v1
kind: Config
clusters:
- name: local
  cluster:
    server: $U/k8s/clusters/local
    insecure-skip-tls-verify: true
users:
- name: local
  user:
    token: ${ rancher }
contexts:
- name: local
  context:
    cluster: local
    user: local
current-context: local
EOF
chown -R node:node $WS/.kube && chmod 600 $WS/.kube/config` : 'true',
    'echo ENV-OK',
  ].join('\n');
}

/**
 * The checkout the way the harness's init.sh left it: the fork as origin and rancher/dashboard as
 * upstream, the identity, the credential helper, the harness's files kept out of the tree, and the
 * PR checked out when the workspace is for one. Prints CHECKOUT-OK, NO-CHECKOUT while there is no
 * clone yet, and CHECKOUT-PENDING while a clone or a PR fetch has not landed.
 */
export function checkoutScript({
  name = '', email = '', fork = 'codyrancher', github = '', pr = 0,
}) {
  return [
    `cd $WS/dashboard 2>/dev/null || { echo NO-CHECKOUT; exit 0; }`,
    name ? `git config user.name ${ JSON.stringify(name) }` : 'true',
    email ? `git config user.email ${ JSON.stringify(email) }` : 'true',
    github ? 'git config credential.helper "store --file=$WS/.git-credentials"' : 'true',
    `if git remote get-url origin 2>/dev/null | grep -q 'github.com/rancher/dashboard'; then git remote rename origin upstream; git remote add origin https://github.com/${ fork }/dashboard.git; fi`,
    'git remote get-url upstream >/dev/null 2>&1 || git remote add upstream https://github.com/rancher/dashboard.git',
    'mkdir -p .git/info',
    "for P in '.mcp.json' '.claude/' '.vscode/' '.install-done' '.claude.json' 'vue.config.orig.js'; do grep -qxF \"$P\" .git/info/exclude 2>/dev/null || echo \"$P\" >> .git/info/exclude; done",
    // An earlier version marked the checkout's vue.config.js skip-worktree; undone.
    'git update-index --no-skip-worktree vue.config.js 2>/dev/null || true',
    'git checkout -- vue.config.js 2>/dev/null || true',
    // The PR's head, once, and only onto a clean default branch: a workspace somebody has
    // already worked in is theirs.
    pr ? `if [ ! -f $WS/.pr-checkout ] && [ -z "$(git status --porcelain --untracked-files=no)" ] && git rev-parse --abbrev-ref HEAD | grep -qE '^(master|main)$'; then git fetch --depth 200 upstream pull/${ pr }/head:pr-${ pr } && git checkout pr-${ pr } && echo ${ pr } > $WS/.pr-checkout; fi` : 'true',
    '[ -d $WS/node_modules/playwright-core ] || (cd $WS && npm install --no-save --silent playwright-core >/dev/null 2>&1 || echo "playwright-core install failed")',
    'git rev-parse -q --verify HEAD >/dev/null 2>&1 || echo CHECKOUT-PENDING',
    pr ? `[ -f $WS/.pr-checkout ] || ! git rev-parse --abbrev-ref HEAD 2>/dev/null | grep -qE '^(master|main)$' || echo CHECKOUT-PENDING` : 'true',
    'echo CHECKOUT-OK',
  ].join('\n');
}
