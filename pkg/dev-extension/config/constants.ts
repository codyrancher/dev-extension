// Rancher's stand-in cluster id for a product that has no cluster of its own.
export const BLANK_CLUSTER = '_';

/**
 * The Dev product: the Claude Harness, rebuilt on Kubernetes.
 *
 * A second product in the same extension rather than more pages in the first one, because the
 * two have nothing to do with each other: `devextension` exists to prove the live-reload loop
 * works, this one is a tool with its own nav. Its routes follow the same
 * `/{product}/c/:cluster/` shape and the same BLANK_CLUSTER param, since it owns no cluster
 * either.
 *
 * The thing this product manages is a workspace, not a project. The harness calls it a
 * project, but Rancher already means something specific by that word - a group of namespaces
 * inside a cluster, with its own members and quotas - and it means it in the very nav this
 * product sits next to. So the harness's word is dropped at the border rather than carried
 * in and left to collide.
 */
export const DEV_PRODUCT = 'dev';

export const WORKSPACES_PAGE = 'workspaces';
export const CREATE_PAGE = 'create';
export const MY_WORK_PAGE = 'my-work';
export const INSIGHTS_PAGE = 'insights';
export const SETTINGS_PAGE = 'settings';
export const AGENTS_PAGE = 'agents';
export const SKILLS_PAGE = 'skills';
export const CONVERSATIONS_PAGE = 'conversations';

/** The product's own page template, which every page below is a child of. */
export const DEV_SHELL_ROUTE = `${ DEV_PRODUCT }-c-cluster`;

export const WORKSPACES_ROUTE = `${ DEV_PRODUCT }-c-cluster-${ WORKSPACES_PAGE }`;
export const WORKSPACE_ROUTE = `${ DEV_PRODUCT }-c-cluster-${ WORKSPACES_PAGE }-workspace`;
export const CREATE_ROUTE = `${ DEV_PRODUCT }-c-cluster-${ CREATE_PAGE }`;
export const MY_WORK_ROUTE = `${ DEV_PRODUCT }-c-cluster-${ MY_WORK_PAGE }`;
export const INSIGHTS_ROUTE = `${ DEV_PRODUCT }-c-cluster-${ INSIGHTS_PAGE }`;
export const SETTINGS_ROUTE = `${ DEV_PRODUCT }-c-cluster-${ SETTINGS_PAGE }`;
export const AGENTS_ROUTE = `${ DEV_PRODUCT }-c-cluster-${ AGENTS_PAGE }`;
export const SKILLS_ROUTE = `${ DEV_PRODUCT }-c-cluster-${ SKILLS_PAGE }`;
export const CONVERSATIONS_ROUTE = `${ DEV_PRODUCT }-c-cluster-${ CONVERSATIONS_PAGE }`;
export const AGENT_EDIT_PAGE = 'agents/edit';
export const AGENT_EDIT_ROUTE = `${ DEV_PRODUCT }-c-cluster-agent-edit`;

/**
 * The tabs a workspace opens as, and the one a link with no tab in it means.
 *
 * Conversations is first and is the default, because it is the reason to open a workspace at
 * all. There is no Overview: what it held was the namespace, the Deployment, the Service and
 * the pod, which are plumbing, and the two facts on it anyone acts on are elsewhere already,
 * the state on the sidebar's row and the ports in the Ports tab. A link to `#overview` lands on
 * Conversations, since an unknown tab falls back to the default.
 *
 * Named here rather than in the page because the route carries a tab (see routing/index.ts):
 * the tab is part of the address so that a tab can be linked to and shared, which is the whole
 * reason it is not component state. The list is also what the page validates against, so a URL
 * naming a tab that does not exist lands on Overview instead of on an empty pane.
 */
export const WORKSPACE_TABS = ['conversations', 'review', 'pr', 'browser', 'share', 'preview'];
export const DEFAULT_WORKSPACE_TAB = 'conversations';

/**
 * The pod this dashboard is served from, which is what the global terminal attaches to.
 *
 * Read out of the URL rather than written down. There can be several of these pods - barn
 * makes one per named extension - and each is reached through a Service of its own, so a
 * constant here would be the name of whichever one happened to be first and every other copy
 * would open a terminal in the wrong pod.
 *
 * The browser is always on the apiserver's service proxy:
 *
 *   /k8s/clusters/<cluster>/api/v1/namespaces/<ns>/services/http:<service>:8005/proxy/...
 *
 * and <ns>/<service> is exactly the pair this needs, because barn names the Deployment, the
 * Service and the pod's `app` label the same thing.
 *
 * The fallback is for a build served any other way - a plain `yarn dev` against a Rancher, on
 * somebody's laptop - where there is no pod to attach to and the terminal cannot work anyway.
 */
