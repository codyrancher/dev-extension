// The agent pod: one claude in the cluster, reachable from every page.
//
// Not one agent per extension. The extension pods already have one each, pointed at one tree
// and knowing about one extension. This is the other thing you want when something is wrong -
// somebody who can see all of them at once, ask the cluster a question, and read the Studio's
// own API document - and it has to be reachable from wherever you noticed, which is usually a
// Rancher page that has nothing to do with the Studio.
//
// It is made the way the service is made: a ConfigMap holding the pod's source, a Deployment
// running stock node over it, and both fingerprinted so a cluster running last month's copy is
// replaced rather than left alone. There is no Service, because nothing here is served - the
// only way in is the exec subresource, which addresses a pod.
//
// Its terminal is PodTerminal, and its panes are shell.sh, tmux and a claude loop - the same
// scripts Extension Studio's dev-server pods run, carried here in seed/ for this pod.
import {
  AGENT_NS, AGENT_ACCOUNT, AGENT_IMAGE, AGENT_BASE, AGENT_OBJECT, AGENT_CONTAINER, STUDIO_NS, STUDIO_AGENT_OBJECT, execUrl, podExecResult,
  namespaceBody, serviceAccountBody, clusterRoleBindingBody, AGENT_ROLE_BINDING,
} from './pod';
// The coarse bucket, shared and tested. See activityBucket there.
import { activityBucket } from './chat-state.mjs';
// What an id is made of, and how to take one apart. Every shape question about an id is asked
// there rather than spelled as a regex here, because the same question is asked in four other
// places and they have to agree. See conversation-id.mjs.
import {
  locationSlug, isConversationId, isDrawerConversationId, isProjectConversationId, conversationOrdinal, conversationProject,
} from './conversation-id.mjs';
import type { InstallStep } from './ensure';
import { VERSION_ANNOTATION, contentVersion, ensureCurrent } from './ensure';
import { AGENT_FILES } from './seed.generated';
import { MCP_GUIDANCE, mcpSeedFiles, withMcpBoot } from './agent-mcp';
import { cardSeedFiles } from './agent-cards';
import { devFetch } from './api';
// One name, from the module that owns the Secret; credential.ts imports nothing from here, so
// this is not a cycle.
import { AGENT_CREDENTIAL_SECRET } from './credential';

type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any

export { AGENT_OBJECT, AGENT_CONTAINER };

/**
 * Where the node keeps this pod's conversations and its claude login between restarts.
 *
 * Beside the extension trees rather than inside one, and named for what it is: an extension's
 * directory is claimed by that extension's name, and the agent is not an extension.
 */
const AGENT_HOST_PATH = '/var/lib/rancher/extension-studio/agent';

/** Where those conversations live inside the pod. Mirrors hostCachePath's role for /app. */
const AGENT_WORKSPACE = '/workspace';

/**
 * The directory every extension's tree is already a child of, on the node.
 *
 * `hostCachePath` puts an extension's `/app` at `/var/lib/rancher/extension-studio/<name>-extension`,
 * and this pod's own `/workspace` is `.../agent` beside them - so the trees are not somewhere
 * that has to be reached, they are one directory up. Mounting the parent is the whole of it.
 */
const EXT_HOST_ROOT = AGENT_HOST_PATH.replace(/\/agent$/, '');

/**
 * The node's workspaces, and where they appear here.
 *
 * A workspace (dev-extension's: a checkout of a product, its browser and its dev server) keeps
 * its tree on the node, and its own pod mounts it at this same path - `/workspaces/<name>` on
 * both sides. That sameness is the point: a conversation about a workspace runs *here*, in this
 * one pod with the one login, while every command it runs is forwarded into that workspace's
 * pod. Both halves then say the same thing about where a file is, so a skill that names a path
 * is right whichever half reads it.
 *
 * The parent rather than one mount per workspace, for the reason the extensions mount gives:
 * a workspace made after this pod started is simply there.
 */
const WORKSPACES_HOST_ROOT = '/var/lib/rancher/dev-workspaces';

const WORKSPACES_MOUNT = '/workspaces';

/**
 * Where those trees appear in this pod.
 *
 * Under `/workspace` rather than at the root, because `/workspace` is the durable half of this
 * pod and this is the same node storage the rest of it is on - putting it anywhere else would
 * suggest it is something different. A pane's own directory is `/workspace/conversations`, so
 * an extension's source is one `cd` from where the agent already is.
 *
 * `<mount>/agent` is this pod's own `/workspace`, seen from outside. That is not a loop and it
 * does not recurse: the nesting exists only inside this container, so the host directory it
 * resolves to has no `extensions` of its own.
 */
const AGENT_EXT_MOUNT = `${ AGENT_WORKSPACE }/extensions`;

/**
 * The source this pod runs, taken out of the bundle it travels in - plus what the extension
 * adds to it.
 *
 * The seed itself is generated from another repository and says not to edit it, so the MCP
 * servers are added here instead: two files of their own, a line spliced into boot, and a
 * section appended to what the agent is told. See agent-mcp.ts.
 */
export function agentSourceFiles(): Record<string, string> {
  const files: Record<string, string> = { ...AGENT_FILES, ...mcpSeedFiles(), ...cardSeedFiles() };

  files['boot.sh'] = withMcpBoot(files['boot.sh'] || '');
  // Appended rather than replaced: the file is the agent's, and this is one more thing in it.
  if (files['session-claude.md'] && !files['session-claude.md'].includes('## Figma')) {
    files['session-claude.md'] += MCP_GUIDANCE;
  }

  return files;
}

/**
 * A fingerprint of that source, for the same reason the service has one.
 *
 * A pod created once and then left alone keeps whatever source it was first given for ever, and
 * nothing reports the mismatch. It goes on the ConfigMap and on the Deployment (which is what
 * ensureCurrent compares); the pod template carries agentBootVersion instead, so that only a
 * change to what boot runs once rolls the pod.
 */
export function agentSourceVersion(): string {
  const files = agentSourceFiles();

  return contentVersion(Object.keys(files).sort().flatMap((key) => [key, files[key]]));
}

