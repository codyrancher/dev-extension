// What a review or a fix agent needs in the Studio's agent pod, put there on first use.
//
// The harness ran its agents inside a project container it had built: `gh`, `jq`, the
// repository's skills and rules were all there. The Studio's agent pod is a plain node image
// with claude and git in it. So before an action that runs a harness skill is queued, this
// makes sure the pod has:
//
//   - the skills and rules from pkg/dev-extension/agent-seed (agent-seed.generated.ts), in the
//     pane's home and in the shared conversations directory, where claude looks for them;
//   - `gh` and `jq` in the pane's own bin, which the skills call and the image lacks.
//
// Idempotent and cheap to repeat: a marker carries the seed's hash, and binaries are checked
// with `command -v`. Everything lands under /workspace, which is a hostPath, so it survives the
// pod and is written once.

import { podExecOnce, clusterBase } from './api';
import { AGENT_SEED } from './agent-seed.generated';
import { DEV_API_IN_CLUSTER } from './config/constants';
import type { Attachment } from './conversations';

const BASE = clusterBase('local');
const HOME = '/workspace/.home';
const CONVERSATIONS = '/workspace/conversations';
const BIN = `${ HOME }/.local/bin`;

const GH_VERSION = '2.76.1';
const JQ_VERSION = '1.7.1';

function b64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary);
}

/** A short hash of the seed, so a changed skill reaches a pod that already has the old one. */
function seedVersion(): string {
  let h = 2166136261;
  const text = JSON.stringify(AGENT_SEED);

  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }

  return (h >>> 0).toString(16);
}

async function inAgent(attach: Attachment, script: string): Promise<string> {
  return podExecOnce(attach.namespace, attach.pod, attach.container, ['/bin/sh', '-c', script], BASE);
}

/**
 * Write the seed's files: skills into the home, rules beside the conversations.
 *
 * Pulled from the in-cluster API rather than pushed through exec: an exec command travels as
 * URL arguments, and half a megabyte of them does not survive the apiserver proxy. The API
 * carries the same seed in its ConfigMap (see api.ts, ensureWorkspaceApi) and serves it as one
 * JSON document; the pod fetches it and a few lines of node lay the files out.
 */
async function ensureSeed(attach: Attachment): Promise<void> {
  const version = seedVersion();
  const marker = `${ HOME }/.dev-extension-seed`;
  const current = await inAgent(attach, `cat ${ marker } 2>/dev/null || true`);

  if (current.trim() === version) {
    return;
  }

  const script = [
    `curl -fsS ${ DEV_API_IN_CLUSTER }/agent-seed -o /tmp/dev-seed.json`,
    `node -e ${ JSON.stringify([
      "const fs=require('fs'),p=require('path');",
      "const seed=JSON.parse(fs.readFileSync('/tmp/dev-seed.json','utf8'));",
      `for (const [rel,text] of Object.entries(seed)) { const dest = rel.startsWith('skills/') ? '${ HOME }/.claude/'+rel : '${ CONVERSATIONS }/.claude/'+rel; fs.mkdirSync(p.dirname(dest),{recursive:true}); fs.writeFileSync(dest,text); }`,
      'console.log(Object.keys(seed).length);',
    ].join(' ')) }`,
    `chown -R 1000:1000 ${ HOME }/.claude ${ CONVERSATIONS }/.claude 2>/dev/null`,
    `echo '${ version }' > ${ marker } && chown 1000:1000 ${ marker }`,
    'rm -f /tmp/dev-seed.json',
    'echo SEED-OK',
  ].join(' && ');
  const out = await inAgent(attach, script);

  if (!out.includes('SEED-OK')) {
    throw new Error(`The skills could not be written into the agent pod: ${ out.trim().slice(-300) }`);
  }
}

/** `gh` and `jq`, static builds, in the pane's bin. Downloaded once; the bin is on a hostPath. */
async function ensureTools(attach: Attachment): Promise<void> {
  const have = await inAgent(attach, `PATH=${ BIN }:$PATH; for t in gh jq; do command -v $t >/dev/null 2>&1 && printf '%s ' $t; done`);
  const missing = ['gh', 'jq'].filter((tool) => !have.includes(tool));

  if (!missing.length) {
    return;
  }

  const steps = [`mkdir -p ${ BIN }`];

  if (missing.includes('jq')) {
    steps.push(`curl -fsSL -o ${ BIN }/jq https://github.com/jqlang/jq/releases/download/jq-${ JQ_VERSION }/jq-linux-amd64 && chmod +x ${ BIN }/jq`);
  }

  if (missing.includes('gh')) {
    steps.push(`curl -fsSL https://github.com/cli/cli/releases/download/v${ GH_VERSION }/gh_${ GH_VERSION }_linux_amd64.tar.gz | tar -xz -C /tmp && mv /tmp/gh_${ GH_VERSION }_linux_amd64/bin/gh ${ BIN }/gh && rm -rf /tmp/gh_${ GH_VERSION }_linux_amd64`);
  }

  steps.push(`chown -R 1000:1000 ${ BIN }`, 'echo TOOLS-OK');

  const out = await inAgent(attach, steps.join(' && '));

  if (!out.includes('TOOLS-OK')) {
    throw new Error(`gh and jq could not be installed in the agent pod: ${ out.trim().slice(-300) }`);
  }
}

/**
 * The GitHub token, in the pane's home and nowhere else.
 *
 * 0600 and owned by the pane's user, written on every action so a rotated token reaches the pod.
 * The prompt tells the agent to read it from there; the token itself never appears in a prompt,
 * a transcript or a queue file.
 */
async function ensureGithubToken(attach: Attachment, token: string): Promise<void> {
  if (!token) {
    return;
  }

  const out = await inAgent(attach, `umask 077 && echo '${ b64(token) }' | base64 -d > ${ HOME }/.gh-token && chown 1000:1000 ${ HOME }/.gh-token && chmod 600 ${ HOME }/.gh-token && echo TOKEN-OK`);

  if (!out.includes('TOKEN-OK')) {
    throw new Error('The GitHub token could not be written into the agent pod.');
  }
}

/** Everything a harness skill needs in the agent pod. Safe to call before every action. */
export async function ensureAgentReady(attach: Attachment, githubToken = ''): Promise<void> {
  await ensureSeed(attach);
  await ensureTools(attach);
  await ensureGithubToken(attach, githubToken);
}

/**
 * What a conversation's pane is showing, stripped to printable ASCII.
 *
 * Read straight off tmux in the agent pod, as the pane's own user (a tmux server is per user).
 * `running` is false when the conversation has no pane yet: nothing has attached to it since
 * the pod started, so whatever is queued for it has not run.
 */
export async function conversationPane(attach: Attachment, lines = 60): Promise<{ text: string; running: boolean }> {
  const id = attach.command[2];
  const out = await inAgent(attach, [
    `su node -c "if tmux has-session -t mc-${ id } 2>/dev/null; then`,
    `tmux capture-pane -p -S -${ lines } -t mc-${ id } | tr -cd '\\11\\12\\15\\40-\\176' | sed -e 's/[[:space:]]*$//' | grep -v '^$' | tail -n ${ lines };`,
    'else echo BARN-NO-SESSION; fi"',
  ].join(' '));

  return { running: !out.includes('BARN-NO-SESSION'), text: out.replace('BARN-NO-SESSION', '').trim() };
}