function servedFrom(): { namespace: string; service: string } {
  const match = window.location.pathname.match(
    /\/api\/v1\/namespaces\/([^/]+)\/services\/[^:/]+:([^:/]+):\d+\/proxy/
  );

  return match ? { namespace: match[1], service: match[2] } : { namespace: 'barn', service: 'barn-dev-extension' };
}

const SERVED_FROM = servedFrom();

export const DEV_POD_NAMESPACE = SERVED_FROM.namespace;
/** The Deployment, the Service and the seed ConfigMap all carry this name. */
export const DEV_POD_SERVICE = SERVED_FROM.service;
export const DEV_POD_LABELS = { app: SERVED_FROM.service };
export const DEV_POD_CONTAINER = 'devserver';

/**
 * The tmux session prefix for a global terminal.
 *
 * `/seed/shell.sh <id> <dir>` starts or reattaches `mc-<id>`, and the editor's pane in the
 * barn extension uses `editor`, so anything not called that is a session of its own.
 * The numbers after it are the drawer's terminal numbers, so Terminal 2 is always the same
 * conversation, whether it was closed and reopened or reached from a link (see terminals.ts).
 */
export const TERMINAL_SESSION_PREFIX = 'global';

// ── Apps Plus, where templates live ─────────────────────────────────────────────────────────
//
// Steve type ids for Apps Plus's two kinds. A template here is an App and a workspace is an
// Installation (an AppInstance) of one; see apps.ts for why nothing here renders a template
// itself any more.
export const APP = 'appsplus.io.app';
export const APP_INSTANCE = 'appsplus.io.appinstance';

/** The App a fresh Rancher gets, and the one My Work starts fixes in. */
export const DEFAULT_APP = 'rancher-dev';

/**
 * What an App has to say to be a workspace app - the dev tools, pointed at a Rancher - and so
 * to get a section in the sidebar and a place in the create page's picker. Everything else in
 * Apps Plus (a build to share, a browser) is infrastructure a workspace uses, listed where it is
 * used and not as a column of its own.
 */
export const APP_KIND_LABEL = 'dev.rancher.io/kind';
export const APP_KIND_WORKSPACE = 'workspace';

/** Apps this product used to seed under another name; their workspaces are still workspaces. */
export const LEGACY_WORKSPACE_APPS = ['rancher-workspace'];

/**
 * The labels a workspace's objects carry. On the Installation they are what marks it as a
 * workspace of this product rather than any other Installation; on the namespace, Deployment
 * and Service an App renders, they are how the list finds a workspace's parts without knowing
 * what the App made.
 */
export const LABEL_WORKSPACE = 'dev.rancher.io/workspace';
export const LABEL_APP = 'dev.rancher.io/app';
export const LABEL_CLUSTER = 'dev.rancher.io/cluster';

/**
 * How to reach what a workspace serves, on its namespace, because the namespace is the one
 * object every workspace has and the list already reads. An App writes them from its values;
 * a workspace made by an App that does not is reached on 8005 over http, which is what a
 * rancher/dashboard dev server is.
 */
export const WORKSPACE_PORT_ANNOTATION = 'dev.rancher.io/port';
// A human label for a workspace beyond its name: the issue or PR title an action was started
// from, so a list of `pr-19001` / `issue-15656` names can be told apart at a glance.
export const WORKSPACE_TITLE_ANNOTATION = 'dev.rancher.io/title';
/** On a namespace made by the dashboard-preview app: a build to look at, not a workspace to work in. */
export const PREVIEW_ANNOTATION = 'dev.rancher.io/preview';
export const WORKSPACE_SCHEME_ANNOTATION = 'dev.rancher.io/scheme';
export const DEFAULT_WORKSPACE_PORT = 8005;
export const DEFAULT_WORKSPACE_SCHEME = 'http';

/**
 * Where a workspace's tree is - and it is the same path in two pods.
 *
 * A workspace's own pod mounts its tree at `/workspaces/<name>`, and the agent pod mounts the
 * parent, so every workspace is at that same path there too. That is what lets one pod hold
 * every conversation: claude runs in the agent pod, with the workspace's checkout as its
 * working directory and the agent's single login as its home, while each command it runs is
 * forwarded into the workspace's own pod - where the dev server, the browser and the toolchain
 * are - at the very same path. Nothing has to be translated between the two halves, which is
 * why the tree is not simply `/workspace` any more: one pod cannot hold two of those.
 */
export const WORKSPACES_ROOT = '/workspaces';

/** A workspace's tree. */
export function workspaceRoot(name: string): string {
  return `${ WORKSPACES_ROOT }/${ name }`;
}

/** Its checkout, which is what a conversation about it starts in. */
export function workspaceWorkdir(name: string): string {
  return `${ workspaceRoot(name) }/dashboard`;
}