/**
 * The part of that source a running pod cannot pick up: what boot.sh runs once. Everything
 * else in /seed is read again on every pane start (shell.sh and what it calls), and the
 * ConfigMap volume it is mounted from updates in place, so a changed script reaches the next
 * pane without a restart. Rolling the pod for those ended every conversation in it on every
 * publish. This goes on the pod template instead, so only a change to the boot itself rolls it.
 */
export function agentBootVersion(): string {
  const files = agentSourceFiles();
  const boot = ['boot.sh', 'terminal-tools.sh', 'tmux.conf'].filter((key) => key in files);

  return contentVersion(boot.flatMap((key) => [key, files[key]]));
}

export function agentConfigMapBody(): Record<string, unknown> {
  return {
    apiVersion: 'v1',
    kind:       'ConfigMap',
    metadata:   {
      namespace:   AGENT_NS,
      name:        AGENT_OBJECT,
      labels:      { app: AGENT_OBJECT },
      annotations: { [VERSION_ANNOTATION]: agentSourceVersion() },
    },
    data: agentSourceFiles(),
  };
}

/**
 * The Deployment, with its own shape in its fingerprint.
 *
 * The fingerprint used to be the seed's hash alone, and the seed is a set of scripts - so a
 * change to *this* function changed nothing that `replaceIfStale` compares, and the running
 * Deployment kept whatever spec it was created with for ever. That is not hypothetical: a
 * `/workspaces` mount asking for Bidirectional propagation got into the live Deployment, the
 * node cannot give that (`/var/lib/rancher` is not a shared mount), and every container
 * creation failed with CreateContainerError - so the pod was gone, every conversation with it,
 * and reinstalling the extension changed nothing because the fingerprint still matched.
 *
 * So the spec is hashed into the annotation as well. Editing the mounts, the account, the
 * image or the strategy now reaches a cluster that already has this object, which is what the
 * reconcile was for.
 */
export function agentDeploymentBody(): Record<string, unknown> {
  const body = deploymentSpec();

  (body.metadata as Json).annotations = { [VERSION_ANNOTATION]: contentVersion([agentSourceVersion(), JSON.stringify(body.spec)]) };

  return body;
}

function deploymentSpec(): Record<string, unknown> {
  return {
    apiVersion: 'apps/v1',
    kind:       'Deployment',
    metadata:   {
      namespace: AGENT_NS,
      name:      AGENT_OBJECT,
      labels:    { app: AGENT_OBJECT },
    },
    spec: {
      replicas: 1,
      selector: { matchLabels: { app: AGENT_OBJECT } },
      // Recreate, like an extension's and for the same reason: /workspace is a hostPath, and two
      // pods would be two tmux servers writing one set of conversation directories.
      strategy: { type: 'Recreate' },
      template: {
        metadata: {
          labels:      { app: AGENT_OBJECT },
          annotations: { [VERSION_ANNOTATION]: agentBootVersion() },
        },
        spec: {
          // The same account every pod here runs as, and here it is used rather than declared:
          // kubectl in a pane reads its token, and being able to answer a question about the
          // cluster is most of what this pod is for. See AGENT_ACCOUNT for what that grants, and
          // agent-overlay.ts for why the way in is offered to admins only.
          serviceAccountName: AGENT_ACCOUNT,
          containers:         [{
            name:    AGENT_CONTAINER,
            image:   AGENT_IMAGE,
            command: ['/bin/sh', '/seed/boot.sh'],
            // Privileged for FUSE: a workspace on a downstream cluster is mounted here over sshfs
            // (mount-downstream.sh) so a pane sees its files, and opening /dev/fuse is refused to
            // a container the device cgroup has not been opened for - which, short of a device
            // plugin, means privileged. This pod is already cluster-admin, so it is a node-level
            // rather than a new-authority escalation. Local-only installs never mount anything.
            securityContext: { privileged: true },
            env:     [
              // Rancher's address from inside the cluster, which is the node's: this cluster is
              // k3s inside the Rancher container. Declared before RANCHER_URL because Kubernetes
              // expands $(VAR) only against variables already listed.
              { name: 'NODE_IP', valueFrom: { fieldRef: { fieldPath: 'status.hostIP' } } },
              { name: 'RANCHER_URL', value: 'https://$(NODE_IP)' },
              // Where the Studio's own API answers, so the CLAUDE.md can tell the agent to read
              // its OpenAPI document rather than describe the routes and go stale.
              { name: 'EXTENSION_STUDIO_API', value: 'http://extension-studio-api:8006' },
            ],
            volumeMounts: [
              { name: 'seed', mountPath: '/seed' },
              { name: 'workspace', mountPath: AGENT_WORKSPACE },
              // After the workspace mount, and nested inside it, which kubelet handles by
              // mounting in path order. Writable rather than read-only: this pod could already
              // write into any of those trees through the exec subresource, so read-only would
              // buy no safety and cost the one thing that makes this worth having - editing a
              // file with an editor instead of a shell command. What keeps two agents out of
              // one tree is the rule in the CLAUDE.md, not the mount.
              { name: 'extensions', mountPath: AGENT_EXT_MOUNT },
              // Not nested in the workspace mount: these are another product's trees, and a
              // conversation's own directory has nothing to do with them.
              { name: 'workspaces', mountPath: WORKSPACES_MOUNT },
              // The durable Rancher token mount-downstream.sh execs and mounts downstream
              // workspaces with. Optional: a Rancher with no downstream workspaces never makes
              // this Secret, and the pod comes up local-only without it.
              { name: 'downstream-exec', mountPath: '/var/run/downstream-exec', readOnly: true },
            ],
            // No probes. There is no port and nothing to ask; a pod with neither is Ready as
            // soon as it is Running, which for this one is the truth.
          }],
          volumes: [
            { name: 'seed', configMap: { name: AGENT_OBJECT } },
            { name: 'workspace', hostPath: { path: AGENT_HOST_PATH, type: 'DirectoryOrCreate' } },
            // The parent rather than one entry per extension, so an extension created after this
            // pod started is simply there. A per-extension mount would mean editing this
            // Deployment - and restarting this pod, and ending every conversation in it - every
            // time somebody made one.
            { name: 'extensions', hostPath: { path: EXT_HOST_ROOT, type: 'DirectoryOrCreate' } },
            { name: 'workspaces', hostPath: { path: WORKSPACES_HOST_ROOT, type: 'DirectoryOrCreate' } },
            { name: 'downstream-exec', secret: { secretName: 'downstream-exec', optional: true } },
          ],
        },
      },
    },
  };
}

