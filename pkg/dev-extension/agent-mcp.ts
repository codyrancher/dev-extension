// The MCP servers a conversation in the agent pod can reach, and how they get there.
//
// This is the extension's own addition to the agent's seed rather than part of it: the seed is
// generated from another repository (see seed.generated.ts, "Do not edit"), so anything written
// there is lost the next time it is regenerated. `agentSourceFiles()` is the seam the extension
// owns, and these files are added through it.
//
// Only Figma today. The shape is general because the second one will want the same three things:
// a key in the person's own secret store, a wrapper that fetches it at spawn time, and a line in
// the agent's CLAUDE file saying the tool exists.

/**
 * Fetch the key and exec the server, rather than writing the key into a config file.
 *
 * `~/.claude.json` lives on a hostPath that outlives the pod, and a token written into it is a
 * token sitting in plain text on the node for as long as the volume exists. The pod is already
 * cluster-admin, so it can read the Secret itself at the moment the server starts; nothing is
 * stored, and revoking the key in Settings is enough to stop it working.
 *
 * The store is found by label, not by name: it is named for the person who owns it
 * (`dev-secrets-<principal>`), and this pod is shared.
 */
export const FIGMA_MCP_WRAPPER = `#!/bin/sh
# Started by claude as an MCP server; speaks stdio, so nothing may be printed on stdout.
set -e

KEY=$(kubectl get secrets -n dev-system -l dev.rancher.io/kind=secrets \\
  -o jsonpath='{.items[0].data.FIGMA_API_KEY}' 2>/dev/null | base64 -d 2>/dev/null || true)

if [ -z "$KEY" ]; then
  echo "No Figma key is set; add one in the Dev extension's Settings." >&2
  exit 1
fi

# Images land somewhere deliberate. Without --image-dir the server writes them under its own
# working directory, which for a server claude spawns is \`/\` - so a download would scatter
# files into the container root. Under the workspace instead, which is the durable half of this
# pod and already where everything else a conversation produces goes.
IMAGES=/workspace/.figma-images
mkdir -p "$IMAGES" 2>/dev/null || true

# No telemetry: this runs on somebody's own machine against their own designs, and the usage
# ping is not theirs to send.
FIGMA_API_KEY="$KEY" DO_NOT_TRACK=1 FRAMELINK_TELEMETRY=off \
  exec npx -y figma-developer-mcp --stdio --image-dir="$IMAGES"
`;

/**
 * Put the server in the agent's claude config when a key is set, and take it out when it is not.
 *
 * Run on a loop rather than once at boot, because the key is set on a web page and the pod is
 * not going to be restarted for it: a key saved in Settings should mean the next conversation
 * opened has Figma, not the next time somebody rolls this deployment.
 *
 * claude reads this file when it starts, so a conversation already running does not gain the
 * server; the one opened after it does.
 */
export const MCP_REFRESH = `// Keep ~/.claude.json's mcpServers in step with the secret store. See agent-mcp.ts.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// Not \`process.env.HOME\`. boot.sh runs as root, so a process it starts inherits \`/root\`,
// while the panes - and therefore claude, and therefore the config this has to edit - run as
// node out of the workspace. Taking HOME on trust meant writing a file nobody reads, and
// because the config was simply missing there, doing it silently.
const HOME = process.env.CLAUDE_HOME || '/workspace/.home';
const CONFIG = path.join(HOME, '.claude.json');
const EVERY_MS = 60000;

const SERVERS = {
  figma: { command: '/bin/sh', args: ['/seed/figma-mcp.sh'], env: {} },
};

/** Which servers have the secret they need. Nothing is read but the presence of a key. */
function available() {
  let data = '';

  try {
    data = execFileSync('kubectl', [
      'get', 'secrets', '-n', 'dev-system', '-l', 'dev.rancher.io/kind=secrets',
      '-o', 'jsonpath={.items[0].data.FIGMA_API_KEY}',
    ], { encoding: 'utf8', timeout: 15000 });
  } catch {
    return {};
  }

  return data.trim() ? { figma: SERVERS.figma } : {};
}

function tick() {
  let config = {};

  try {
    config = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
  } catch {
    // A pod whose claude has not run yet has no config; there is nothing to add it to, and the
    // next tick will find one. Writing a file claude has not created is how its own defaults
    // get lost.
    return;
  }

  const want = available();
  const have = config.mcpServers || {};
  // Only the servers this file owns are touched; anything a person added by hand stays.
  const ours = Object.keys(SERVERS);
  const next = { ...have };

  for (const name of ours) {
    if (want[name]) {
      next[name] = want[name];
    } else {
      delete next[name];
    }
  }
  if (JSON.stringify(next) === JSON.stringify(have)) {
    return;
  }
  config.mcpServers = next;
  fs.writeFileSync(CONFIG, JSON.stringify(config, null, 2));
  console.log(\`[mcp] servers now: \${ Object.keys(next).join(', ') || 'none' }\`);
}

tick();
setInterval(tick, EVERY_MS);
`;

/** What the agent is told about the servers, appended to its CLAUDE file. */
export const MCP_GUIDANCE = `

## Figma

When a Figma key is set in the Dev extension's Settings, a \`figma\` MCP server is running and
its tools are yours to call. Check your available tools for it rather than assuming either way:
the key can be set or removed between conversations, and a conversation that started before a
key was set will not have it (the one after will).

Use it whenever the work refers to a design. A link to a Figma file in an issue, a pull request
comment or a review is something to open and read, not something to infer from. Two habits worth
keeping:

- Read the frames the comment actually points at. A design review that describes what you
  imagine the design says is worse than one that says the design could not be read.
- Say what you could not see. If a file is not reachable with this key, write that down in the
  report rather than quietly reviewing against the implementation alone.
`;

/** The extension's own files, added to the generated seed. */
export function mcpSeedFiles(): Record<string, string> {
  return {
    'figma-mcp.sh': FIGMA_MCP_WRAPPER,
    'mcp-refresh.mjs': MCP_REFRESH,
  };
}

/**
 * Start the refresher from boot, by splicing a line in before the process boot ends on.
 *
 * boot.sh is generated, so this is string surgery on somebody else's file and is written to fail
 * safely: if the line it anchors to is not there any more, the seed goes out unchanged and the
 * MCP servers simply do not appear. A boot.sh that has been edited into something this does not
 * recognise must not be a boot.sh that no longer boots.
 */
export function withMcpBoot(boot: string): string {
  const anchor = /\nexec /;

  if (!anchor.test(boot) || boot.includes('mcp-refresh.mjs')) {
    return boot;
  }

  return boot.replace(anchor, `
# The MCP servers a conversation can reach, kept in step with the secret store. Backgrounded:
# nothing here waits for it, and it runs for the life of the pod. See agent-mcp.ts.
(
  while ! command -v node >/dev/null 2>&1; do sleep 10; done
  CLAUDE_HOME="$AGENT_HOME" node /seed/mcp-refresh.mjs
) >"$WORKSPACE/.mcp.log" 2>&1 &

exec `);
}