/**
 * The home the *pod's* commands run with: its tools, its gh login, its shell profile.
 *
 * Not claude's home any more - claude keeps its login and its transcripts in the agent pod (see
 * AGENT_HOME), which is the whole point of one pod holding the conversations. This is still
 * where a command that runs in the workspace lands.
 */
export function workspaceHome(name: string): string {
  return `${ workspaceRoot(name) }/.home`;
}

/** Where the tunnel that carries a conversation's commands into the workspace's pod lives. */
export function workspaceShellWrapper(name: string): string {
  return `${ workspaceRoot(name) }/bin/dev-shell`;
}

/**
 * The agent pod's own durable directory, and the home inside it.
 *
 * One login for every conversation in this dashboard, workspace conversations included: it is
 * the pod that holds them all now, so there is one credential to keep alive instead of one per
 * workspace going stale on its own schedule.
 */
export const AGENT_WORKSPACE = '/workspace';
export const AGENT_HOME = `${ AGENT_WORKSPACE }/.home`;

/** The in-cluster API, as pods reach it. The harness's skills read it as $CLAUDE_HARNESS_API. */
export const DEV_API_IN_CLUSTER = 'http://dev-api.dev-system.svc:8080';

// ── Leased tooling: the lte- workspaces ─────────────────────────────────────────────────────
//
// A workspace made this way holds only what a unit of work manipulates - the checkout, the
// artifacts, the CLI tools an agent uses on them - and runs nothing. Everything that costs
// something while it is up is a *tool*: a dev server, a storybook, a Rancher to test against,
// a browser. A tool is started when it is needed, carries a lease, and is torn down when the
// lease runs out, when the agent releases it, or when the workspace goes.
//
// They are marked in the name rather than only in the nav, so that every list, every namespace
// and every tree says which kind of workspace it is without having to read the App off the
// Installation. Existing workspaces are untouched: they keep the `rancher-dev` App and their
// unprefixed names, and nothing here changes how they run.
export const LTE_PREFIX = 'lte-';

/** The slim workspace App: a checkout and a toolbelt, with no server in the pod. */
export const LTE_APP = 'lte-workspace';

/** Whether a workspace is one of the leased-tooling kind, by its name. */
export function isLte(name: string): boolean {
  return String(name || '').startsWith(LTE_PREFIX);
}

/** A name with the marker on it, exactly once. */
export function lteName(name: string): string {
  return isLte(name) ? name : `${ LTE_PREFIX }${ name }`;
}

/** A name without it, for reading the issue or PR number out of it. */
export function bareName(name: string): string {
  return isLte(name) ? name.slice(LTE_PREFIX.length) : name;
}

/**
 * The tools a workspace can attach, and what each one is.
 *
 * `browser` is not a pod: the shared github-browser in dev-system serves every workspace, and
 * starting the browser tool opens a CDP browser context of its own on it (its own cookies,
 * storage and window), which is what keeps two agents out of each other's tabs. The rest are
 * Apps: `lte-<kind>` in Apps Plus, rendered into a namespace of their own.
 */
export const TOOL_KINDS = ['dev-server', 'storybook', 'rancher', 'browser'] as const;
export type ToolKind = typeof TOOL_KINDS[number];

/** The Apps the pod-backed tools are rendered from, by kind. */
export const TOOL_APPS: Record<string, string> = {
  'dev-server': 'lte-dev-server',
  storybook:    'lte-storybook',
  rancher:      'lte-rancher',
};

/** What a tool's own namespace is called: one per workspace and kind. */
export function toolNamespace(workspace: string, kind: string): string {
  return `dev-${ workspace }-${ kind }`;
}

/** On a tool's namespace and objects: which tool it is, and whose. */
export const LABEL_TOOL = 'dev.rancher.io/tool';
export const LABEL_TOOL_OF = 'dev.rancher.io/tool-of';

/**
 * When the lease runs out (ISO), on the tool's namespace.
 *
 * The lease is the point of the whole arrangement. An agent is told to release a tool when it
 * is done with it and mostly does; the lease is what covers the times it does not - a
 * conversation that ended mid-task, a pane that was closed, a person who walked away. dev-api
 * sweeps expired tools every minute, so the worst case for a forgotten dev server is the rest
 * of its lease rather than the rest of the week.
 */
export const LEASE_ANNOTATION = 'dev.rancher.io/lease-expires';
/** What was asked for, in minutes, so a renewal knows how long to add. */
export const LEASE_MINUTES_ANNOTATION = 'dev.rancher.io/lease-minutes';
/** How long a tool gets when nobody says: long enough for a real piece of work, short enough to forget. */
export const DEFAULT_LEASE_MINUTES = 90;