/**
 * What the pod needs to exist first, made here when this extension is the first to arrive.
 *
 * These are the agents' own now. Extension Studio makes a namespace and an account of its own
 * name for its own pods; nothing is shared between them any more, and an object that is already
 * there is still treated as ours to keep current.
 */
export function sharedSteps(): InstallStep[] {
  return [
    {
      id:          'namespace',
      label:       `Namespace ${ AGENT_NS }`,
      description: 'Holds the agent pod and nothing else: the conversations, their panes and the credential they read.',
      type:        'namespaces',
      uiType:      'namespace',
      name:        AGENT_NS,
      body:        namespaceBody,
    },
    {
      id:          'serviceaccount',
      label:       `ServiceAccount ${ AGENT_ACCOUNT }`,
      description: 'The identity the agent pod runs as.',
      type:        'serviceaccounts',
      uiType:      'serviceaccount',
      namespace:   AGENT_NS,
      name:        AGENT_ACCOUNT,
      body:        serviceAccountBody,
    },
    {
      id:          'clusterrolebinding',
      label:       `ClusterRoleBinding ${ AGENT_ROLE_BINDING }`,
      description: 'Grants that identity cluster-admin, without which a pane gets 403 to every question about the cluster.',
      type:        'rbac.authorization.k8s.io.clusterrolebindings',
      uiType:      'rbac.authorization.k8s.io.clusterrolebinding',
      name:        AGENT_ROLE_BINDING,
      body:        clusterRoleBindingBody,
    },
  ];
}

/** The two objects, in the order they have to be made: a Deployment naming an absent ConfigMap never starts. */
export function agentSteps(): InstallStep[] {
  return [
    {
      id:          'agent-source',
      label:       `ConfigMap ${ AGENT_OBJECT }`,
      description: 'What the agent pod runs, as source. There is no image, so this is the only copy of it in the cluster.',
      type:        'configmaps',
      uiType:      'configmap',
      namespace:   AGENT_NS,
      name:        AGENT_OBJECT,
      body:        agentConfigMapBody,
    },
    {
      id:          'agent-deployment',
      label:       `Deployment ${ AGENT_OBJECT }`,
      description: 'The one claude that can see every extension, which the global terminal opens into.',
      type:        'apps.deployments',
      uiType:      'apps.deployment',
      namespace:   AGENT_NS,
      name:        AGENT_OBJECT,
      body:        agentDeploymentBody,
    },
  ];
}

/**
 * Make the agent pod exist, and make it the source this bundle carries.
 *
 * Called when the bundle loads, in front of a page, on behalf of somebody who may not be allowed
 * to create any of it - so it swallows what goes wrong. The overlay says so itself when there is
 * no pod to open into.
 */
let ensureAgentInFlight: Promise<void> | null = null;

export function ensureAgent(): Promise<void> {
  if (ensureAgentInFlight) {
    return ensureAgentInFlight;
  }

  // Retired first, and awaited: the old pod and the new one mount the same hostPath, and two of
  // them on it means two tmux servers on one socket directory and two boots reattaching the same
  // panes. One at a time, old one first.
  ensureAgentInFlight = retireStudioAgent()
    .then(() => ensureCurrent([...sharedSteps(), ...agentSteps()]))
    .finally(() => {
      ensureAgentInFlight = null;
    });

  return ensureAgentInFlight;
}

/**
 * Take down the agent pod this extension used to keep in the Studio's namespace.
 *
 * The pod moved to `dev-agents` (see pod.ts) and the conversations did not move at all: they are
 * on the node, under AGENT_HOST_PATH, which both the old Deployment and the new one mount. That
 * is what makes this a rename rather than a migration - and also what makes leaving the old one
 * running unsafe, because a tmux server is per user per socket directory and two pods sharing one
 * would each think the other's sessions were theirs to reattach.
 *
 * The credential Secret is carried across before the Deployment goes, so the new pod has a
 * Rancher identity from its first pane rather than from the next time somebody opens the panel.
 * The old Secret is left where it is: it is the copy a pod that has not rolled yet still reads,
 * and deleting somebody's credential to tidy up is not a trade worth making.
 *
 * Everything here is best effort and silent. It runs in front of a page, on behalf of somebody
 * who may not be allowed to delete a Deployment, and a cluster where it fails is a cluster that
 * keeps working off the old pod.
 */
async function retireStudioAgent(): Promise<void> {
  const old = await devFetch(`${ AGENT_BASE }/v1/apps.deployments/${ STUDIO_NS }/${ STUDIO_AGENT_OBJECT }`).catch(() => null);

  if (!old?.metadata) {
    return;
  }

  await carryCredentialOver();

  // The Deployment, then the ConfigMap it mounted: the other order leaves a pod whose volume has
  // gone, which crash-loops noisily for the few seconds before the Deployment follows it.
  await devFetch(`${ AGENT_BASE }/v1/apps.deployments/${ STUDIO_NS }/${ STUDIO_AGENT_OBJECT }`, { method: 'DELETE' }).catch(() => null);
  await devFetch(`${ AGENT_BASE }/v1/configmaps/${ STUDIO_NS }/${ STUDIO_AGENT_OBJECT }`, { method: 'DELETE' }).catch(() => null);
}

/** Copy the old credential Secret into the agents' namespace, if there is one and it is needed. */
async function carryCredentialOver(): Promise<void> {
  const already = await devFetch(`${ AGENT_BASE }/v1/secrets/${ AGENT_NS }/${ AGENT_CREDENTIAL_SECRET }`).catch(() => null);

  if (already?.metadata) {
    return;
  }
  const from = await devFetch(`${ AGENT_BASE }/v1/secrets/${ STUDIO_NS }/${ STUDIO_AGENT_OBJECT }-credential`).catch(() => null);

  if (!from?.data) {
    return;
  }

  await devFetch(`${ AGENT_BASE }/v1/secrets`, {
    method: 'POST',
    body:   JSON.stringify({
      apiVersion: 'v1',
      kind:       'Secret',
      type:       from.type || 'Opaque',
      metadata:   { namespace: AGENT_NS, name: AGENT_CREDENTIAL_SECRET, labels: { app: AGENT_OBJECT } },
      data:       from.data,
    }),
  }).catch(() => null);
}

/**
 * The running agent pod, or null while there isn't one.
 *
 * `Running` rather than `Ready` is not the distinction it is for an extension - this pod has no
 * probes - but the shape is the same as extensionPod's on purpose, because the terminal polls
 * this the same way and a first boot is still installing tmux and claude for a minute or two.
 */
export async function agentPod(): Promise<string | null> {
  const pods = await devFetch(`${ AGENT_BASE }/v1/pods/${ AGENT_NS }`).catch(() => null);

  const running = (pods?.data || []).find((pod: any) => (
    pod.metadata?.labels?.app === AGENT_OBJECT &&
    pod.status?.phase === 'Running' &&
    !pod.metadata?.deletionTimestamp
  ));

  return running?.metadata?.name || null;
}

/**
 * Where every conversation runs.
 *
 * One directory for all of them, deliberately. claude keys its history by working directory, so
 * a directory per conversation meant the resume picker in one tab could not see any of the
 * others - which is what somebody hits the moment they want to pick a conversation up in a
 * different pane, and it reads as the tabs not being the same place.
 *
 * What that costs is spelled out in claude-session.sh: sharing the directory means `--continue`
 * would resume whichever conversation was touched last by any pane, so each pane now tracks the
 * id of its own and resumes that instead.
 *
 * `sessions.sh` still keeps a directory per conversation under `sessions/`, but only for the
 * name and the title. Nothing runs there.
 */
function sharedWorkdir(): string {
  return `${ AGENT_WORKSPACE }/conversations`;
}

/**
 * WebSocket URL for one conversation in the agent pod.
 *
 * The same shell.sh an extension's terminal runs, given a directory of its own and this pod's
 * durable home. The arguments are positional (session, directory, home, mode) and none of them
 * can be skipped, which is why the third is spelled out rather than left to shell.sh's default -
 * that default is /app, and this pod has no /app.
 */
export function agentShellUrl(pod: string, session: string, mode = 'claude'): string {
  return execUrl(
    pod,
    ['/bin/sh', '/seed/shell.sh', session, sharedWorkdir(), `${ AGENT_WORKSPACE }/.home`, mode],
    true,
    AGENT_CONTAINER,
  );
}

/**
 * What a conversation's pane is doing, as one word for the tab's status dot.
 *
 * `working` while claude is mid-turn, `input` while it is waiting on the person, `idle` when it
 * is up but between turns, `finished` when the pane is gone, and `none` when the conversation has
 * never run - which is what leaves a fresh tab without a dot.
 */
export type AgentActivity = 'working' | 'input' | 'idle' | 'finished' | 'none';

/** One conversation: the name that addresses it, and the name a person reads. */
export interface AgentSession {
  /** Names the directory, the tmux session and the exec URL. Never changes. */
  id: string;
  /** What the tab says. Renamable, and kept in the pod beside the conversation. */
  title: string;
  /** What its pane is doing, for the tab's status dot. `none` until it has run at all. */
  state?: AgentActivity;
  /**
   * Which CLI holds it: 'claude', 'agy', or '' for one that has never run.
   *
   * Reported by the pod, from the record the pane itself wrote, because nothing in the browser
   * can work it out: a tab knows what it asked for when it created a conversation, and nothing
   * at all about one created in another tab, by an agent, or before this page was loaded. The
   * chat drew claude's chrome over all of them until this existed.
   */
  cli?: string;
}

/** The raw signals `sessions.sh states` reports for one conversation, before they become a word. */
export interface SessionActivity {
  /** Whether the conversation's tmux session exists in the pod. */
  alive: boolean;
  /** The last hook event the pane recorded (chat-hook.mjs), and its notification and time. */
  event: string;
  notification: string;
  at: string;
  /** Seconds since the conversation's own transcript last moved, or -1 when there is none. */
  wroteAgo: number;
  /**
   * Seconds since the newest of its subagents' transcripts moved, or -1 when the caller cannot
   * tell them apart from the main one - which the pod's `states` verb cannot, so this is only
   * set on the paths that read the transcripts themselves. Apart from `wroteAgo` because a
   * hook ends the main agent's turn and says nothing about its subagents; see activityBucket.
   */
  subAgo?: number;
}

/**
 * How recently the transcript must have moved for the conversation to count as working. Long
 * enough to cover a subagent thinking between writes, short enough that a conversation nobody is
 * in stops claiming to be busy. Kept in step with the Dev extension's WORKING_WINDOW_S, which is
 * the same threshold applied to the same signals for the same reason.
 */
const WORKING_WINDOW_S = 90;

/**
 * The hook events that are the last word on a conversation, when they are the latest thing to
 * have happened.
 *
 * `Stop` and `SessionEnd` say the turn is over, and both fire after the final writes of that
 * turn land - so for a few seconds afterwards the transcript still looks like it is moving.
 * `Notification` says claude is waiting, and it fires right after the tool call it is asking
 * permission for was written down. Each of those has to be able to overrule a transcript that
 * has only just stopped, which is what the few seconds of margin below are for.
 *
 * `SessionStart` and `UserPromptSubmit` are not on this list, and that is the point of having
 * one: neither says anything about whether claude is busy now.
 */
const SPEAKS_LAST = new Set(['Stop', 'SessionEnd', 'Notification']);

/**
 * The bucket a conversation falls in, from what the pod reported about it.
 *
 * A copy of the Dev extension's `agentStateOf` rather than a call to it: the two extensions do
 * not import across each other, and this is the one derivation both need to make the same way.
 * The transcript outranks the hook: a hook fires only at a turn's edges, so a turn spent inside
 * subagents reads as finished to it while the subagents write all the while, and a permission
 * prompt answered in the terminal leaves the last Notification standing over an agent that is
 * working again.
 *
 * The margin that lets a hook win back used to apply to every event, and `SessionStart` is
 * where that was wrong. It means claude is up; it does not mean claude is idle - and the switch
 * below has no case for it, so it fell through to `idle`, a guess presented as a fact. After an
 * auto-compact it is the wrong guess every time: the CLI fires SessionStart the moment it has
 * finished compacting and then carries straight on with the rest of the turn, while the
 * transcript, quiet all through the compaction, is the only thing that knows. Replayed over
 * this pod's own conversations, letting it know halves the samples where a working conversation
 * was showing an idle dot.
 */
export function activityState(a: SessionActivity, podStartedMs = 0): AgentActivity | '' | 'none' {
  return activityBucket(a, podStartedMs) as AgentActivity | '' | 'none';
}

/**
 * When the agent pod came up, in ms, or 0 when it cannot be told.
 *
 * `activityBucket` needs it to tell "this pane is gone" from "there is no tmux server yet": for
 * the first two minutes after the pod changes, every conversation is legitimately absent. 0 is
 * the safe answer - the guard treats not knowing as doubt and reports no change at all, which is
 * what the extension used to do permanently by never asking.
 */
export async function agentPodStartedAt(): Promise<number> {
  const pods = await devFetch(`${ AGENT_BASE }/v1/pods/${ AGENT_NS }`).catch(() => null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const running = (pods?.data || []).find((pod: any) => (
    pod.metadata?.labels?.app === AGENT_OBJECT &&
    pod.status?.phase === 'Running' &&
    !pod.metadata?.deletionTimestamp
  ));

  return Date.parse(running?.status?.startTime || '') || 0;
}

/**
 * What each conversation's pane is doing, keyed by id. Asked of the pod's `states` verb, which
 * reports the raw signals; the bucket is worked out here. A conversation that has never run has
 * no line and so no entry, which the caller reads as `none`.
 */
async function sessionStates(project = '', strict = false): Promise<Map<string, AgentActivity>> {
  /*
   * `states` is scoped to a base and `states-all` is not, and that distinction is the whole
   * reason the second verb exists.
   *
   * With no project the base falls back to `agent`, so `states` answers for the DRAWER's
   * conversations and no workspace's. Measured in this pod: `states` answers 11 lines with no
   * `p-` among them; `states-all` answers 194, of which 183 are workspaces'. Asking the narrow
   * one for a pod-wide answer is how `projectConversations` came to report that nothing was
   * running anywhere.
   *
   * So a project-less call asks the wide verb. `agentSessions` is the other caller and now gets
   * the extra rows; it looks its own ids up by key and never iterates, so they cost it one map
   * and change nothing it answers.
   */
  const args = project ? ['states', project] : ['states-all'];
  /*
   * `strict` is whether "the pod did not answer" is allowed to look like "nothing is running".
   *
   * A panel drawing its tabs would rather show no dots than an error, so the default swallows it.
   * A caller deciding what every workspace's agent is doing must not: an empty answer there is
   * published as fact, and every workspace in the dashboard goes quiet at once.
   */
  const [listing, podStartedMs] = await Promise.all([
    strict ? sessionScript(args, 'read what the conversations are doing') : sessionScript(args, 'read what the conversations are doing').catch(() => ''),
    agentPodStartedAt().catch(() => 0),
  ]);
  const out = new Map<string, AgentActivity>();

  for (const raw of listing.split('\n')) {
    const line = raw.replace(/\r$/, '');

    if (!line) {
      continue;
    }

    const [id, alive, wrote, json] = line.split('\t');

    if (!id) {
      continue;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let event: any = {};

    try {
      event = JSON.parse(json || '{}');
    } catch { /* a state file caught mid-write; the next poll reads it whole */ }

    const bucket = activityState({
      alive:        alive === 'yes',
      event:        String(event.event || ''),
      notification: String(event.notification || ''),
      at:           String(event.at || ''),
      wroteAgo:     Number(wrote ?? -1),
    }, podStartedMs);

    // '' is "nothing believable" and 'none' is "nobody has opened this": neither is an entry.
    // A caller reads a missing id as `none`, which is what both of those mean here.
    if (bucket && bucket !== 'none') {
      out.set(id, bucket as AgentActivity);
    }
  }

  return out;
}

/** One call to the pod's own account of its conversations. See pod/agent/sessions.sh. */
/**
 * One line of `sessions.sh list` as a conversation: `id`, `title`, and optionally the CLI.
 *
 * Three fields, tab separated, and the third is read defensively because the two callers of
 * this have to keep working against a pod whose seed is older than this browser's - a pane that
 * has not been re-materialised yet still prints two. A title cannot contain a tab (`title_of`
 * strips control characters), so a third field is the CLI or nothing; anything that is not a
 * plain lowercase word is treated as part of the title rather than guessed at.
 */
function sessionLine(line: string): { id: string; title: string; cli: string } {
  const fields = line.split('\t');
  const id = fields[0] || line;
  const last = fields.length > 2 ? fields[fields.length - 1] : '';
  const cli = /^[a-z]{2,16}$/.test(last) ? last : '';
  const title = fields.slice(1, cli ? -1 : undefined).join('\t');

  return { id, title: title || id, cli };
}

async function sessionScript(args: string[], what: string): Promise<string> {
  const pod = await agentPod();

  if (!pod) {
    throw new Error('The agent pod is not running yet, so there is nowhere to hold a conversation.');
  }

  // Short, because a person is waiting for each of these with a panel open. None of them is
  // more than a mkdir or a directory listing.
  const result = await podExecResult(pod, ['/bin/sh', '/seed/sessions.sh', ...args], 15000, AGENT_CONTAINER);

  if (result.code !== 0) {
    throw new Error(`Could not ${ what }: ${ result.stderr.trim() || result.status || `exit ${ result.code }` }`);
  }

  return result.stdout;
}

/**
 * Every conversation the pod is holding.
 *
 * Asked of the pod rather than remembered in the browser, and that is the whole design of the
 * tab strip. A conversation outlives the tab that opened it, so a second browser tab, a reload,
 * or a different person's session all have to see the same list and the same names - and the
 * only place either exists is the pod.
 *
 * An empty list is the honest answer for a pod that has just started, so a pod that is not
 * running yet reports nothing rather than throwing: the terminal itself already says when there
 * is no pod, and the panel would otherwise show an error over a pod that is merely booting.
 */
export async function agentSessions(): Promise<AgentSession[]> {
  // The list and the states in one round trip together: the list is which tabs exist (every
  // conversation, opened here or not), the states are what each is doing (only those that have
  // run). Merged by id, with `none` for a conversation the states did not mention.
  const [listing, states] = await Promise.all([
    sessionScript(['list'], 'read the conversations in the agent pod').catch(() => ''),
    sessionStates(),
  ]);

  return listing.split('\n')
    .map((line) => line.replace(/\r$/, ''))
    .filter(Boolean)
    .map((line) => {
      const session = sessionLine(line);

      return { ...session, state: states.get(session.id) || 'none' as AgentActivity };
    })
    // The drawer's, which is `agent-<n>` and now also `agent_<where>-<n>` for one started from
    // somewhere in particular. The ordinal is still the last thing in either, which is what the
    // sort reads; see conversation-id.mjs.
    .filter((session) => isDrawerConversationId(session.id))
    .sort((a, b) => conversationOrdinal(a.id) - conversationOrdinal(b.id));
}

/**
 * A workspace's conversation as the pod holds it: who it belongs to, and what it is doing.
 *
 * No title and no CLI, deliberately. This comes from the pod's `states`, which is keyed on the
 * state files and says nothing about either - and the one caller wants the state. A page that
 * needs the names asks `projectSessions` for its own workspace, which is one exec scoped to it.
 */
export interface PodConversation {
  id: string;
  /** The workspace the id names. Never empty - a conversation whose id names none is left out. */
  project: string;
  state: AgentActivity;
}

/**
 * What each conversation is doing, by id, for a caller outside this bundle.
 *
 * `sessionStates` is the real work and is private because the bucket it applies has to be the
 * one this extension applies everywhere; this is the same answer as a plain object, which is
 * what crosses a `window` boundary without a Map's identity going with it. A conversation that
 * has never run has no entry - see sessions.sh, which keys the verb on the state files - so a
 * missing id is `none` and the caller reads it that way.
 */
export async function conversationActivity(project = ''): Promise<Record<string, AgentActivity>> {
  return Object.fromEntries(await sessionStates(project));
}

/**
 * Every workspace conversation the pod holds, with what each is doing.
 *
 * The same two facts `agentSessions` crosses for the drawer's tabs, for the workspaces' - and
 * for the same reason the drawer asks the pod rather than remembering: the pod is the only
 * place a conversation exists. `list` is which conversations ARE there; `states` is what each
 * is doing, and only the ones that have run have a line. A conversation in the first and not
 * the second is `none`, which is a conversation nobody has opened; an id in the second and not
 * the first is a conversation that has gone, and it is dropped, because a state for something
 * that is not there is the thing a status read off states alone gets wrong.
 *
 * Two execs for every workspace in the dashboard, not two per workspace: that is why this
 * lists the pod and divides the answer up, rather than being asked a workspace at a time.
 *
 * It throws rather than answering with an empty list, unlike `agentSessions`. An empty list is
 * the honest answer for a pod that is still booting when a panel is being drawn; it is not an
 * honest answer to "what is every workspace doing", where it would mark nine workspaces as
 * having no agent at all. A caller keeps what it had and asks again.
 */
export async function projectConversations(): Promise<PodConversation[]> {
  /*
   * The pod's `states`, and nothing else.
   *
   * This asked `list` as well, for which conversations EXIST as against which have run - and
   * `list` with no project does not list them: its base is `p-<project>`, and with no project
   * it falls back to `agent`, so the answer was the drawer's own conversations and none of any
   * workspace's. Crossed with the states, that made every row empty, and an empty answer
   * published as fact is every workspace in the dashboard reporting no agent at all.
   *
   * `states-all` needs no crossing. It is keyed on the state files in the pod - the pod's own
   * disk, read now - so a conversation that has gone has no line and a conversation that has
   * never run has none either, which is `none` and is what a missing id already means. The stale
   * entries this was written to get rid of came from dev-api's watcher DOCUMENT, which outlives
   * what it describes; the pod does not.
   */
  const states = await sessionStates('', true);
  const out: PodConversation[] = [];

  for (const [id, state] of states) {
    const project = conversationProject(id) || '';

    // The drawer's own (`agent-<n>`) name no workspace and are not any workspace's business.
    if (project) {
      out.push({ id, project, state });
    }
  }

  return out;
}

/** Where a conversation's directory and the files beside it live in the pod. */
const AGENT_SESSIONS = `${ AGENT_WORKSPACE }/sessions`;

/**
 * Who started a conversation.
 *
 * `agent-<n>` is the panel's own namespace - the panel is what the + button is on - but any
 * extension can reach `start` through the browser API, and a conversation some machinery made
 * then turned up in the panel as a tab nobody opened. So every conversation says who made it,
 * in a file beside it, and the panel lists its own.
 *
 * 'panel' is the default for exactly one caller: the panel, which calls this directly. Every
 * other route in is the public API, which supplies 'api' - so the way to end up in the panel is
 * to be the panel, rather than to remember to say you are not.
 */
export type SessionOrigin = 'panel' | 'api';

/**
 * Where a conversation was started from, for the id to carry.
 *
 * A path and a line is the common one - the Discuss button on a line of a diff - but a label is
 * enough for the places that are not a file ("PR #19630 review"), and a string that is already
 * a slug passes through unchanged, which is what lets this cross the browser API as one word.
 * '' is a real answer: see startAgentSession.
 */
export type ConversationOrigin = string | { path?: string; line?: number | null; label?: string };

/**
 * Write who made a conversation, beside it in the pod.
 *
 * In the pod rather than in localStorage, because the question is about the conversation and not
 * about this browser: a second tab, and a colleague, have to get the same answer. Best-effort by
 * design - a marker that could not be written leaves the conversation looking like the panel's,
 * which is what every conversation looked like before this existed.
 */
async function markSessionOrigin(id: string, by: SessionOrigin): Promise<void> {
  const pod = await agentPod();

  if (!pod || !isSessionId(id)) {
    return;
  }
  await podExecResult(pod, ['/bin/sh', '-c', `mkdir -p ${ AGENT_SESSIONS } && printf %s ${ by } > ${ AGENT_SESSIONS }/${ id }.by`], 15000, AGENT_CONTAINER);
}

/** Every marker the pod holds, as id to who made it. A conversation with none is the panel's. */
async function sessionOrigins(): Promise<Map<string, SessionOrigin>> {
  const pod = await agentPod();
  const out = new Map<string, SessionOrigin>();

  if (!pod) {
    return out;
  }
  const script = `cd ${ AGENT_SESSIONS } 2>/dev/null || exit 0; for f in *.by; do [ -f "$f" ] && printf "%s\t%s\n" "\${f%.by}" "$(cat "$f")"; done`;
  const result = await podExecResult(pod, ['/bin/sh', '-c', script], 15000, AGENT_CONTAINER).catch(() => null);

  for (const line of (result?.stdout || '').split('\n')) {
    const [id, by] = line.replace(/\r$/, '').split('\t');

    if (id && by) {
      out.set(id, by.trim() === 'panel' ? 'panel' : 'api');
    }
  }

  return out;
}

/**
 * The conversations the panel shows: the ones started on it.
 *
 * Not every `agent-<n>`, which is what this used to be. A run an agent definition started, or
 * anything else that came in through the browser API, lives in the same namespace and used to
 * appear here as a tab nobody had opened - and ending it from the panel ended somebody's work.
 * A conversation with no marker at all counts as the panel's: it predates the markers, and the
 * panel is where it was shown.
 */
export async function panelSessions(): Promise<AgentSession[]> {
  const [sessions, origins] = await Promise.all([agentSessions(), sessionOrigins().catch(() => new Map<string, SessionOrigin>())]);

  return sessions.filter((session) => (origins.get(session.id) || 'panel') === 'panel');
}

/**
 * Start another conversation, and let the pod choose its name.
 *
 * The name has to be allocated where the conversations are, not counted in the browser, and
 * there are two separate reasons. Two browser tabs pressing + at the same moment both see the
 * same list and would both pick the same next number. And a name whose directory still exists
 * is not free even when no tmux session is using it: `tmux new-session -A` would attach to
 * whatever is there, so + would reopen a finished conversation instead of starting one. The pod
 * answers both with a mkdir. See the `new` verb in pod/agent/sessions.sh.
 *
 * `from` is where the conversation was started - a path and a line, a label, or an already
 * slugged location - and it ends up IN the name: `agent_pr-19630-review-4`. Nothing is invented
 * when there is none, because most of these come from a + button that is about nothing in
 * particular, and those keep the short `agent-<n>` they have always had.
 */
export async function startAgentSession(by: SessionOrigin = 'panel', from: ConversationOrigin = ''): Promise<string> {
  const id = (await sessionScript(['new', '', locationSlug(from)], 'start a conversation')).trim();

  if (!isDrawerConversationId(id)) {
    throw new Error(`The agent pod answered "${ id }", which is not a conversation name.`);
  }
  await markSessionOrigin(id, by).catch(() => {});

  return id;
}

/**
 * A project's conversations, and how to start, name and end one.
 *
 * The same pod, the same panes and the same shared transcript directory as the drawer's
 * conversations, namespaced by the project's name in the pod's own sessions.sh so that the
 * drawer never lists them (its list asks for no project and gets only agent-<n>). The Dev
 * extension's workspaces are the first project; the in-pod API offers the same four verbs to
 * anything that cannot import this file - see pod/service/routes.mjs, /v1/projects.
 */
export const PROJECT_NAME_RE = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;

function assertProject(project: string): string {
  if (!PROJECT_NAME_RE.test(project) || project.length > 40) {
    throw new Error(`"${ project }" is not a project name: lowercase letters, digits and hyphens.`);
  }

  return project;
}

/**
 * Whether an id is this project's.
 *
 * Asked of the parser rather than of a prefix, which was wrong in both directions once ids
 * could carry a location: `^p-foo-\d+$` does not match `p-foo_review-2`, and a prefix test
 * would have claimed project `foo-bar`'s ids for project `foo`. See conversation-id.mjs, where
 * that ambiguity is the reason the boundary is `_`.
 */
export function isProjectSession(project: string, id: string): boolean {
  return isProjectConversationId(project, id);
}

export async function projectSessions(project: string): Promise<AgentSession[]> {
  const name = assertProject(project);
  const listing = await sessionScript(['list', name], `read ${ name }'s conversations`).catch(() => '');

  return listing.split('\n')
    .map((line) => line.replace(/\r$/, ''))
    .filter(Boolean)
    .map(sessionLine)
    .filter((session) => isProjectSession(name, session.id))
    .sort((a, b) => conversationOrdinal(a.id) - conversationOrdinal(b.id));
}

/**
 * Start one of a project's conversations.
 *
 * `from` is where it was started - see ConversationOrigin - and the pod puts it in the name:
 * `p-lte-pr-19630_shell-add-auth-dialog-vue-l193-2`. A caller with no location passes nothing
 * and gets `p-lte-pr-19630-2`, which is what every id looked like before.
 */
export async function startProjectSession(project: string, title = '', prompt = '', from: ConversationOrigin = ''): Promise<string> {
  const name = assertProject(project);
  const id = (await sessionScript(['new', name, locationSlug(from)], `start a conversation in ${ name }`)).trim();

  if (!isProjectSession(name, id)) {
    throw new Error(`The agent pod answered "${ id }", which is not a conversation name.`);
  }

  if (title.trim()) {
    await sessionScript(['rename', id, title.trim()], `name ${ id }`);
  }

  if (prompt.trim()) {
    await queueSessionPrompt(id, prompt);
  }

  return id;
}

/** Where a queued prompt waits: shell.sh reads `$(dirname home)/.queue/<session>` on a pane's first start. */
const AGENT_QUEUE = `${ AGENT_WORKSPACE }/.queue`;

/**
 * The guard on every id that is interpolated into a shell command below.
 *
 * It was a charset - `[a-z0-9-]` - and a charset had to be widened the moment ids could carry a
 * `_`. Widening a charset by hand is how the next thing gets let through, so this asks the
 * parser instead: the answer is yes only for a string that is a whole conversation id, old form
 * or new, which is a narrower thing than any charset.
 */
function isSessionId(id: string): boolean {
  return isConversationId(id);
}

/**
 * Queue what a conversation opens with.
 *
 * A file rather than keystrokes, because the thing that queues a prompt is a page and the thing
 * that runs it is a pane that may not exist yet: claude-session.sh hands the file to claude as
 * its opening message the first time the session starts (see MC_QUEUE in shell.sh). Base64
 * through the shell so a prompt with quotes, newlines and dollar signs in it arrives whole, and
 * owned by the pane's user, which is who reads it.
 */
export async function queueSessionPrompt(id: string, prompt: string): Promise<void> {
  if (!isSessionId(id)) {
    throw new Error(`"${ id }" is not a conversation id.`);
  }

  const pod = await agentPod();

  if (!pod) {
    throw new Error('The agent pod is not running yet, so there is nowhere to queue a prompt.');
  }

  const bytes = new TextEncoder().encode(prompt);
  let binary = '';

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  const script = `mkdir -p ${ AGENT_QUEUE } && echo ${ btoa(binary) } | base64 -d > ${ AGENT_QUEUE }/${ id } && chown 1000:1000 ${ AGENT_QUEUE } ${ AGENT_QUEUE }/${ id } 2>/dev/null; echo queued`;
  const result = await podExecResult(pod, ['/bin/sh', '-c', script], 15000, AGENT_CONTAINER);

  if (!result.stdout.includes('queued')) {
    throw new Error(`The prompt could not be written into the agent pod: ${ result.stderr.trim() || result.status || `exit ${ result.code }` }`);
  }
}

/**
 * The argv a pane runs for one conversation - the thing PodTerminal's `command` prop takes.
 *
 * Spelled here once rather than by every extension that places a pane: shell.sh's arguments are
 * positional and all required, and a caller that copied them would be a caller that stopped
 * matching the first time they changed.
 */
/**
 * What to exec for a conversation's pane.
 *
 * `mode` is how the pane runs - the assistant attached, a plain shell, or created detached -
 * and `agy` is the shorthand shell.sh accepts for the assistant held with Antigravity instead
 * of claude. The script takes the CLI as a sixth argument too, which is how a pane restored
 * after a pod restart comes back on the one it was opened with; see seed/shell.sh.
 */
export function sessionCommand(id: string, mode: SessionMode = 'claude'): string[] {
  return ['/bin/sh', '/seed/shell.sh', id, sharedWorkdir(), `${ AGENT_WORKSPACE }/.home`, mode];
}

/** The ways a pane can be opened. See sessionCommand. */
export type SessionMode = 'claude' | 'agy' | 'shell' | 'start';

/**
 * What a conversation's pane is showing, stripped to printable text.
 *
 * Read off tmux in the pod as the pane's own user - a tmux server is per user. `running` is
 * false when nothing has attached to the conversation since the pod started, in which case
 * whatever was queued for it has not run yet.
 */
export async function sessionPane(id: string, lines = 60): Promise<{ text: string; running: boolean }> {
  if (!isSessionId(id)) {
    throw new Error(`"${ id }" is not a conversation id.`);
  }

  const pod = await agentPod();

  if (!pod) {
    return { text: '', running: false };
  }

  const count = Math.max(4, Math.min(400, Math.floor(lines) || 60));
  const script = [
    `if tmux has-session -t mc-${ id } 2>/dev/null; then`,
    `tmux capture-pane -p -S -${ count } -t mc-${ id } | tr -cd '\\11\\12\\15\\40-\\176' | sed -e 's/[[:space:]]*$//' | grep -v '^$' | tail -n ${ count };`,
    'else echo BARN-NO-SESSION; fi',
  ].join(' ');
  const result = await podExecResult(pod, ['su', 'node', '-c', script], 15000, AGENT_CONTAINER);
  const text = result.stdout || '';

  return { running: !text.includes('BARN-NO-SESSION'), text: text.replace('BARN-NO-SESSION', '').trim() };
}

/** The pane for one of a project's conversations: the same shell.sh, the same directory. */
export function projectShellUrl(pod: string, id: string, mode = 'claude'): string {
  return agentShellUrl(pod, id, mode);
}

/**
 * Give one conversation a name.
 *
 * In the pod, for the same reason the list is read from there: a name kept in localStorage
 * would be this browser's name for it, and the person in the next tab would see the ordinal.
 */
export async function renameAgentSession(id: string, title: string): Promise<void> {
  await sessionScript(['rename', id, title], `rename ${ id }`);
}

/**
 * End one conversation.
 *
 * The tmux session and the directory both, which is deliberate rather than incidental. The
 * strip is the pod's list, so a close that left either behind would be a control that does
 * nothing: the tab would come back on the next refresh, and the name would never be free again.
 * The thing that leaves conversations running is closing the panel, or the browser, or
 * reloading the page - none of which touch the pod.
 */
export async function endAgentSession(id: string): Promise<void> {
  await sessionScript(['end', id], `end ${ id }`);
}
