/**
 * The templates a workspace can be created from, and the sections of the sidebar.
 *
 * The harness's templates are a repo to clone and an install to run; here a template is the
 * container a workspace's pod runs, because that is the same decision expressed in Kubernetes.
 * They are a hardcoded list rather than something read out of the cluster on purpose: a
 * template is code (a command, a port, what the terminal lands in), and a ConfigMap of them
 * would only move that code somewhere it cannot be reviewed.
 *
 * There is one, and it is the one the product exists for: a rancher/dashboard dev environment,
 * which is what a RANCHER project is in the harness. The toy templates it replaced (busybox, a
 * node placeholder, an nginx page) proved the plumbing and had nothing to do with the work.
 *
 * There is no Rancher server here, and there does not need to be one. A Rancher server per
 * workspace cannot run in this cluster: rancher/rancher with a ServiceAccount token tries to
 * take over the cluster it is in, and without one its embedded k3s is killed within seconds
 * because a privileged pod here gets the node's own cgroup root rather than a namespace of its
 * own. It is also unnecessary: the workspace is already inside a Rancher, and
 * `https://rancher.cattle-system.svc` answers from any pod in this cluster, so the dev server
 * points at that.
 */
import {
  VCLUSTER_VALUES, MANAGE_SCRIPT, AUTH_SCRIPT, PAUSE_SCRIPT, VCLUSTER_VERSION, SIDECAR_HOST_PATH
} from './rancher-sidecar';

/**
 * Where a workspace keeps the things that have to outlive its pod.
 *
 * The hostPath is mounted at /workspace and is the only storage a restart does not throw away, so
 * both of these are under it: a home in the container filesystem is a /login on every restart,
 * and a checkout in one is another clone and another install.
 *
 * They are here rather than in api.ts because the template's own command is what creates them,
 * and a conversation has to land in the same place the command put them. Two constants so the two
 * cannot drift. See workspaceTerminalCommand.
 */
export const WORKSPACE_WORKDIR = '/workspace/dashboard';
export const WORKSPACE_HOME = '/workspace/.home';

/**
 * Where a queued conversation's prompt waits for the pane that will run it.
 *
 * Beside the home directory rather than inside it, so that clearing a claude login does not take
 * the queue with it. shell.sh derives the same path from HOME_DIR, which is what keeps the two
 * ends of this agreeing without either importing the other. See queueConversation.
 */
export const WORKSPACE_QUEUE = '/workspace/.queue';

/**
 * One secret the product needs, declared rather than hardcoded into a form.
 *
 * Settings is generated from these, so adding a secret is a data change in the same way adding a
 * template is. The declaration carries everything the page needs to render a field for it and
 * everything a card needs to say why it cannot work without it.
 */
export interface DevSecret {
  /**
   * The key inside the one Secret. A global one is the bare key (`GH_TOKEN`); a template's own is
   * stored under the template's own prefix, which the store adds rather than the declaration.
   */
  key: string;
  label: string;
  /** One sentence, shown under the field, saying what the value is and where to get it. */
  help: string;
  /** Whether the thing that declared it can work at all without it. */
  required: boolean;
  /**
   * The product makes this one up rather than asking for it.
   *
   * An admin password for a sidecar that nobody outside this cluster will ever use is a value
   * that has to exist and that nobody has an opinion about, so it is generated once and kept, the
   * way the closet chart's `randAlphaNum` plus `lookup` does it. Settings shows it rather than
   * asking for it, because a generated password you cannot read is one you cannot log in with.
   */
  generated?: boolean;
}

/**
 * One Rancher auth provider a sidecar can back.
 *
 * The closet says the same thing in `sidecar.yml` as `rancherAuth.modes`, and for the same reason:
 * one container can back more than one provider (keycloak is both OIDC and SAML there), so the
 * choice belongs to the card rather than to the sidecar. Rancher enables exactly one provider at a
 * time, so applying one disables the others.
 *
 * Only what the card needs is declared. How a provider is configured is the manager's, because the
 * manager is the only thing holding an admin token for the workspace's Rancher: see AUTH_SCRIPT.
 */
export interface DevAuthMode {
  /** What is written into the workspace's dev-auth ConfigMap, and what the manager matches on. */
  value: string;
  label: string;
}

/**
 * One setting a sidecar takes, declared so the card can render a form for it.
 *
 * The closet says the same thing in `sidecar.yml` under `params`, with the same four fields, and
 * for the same reason: what a sidecar can be configured with is a property of the sidecar rather
 * than of the page, so a new setting is a line here and no change to a component.
 *
 * The value reaches the container as an environment variable, which is why `env` is not optional:
 * a parameter nothing reads is a form field that does nothing.
 */
export interface DevSidecarParam {
  id: string;
  label: string;
  /** The variable the container reads it as. */
  env: string;
  /** A checkbox rather than a text field. Its value is 'true' or ''. */
  type?: 'string' | 'boolean';
  default?: string;
  /** One sentence under the field, saying what the value does. */
  description: string;
}

/**
 * An optional container a workspace can run beside itself: a Deployment, and a Service when it
 * serves something. Declared by the template so the Sidecars tab renders from data.
 */
export interface DevSidecar {
  id: string;
  /** The card's section heading, taken from the data rather than a fixed list. */
  group: string;
  label: string;
  description: string;
  image: string;
  /** Overrides the image's entrypoint and arguments, where the image needs it. */
  command?: string[];
  args?: string[];
  /** What its Service points at, when it serves a UI or an API. Omitted when it serves nothing. */
  port?: number;
  /** How to speak to that port, since the apiserver's service proxy takes the scheme in the path. */
  scheme?: 'http' | 'https';
  /**
   * Whether its own UI survives being served under the proxy's path prefix.
   *
   * Rancher's does not, and neither does Keycloak's: both build absolute URLs from their own idea
   * of where they are. The closet chart says the same thing by giving exactly those two a NodePort
   * instead. A Launch button that opens a page which immediately redirects itself out of the
   * prefix and 404s is worse than no button, so a card without this says where the thing is
   * instead of offering to open it.
   */
  launchable?: boolean;
  /**
   * Environment. `{{namespace}}`, `{{workspace}}` and `{{proxyPath}}` are substituted when the
   * Deployment is written, since all three contain the workspace's own name.
   */
  env?: Record<string, string>;
  /**
   * Files mounted read-only at `/scripts`, as a ConfigMap of this sidecar's own.
   *
   * A sidecar whose job is to install things is a script rather than an image, and the closet
   * chart carries exactly these as a ConfigMap for the same reason: a script long enough to have
   * an ordering in it does not belong on a command line.
   */
  scripts?: Record<string, string>;
  /**
   * This sidecar drives Kubernetes in the workspace's namespace, so it gets a ServiceAccount of
   * its own with rights the ordinary workspace account does not have. See MANAGER_RULES.
   */
  manager?: boolean;
  /**
   * Considered ready only once this TCP port answers, with the chart's own budget of half an hour.
   *
   * Without it the card says Running the moment the container starts, which for something that
   * installs two helm charts inside a cluster it has to create first is a lie for about ten
   * minutes.
   */
  readyPort?: number;
  /** Run before the container is stopped. What a stop has to undo beyond scaling this pod. */
  preStop?: string[];
  /**
   * While this sidecar runs, the workspace's dashboard talks to it rather than to the Rancher this
   * cluster belongs to. Starting it repoints the workspace and restarts it; stopping it puts the
   * workspace back. See setWorkspaceApi.
   */
  providesApi?: boolean;
  /**
   * This sidecar is a browser, and the Browser tab frames it rather than framing the workspace.
   *
   * Which is the only way that tab can show a workspace served at an origin of its own. See
   * ownOrigin: such a workspace is on a node port, on a development certificate nothing has
   * accepted, and a page on Rancher's origin cannot frame that — a subframe gets no certificate
   * interstitial to click through, so it fails silently. A browser inside the cluster has neither
   * problem, and it is served through the proxy on Rancher's own origin, so it frames.
   */
  providesBrowser?: boolean;
  /**
   * A memory-backed /dev/shm rather than the 64MB a container gets by default.
   *
   * Only a browser has needed it so far, and it is declared rather than given to everything
   * because it is the pod's own memory. See sidecarPodSpec.
   */
  shm?: boolean;
  /**
   * This sidecar is a browser, and gets the workspace's own Chromium extension mounted.
   *
   * Built per workspace rather than baked into an image, because what is in it is that
   * workspace's addresses and that workspace's generated passwords. See ensureBrowserExtension.
   */
  extension?: boolean;
  /**
   * Keys from this template's own secret declarations that this sidecar needs, arriving as
   * environment by reference under the key's own name. A sidecar whose key is not set says so on
   * its card and cannot be started, rather than starting and answering nothing.
   */
  secrets?: string[];
  /**
   * The same values again under another environment variable's name.
   *
   * Images rename their variables: Keycloak 26 reads `KC_BOOTSTRAP_ADMIN_PASSWORD` where earlier
   * versions read `KEYCLOAK_ADMIN_PASSWORD`, and the closet chart sets both so that one image
   * works either way. This is how a declaration says that without a second copy of the value.
   */
  secretEnv?: Record<string, string>;
  /**
   * Environment read off the pod itself rather than out of the declaration.
   *
   * The one thing this is for is the node's address, which nothing in this code knows and which the
   * OIDC issuer has to be: `status.hostIP` is the kubelet telling the pod where it is running.
   */
  fieldEnv?: Record<string, string>;
  /**
   * Publish this sidecar's Service on a node port as well as inside the cluster.
   *
   * The same trade the workspace's own origin makes, and it is offered for the same reason rather
   * than for convenience: an OIDC provider has to be at one address that both the browser and the
   * Rancher being configured can reach, and inside a vcluster there is no such address except the
   * node's. The cost is that the port is open to whoever can reach the node.
   */
  nodePort?: boolean;
  /** What this sidecar can be configured with, behind the card's gear. See DevSidecarParam. */
  params?: DevSidecarParam[];
  /** The Rancher auth providers this sidecar can back, in the order the card offers them. */
  auth?: DevAuthMode[];
  /**
   * This sidecar speaks MCP at this path, so what its card offers is the line that adds it to a
   * conversation rather than a link. The closet's card does the same thing for the same sidecar.
   */
  mcpPath?: string;
}

export interface DevTemplate {
  /** Stored on the namespace as a label, so the list can say what a workspace was made from. */
  id: string;
  label: string;
  description: string;
  image: string;
  /** Overrides the image's entrypoint. Omitted where the image already runs a server. */
  command?: string[];
  /** What the Service points at. */
  port: number;
  /**
   * How to speak to that port. The apiserver's service proxy takes the scheme as part of the
   * path (`https:name:port`), and rancher/dashboard's dev server is HTTPS, so getting this
   * wrong is a Browser tab that frames a connection error and a probe that never passes.
   */
  scheme?: 'http' | 'https';
  /**
   * The repository a workspace of this template works on.
   *
   * The template's own command clones it, and My Work asks GitHub about it: Dependabot alerts
   * belong to a repository rather than to a person, so the page needs to be told which one this
   * product is about rather than guessing from whatever is in a person's issue list.
   */
  repo?: string;
  /** The section icon in the sidebar, from Rancher's own icon font. */
  icon: string;
  /**
   * A brand image for that section instead of a glyph, by file name in the shell's assets.
   *
   * For a template whose mark is not in the icon font, which Rancher's own is not. Takes
   * precedence over `icon` where both are set. Not called `image`: that is already this
   * interface's word for the container a workspace runs. See DevList.
   */
  logo?: string;
  /** Where the workspace keeps a checkout and its node_modules between restarts. */
  hostPath?: string;
  /** Extra environment for the container. */
  env?: Record<string, string>;
  /**
   * This template's app has to be served at an origin of its own rather than behind the
   * apiserver's path-prefixed service proxy.
   *
   * rancher/dashboard builds its API URLs absolute from the page origin, so under the prefix its
   * `/v1` and `/v3` calls never reach its own dev server: they go to the Rancher this product is
   * served from, carrying that session, against that cluster. Counted on a running workspace: two
   * requests reached the workspace and a hundred and thirty-six reached the host. The workspace's
   * own API setting cannot win that argument, because the browser never asks it.
   *
   * So a template that says this gets a NodePort and a dev server built with no prefix. Its Browser
   * tab then cannot frame it directly, and frames a browser that can instead: see providesBrowser,
   * which is the same answer the harness reaches, whose Browser tab is a browser running beside the
   * project rather than the project itself.
   *
   * The cost is stated where it is offered: a node port is open to whoever can reach the node,
   * with no Rancher session in front of it. The browser sidecar does not need it - it reaches the
   * workspace by Service name - so what the port is left for is opening the workspace in a tab of
   * your own.
   */
  ownOrigin?: boolean;
  /** What this template's workspaces and sidecars need from the secret store. */
  secrets?: DevSecret[];
  /** The optional containers a workspace of this template can run beside itself. */
  sidecars?: DevSidecar[];
}

/**
 * The secrets that belong to no template.
 *
 * One list, next to the templates' own, because Settings renders both from the same declarations
 * and the only difference between them is the prefix the store puts on the key.
 */
export const GLOBAL_SECRETS: DevSecret[] = [
  {
    key:      'GH_TOKEN',
    label:    'GitHub token',
    help:     'A personal access token with repo and read:user. My Work reads your issues and pull requests with it, from the browser.',
    required: false,
  },
];

export const TEMPLATES: DevTemplate[] = [
  {
    id:            'rancher',
    label:         'Rancher',
    description:   'A rancher/dashboard checkout with its dependencies installed and the dev server running, pointed at the Rancher this cluster belongs to. The first boot is minutes: a clone, a yarn install and a first compile, and the workspace says which of them it is in.',
    // Plain node rather than a built image, for the reason the dev server this extension runs
    // in uses one: there is nothing to publish and nothing that can be older than the source.
    image:         'node:24',
    repo:          'rancher/dashboard',
    // Rancher's own mark rather than a generic angle bracket: this template is a
    // rancher/dashboard checkout, and the section heading is the one place in the column that
    // says which product a workspace belongs to.
    //
    // The glyph rather than the brand image, and that is the whole reason `logo` exists and is
    // not used here: the shell's small mark (pl/half-logo.svg) is a white shape on nothing,
    // drawn for the dark header bar, so on the light sidebar it is an element that loads, takes
    // its 16px and shows nothing at all. A font glyph takes currentColor and is legible in both
    // themes.
    icon:          'icon-rancher-desktop',
    port:          8005,
    // The dev server is told to serve plain http (see workspace-config.ts): Rancher's proxy
    // terminates TLS and will not talk to the shell's self-signed dev certificate on the way
    // through, so https here is a proxy error rather than more security.
    scheme:        'http',
    // See the field. What this workspace runs is rancher/dashboard, which is exactly the app that
    // cannot be served behind a path prefix without its API calls going to the wrong Rancher.
    ownOrigin:     true,
    // The checkout and node_modules, kept across restarts. Without it every restart is another
    // clone and another install, which is the difference between a workspace and a demo.
    hostPath:      '/var/lib/rancher/dev-workspaces',
    env:           {
      // What the dashboard talks to: this workspace's own Rancher, from the moment the workspace
      // exists, whether or not that Rancher has been started yet. Never the Rancher this product
      // runs in. A workspace at its own origin publishes a node port straight to this dev server,
      // and a dev server proxying to the host cluster's API is a way into that cluster from the
      // node's address; pointed at its own sidecar it refuses the connection until the sidecar is
      // there. See substituteTemplateEnv.
      API:          '{{ownRancher}}',
      NODE_OPTIONS: '--max_old_space_size=4096',
      // Where this dev server is reached, which its config turns into the router base, the
      // websocket path and the rest. `{{proxyPath}}` is substituted when the Deployment is
      // written, because the path contains the workspace's own name.
      DEV_PROXY_PATH: '{{proxyPath}}',
    },
    secrets: [
      {
        key:      'FIGMA_API_KEY',
        label:    'Figma API key',
        help:     'A personal access token from Figma. The Figma sidecar reads design files with it, and cannot be started without it.',
        required: true,
      },
      // Generated rather than asked for, and generated once. The closet chart makes exactly
      // these two the same way (randAlphaNum, kept across upgrades by a lookup), because they are
      // values that have to exist, that nobody has an opinion about, and that a person still has
      // to be able to read in order to log in to the sidecar they belong to.
      {
        key:       'KEYCLOAK_ADMIN_PASSWORD',
        label:     'Keycloak admin password',
        help:      'The password for Keycloak\'s own admin user. Generated the first time Keycloak is started and kept, so a realm you configure survives a restart.',
        required:  true,
        generated: true,
      },
      {
        key:       'RANCHER_BOOTSTRAP_PASSWORD',
        label:     'Rancher admin password',
        help:      'The password for admin in this workspace\'s own Rancher. Generated the first time the Rancher sidecar is started and kept, because it is what you log in with afterwards.',
        required:  true,
        generated: true,
      },
      {
        key:       'OPENLDAP_ADMIN_PASSWORD',
        label:     'OpenLDAP admin password',
        help:      'The password for cn=admin. Generated the first time OpenLDAP is started and kept, since the directory it protects is on a volume that outlives the pod.',
        required:  true,
        generated: true,
      },
      // The two values the auth switch needs and nobody has an opinion about, generated the same
      // way as the passwords above. The client secret is shared between Keycloak's own client and
      // Rancher's OIDC config, and the user password is what user1 logs in with in either provider,
      // which is the closet's arrangement: the same logins work across every provider.
      {
        key:       'KEYCLOAK_CLIENT_SECRET',
        label:     'Keycloak client secret',
        help:      'The secret of the `rancher` OIDC client in Keycloak. Generated, and the same value is written into Keycloak and into this workspace\'s Rancher.',
        required:  true,
        generated: true,
      },
      {
        key:       'AUTH_USER_PASSWORD',
        label:     'Auth test user password',
        help:      'The password of user1, the user created in Keycloak and in OpenLDAP so there is somebody to sign in as. Generated, and shown here because it is what you type.',
        required:  true,
        generated: true,
      },
      // The cloud credentials the closet's rancher sidecar declares, for the same use: a cluster
      // provisioned from the workspace's own Rancher without typing them in again. Not required,
      // because a workspace that never provisions anything needs none of them, and the bootstrap
      // only inserts a credential whose two halves are both set. See MANAGE_SCRIPT.
      {
        key:      'AWS_ACCESS_KEY',
        label:    'AWS access key',
        help:     'Inserted into this workspace\'s own Rancher as a cloud credential when it starts, so an EC2 cluster can be provisioned from it.',
        required: false,
      },
      {
        key:      'AWS_SECRET_KEY',
        label:    'AWS secret key',
        help:     'The other half of the AWS credential. Neither is used unless both are set.',
        required: false,
      },
      {
        key:      'AWS_DEFAULT_REGION',
        label:    'AWS region',
        help:     'The region that credential defaults to. us-west-2 when it is left empty.',
        required: false,
      },
    ],
    // Every image here was started in this cluster and reached Ready before it was given a
    // card. What is deliberately absent is a Rancher server: it cannot reach Running here (see
    // the note above), so it must not appear as something a person can press Start on.
    sidecars: [
      {
        id:          'rancher',
        group:       'Dev',
        label:       'Rancher',
        description: 'Rancher server - the app under test.',
        // The chart's manager image: helm and kubectl on alpine, which is all the script needs.
        image:       'dtzar/helm-kubectl:latest',
        command:     ['/bin/sh', '/scripts/manage.sh'],
        port:        443,
        scheme:      'https',
        // Rancher's UI rewrites itself out of a path prefix, so the proxy cannot serve it. What
        // this is for is the workspace's own dashboard, which reaches it by service name.
        launchable:  false,
        manager:     true,
        readyPort:   443,
        providesApi: true,
        scripts:     {
          'vcluster-values.yaml': VCLUSTER_VALUES.replace('{{dataPath}}', `${ SIDECAR_HOST_PATH }/{{namespace}}/vcluster-data`),
          'manage.sh':            MANAGE_SCRIPT,
          'auth.sh':              AUTH_SCRIPT,
          'pause.sh':             PAUSE_SCRIPT,
        },
        preStop: ['/bin/sh', '/scripts/pause.sh'],
        // The node's own address, which is the only address both a browser and a pod inside the
        // vcluster can reach. See nodePort on the keycloak sidecar.
        fieldEnv: { NODE_IP: 'status.hostIP' },
        env:      {
          NS:               '{{namespace}}',
          VCLUSTER_VERSION,
          // The name the certificate is issued for. It is not how anything reaches this Rancher
          // (the workspace uses the service name and the relay), and the chart's is likewise a
          // name that resolves nowhere; what it has to be is stable, so the certificate does not
          // change under a session.
          RANCHER_HOSTNAME: 'rancher.{{workspace}}.local',
        },
        // What the card's gear offers, which is the closet's own two: which Rancher to install and
        // whether it wears the Prime branding. Both are read by the manager script when it runs
        // the helm install, so changing either is a restart of this sidecar rather than of the
        // workspace. See MANAGE_SCRIPT.
        params: [
          {
            id:          'tag',
            label:       'Rancher version',
            env:         'RANCHER_TAG',
            default:     '',
            description: 'rancher/rancher image tag: blank for whatever the chart installs, or a released version (v2.11.3) to reproduce against what a customer runs.',
          },
          {
            id:          'prime',
            label:       'Rancher Prime branding',
            env:         'RANCHER_PRIME',
            type:        'boolean',
            default:     '',
            description: 'The SUSE Rancher Prime look (CATTLE_BASE_UI_BRAND=suse).',
          },
        ],
        // Everything the auth switch needs, by reference, because the manager is where it is used:
        // it is the only thing in the product holding an admin token for this Rancher, and the only
        // place that can reach Keycloak's admin API and OpenLDAP's port at once. See AUTH_SCRIPT.
        secrets: [
          'RANCHER_BOOTSTRAP_PASSWORD', 'KEYCLOAK_ADMIN_PASSWORD', 'KEYCLOAK_CLIENT_SECRET',
          'OPENLDAP_ADMIN_PASSWORD', 'AUTH_USER_PASSWORD',
          // By reference like the rest, so a cloud credential is not in the pod spec either.
          'AWS_ACCESS_KEY', 'AWS_SECRET_KEY', 'AWS_DEFAULT_REGION',
        ],
        // The chart's own name for it, which is also what the rancher chart's value is called.
        secretEnv: { CATTLE_BOOTSTRAP_PASSWORD: 'RANCHER_BOOTSTRAP_PASSWORD' },
      },
      {
        id:          'browser',
        group:       'Dev',
        label:       'Browser',
        description: 'Chromium with CDP, for driving the UI and recording.',
        // The image the closet's own browser sidecar runs, and the harness's Browser tab with it:
        // Chromium plus a web UI in front of it, so the thing being framed is a page rather than a
        // screen protocol the browser would need a plugin to speak.
        image:       'lscr.io/linuxserver/chromium:latest',
        // Its own UI, on the port CUSTOM_PORT tells it to serve. Plain http inside the cluster,
        // because Rancher's proxy terminates the TLS the person's browser sees and would not talk
        // to the image's self-signed certificate on the way through - the same trade the workspace
        // itself makes behind the proxy.
        port:        3000,
        scheme:      'http',
        // Unlike Rancher's UI and Keycloak's, this one survives a path prefix: every asset it asks
        // for is relative and its websocket is opened against the document's own URL. Verified
        // through the proxy before it was declared, which is what launchable is a claim about.
        launchable:  true,
        providesBrowser: true,
        shm:         true,
        extension:   true,
        env:         {
          // The image runs as this user and writes its profile as it. The workspace's own numbers,
          // for the same reason the closet passes PUID/PGID: a root-owned profile in a container
          // that then drops privileges is a browser that cannot start twice.
          PUID:       '1000',
          PGID:       '1000',
          // Where its web UI listens. The image serves http here and https one port up; this is the
          // http one, since it is the proxy rather than a person that connects to it.
          CUSTOM_PORT: '3000',
          // What the UI calls itself, which is what the framed page's own title bar says.
          TITLE:       '{{workspace}}',
          // What it opens on: this workspace's own Rancher, which is what the closet's browser
          // sidecar opens on too (RANCHER_BROWSER_START_URL defaults to https://rancher there).
          // The address is written in whether or not that sidecar is running, so the browser is
          // pointed at it from the first start and shows it the moment it comes up, rather than
          // having to be told where to go once something else has happened.
          //
          // The workspace's own dashboard is a tab away, at the address workspaceServiceUrl
          // gives, and the address bar in the framed browser is how you get there.
          //
          // The flags are the closet's for the same image, minus its CDP ones. --ignore-certificate-errors
          // is the one that is not cosmetic: both that Rancher and the workspace's dev server serve
          // their own certificates, and without this the browser opens on an interstitial instead.
          // --load-extension with --disable-extensions-except, which is the pair Chromium needs
          // to run an unpacked extension: the first says where it is and the second says that it
          // is the only one, which is also what stops the flag being ignored on a profile that
          // has none. See ensureBrowserExtension for what is in that directory.
          CHROME_CLI: '{{ownRancher}} --no-first-run --start-maximized --disable-infobars --disable-session-crashed-bubble --hide-crash-restore-bubble --ignore-certificate-errors --disable-extensions-except=/extension --load-extension=/extension',
        },
      },
      {
        id:          'keycloak',
        group:       'Auth',
        label:       'Keycloak',
        description: 'OIDC/SAML identity provider.',
        image:       'quay.io/keycloak/keycloak:26.0',
        args:        ['start-dev'],
        port:        8080,
        // OIDC is the one thing here that the browser takes part in: it is sent to the issuer and
        // sent back. So the issuer has to be an address a browser can reach, and it has to be the
        // same address the workspace's Rancher fetches the discovery document from, from inside a
        // vcluster. A cluster-internal name is only the second; a node port is both.
        nodePort:    true,
        auth:        [{ value: 'keycloak-oidc', label: 'OIDC' }],
        env:         {
          KEYCLOAK_ADMIN: 'admin', KC_BOOTSTRAP_ADMIN_USERNAME: 'admin', KC_HTTP_PORT: '8080'
        },
        secrets:   ['KEYCLOAK_ADMIN_PASSWORD'],
        // 26 reads the KC_BOOTSTRAP_ name and warns about the other; both are set so the
        // declaration does not have to be revised the next time the image renames it.
        secretEnv: { KC_BOOTSTRAP_ADMIN_PASSWORD: 'KEYCLOAK_ADMIN_PASSWORD' },
      },
      {
        id:          'openldap',
        group:       'Auth',
        label:       'OpenLDAP',
        description: 'LDAP directory server.',
        image:       'osixia/openldap:1.5.0',
        port:        389,
        // No node port and none needed: Rancher binds to LDAP itself, server to server, and the
        // browser only ever posts a username and a password to Rancher. That is why this is the
        // provider the product can prove end to end here and OIDC is the one with a caveat.
        auth:        [{ value: 'openldap', label: 'LDAP' }],
        // Nothing to open. The service proxy speaks HTTP and this port speaks LDAP, so a Launch
        // button here would open a page that could only ever be an error.
        launchable:  false,
        env:         {
          LDAP_ORGANISATION: 'dev', LDAP_DOMAIN: 'dev.local', LDAP_TLS: 'false'
        },
        secrets:   ['OPENLDAP_ADMIN_PASSWORD'],
        secretEnv: { LDAP_ADMIN_PASSWORD: 'OPENLDAP_ADMIN_PASSWORD' },
      },
      {
        id:          'figma',
        group:       'Design',
        label:       'Figma',
        description: 'Figma MCP server, for design references.',
        image:       'acuvity/mcp-server-figma:latest',
        // 8000, which is what the image listens on and what the closet's compose file publishes.
        // It was declared as 3000, so the Service pointed at a port nothing was bound to: the
        // container's own log says `minibridge frontend configured ... listen=:8000`, and 8080 is
        // its metrics endpoint rather than the MCP one.
        port:        8000,
        // Headless: it speaks MCP, not HTML, so there is nothing to open in a tab. The closet says
        // the same thing with `launch: false` and shows the address instead.
        launchable:  false,
        mcpPath:     '/mcp',
        secrets:     ['FIGMA_API_KEY'],
      },
    ],
    command: [
      '/bin/sh',
      '-c',
      [
        'set -e',
        // ---------------------------------------------------------------------------------
        // Root section, which is the same shape the dev server pod's boot.sh has and is there
        // for the same reason: a conversation runs claude in this tree, claude refuses
        // --dangerously-skip-permissions as root, and the files it edits are the ones the dev
        // server is watching. So the tree has to belong to an ordinary user and the dev server
        // has to be that same user, or the two fight over what they each write.
        //
        // The container's own user stays root, deliberately. `kubectl exec` runs as it, and the
        // terminal scripts need root once to install tmux and the claude CLI before they drop
        // to the node user themselves.
        // ---------------------------------------------------------------------------------
        `mkdir -p ${ WORKSPACE_HOME }`,
        `chown node:node /workspace ${ WORKSPACE_HOME } 2>/dev/null || true`,
        // Once, not every boot: after the first install this is tens of thousands of files, and
        // the hostPath keeps them between restarts. A workspace that predates this gets one
        // slow boot and is an ordinary node-owned tree afterwards.
        '[ -f /workspace/.owned ] || (chown -R node:node /workspace 2>/dev/null; touch /workspace/.owned)',
        // tmux and the claude CLI, in the background, because the dev server does not depend on
        // either and installing them here would put minutes in front of it. A conversation
        // opened before this finishes waits for it in shell.sh, where the waiting is visible.
        // HOME_DIR, because the script's default is the dev server pod's own and a workspace has
        // no /app: without it the last step, which pre-answers claude's first-run questions,
        // fails on a directory that is not there and the log ends in a node stack trace.
        `[ -f /seed/terminal-tools.sh ] && (HOME_DIR=${ WORKSPACE_HOME } /bin/sh /seed/terminal-tools.sh >/workspace/.terminal-tools.log 2>&1 &) || true`,
        // Everything below is the node user. setpriv rather than su, because it is what the dev
        // server pod's boot.sh uses to do the same thing and it does not bring a login shell's
        // environment with it.
        'exec setpriv --reuid=1000 --regid=1000 --init-groups /bin/sh -c \'' + [
          'set -e',
          `export HOME=${ WORKSPACE_HOME }`,
          // On the hostPath, so an install is not re-downloaded on every restart, and writable
          // by the user that runs it.
          'export YARN_CACHE_FOLDER=/workspace/.yarn-cache',
          // Each step is guarded by what it produces, so a restart resumes rather than repeats.
          `[ -d ${ WORKSPACE_WORKDIR }/.git ] || git clone --depth 1 https://github.com/rancher/dashboard ${ WORKSPACE_WORKDIR }`,
          `cd ${ WORKSPACE_WORKDIR }`,
          '[ -f .install-done ] || (yarn install --network-timeout 600000 && touch .install-done)',
          // The checkout is an ordinary clone, so its own config is the one that assumes a dev
          // server on its own origin. It is kept, under the name the shipped one requires, and
          // wrapped: see workspace-config.ts.
          //
          // The repo's copy is restored from git first, every boot. Guarding on the presence of
          // the .orig instead is what breaks on the second boot: the file in the tree is by then
          // the wrapper, and the guard saves the wrapper as the original, which then requires
          // itself. Restoring makes this idempotent and repairs a checkout that has already been
          // through that.
          'git checkout -- vue.config.js || true',
          'cp vue.config.js vue.config.orig.js',
          'cp /dev-config/vue.config.js vue.config.js',
          'exec yarn dev --port 8005',
        ].join(' && ') + '\'',
      ].join(' && '),
    ],
  },
];

export function templateById(id: string): DevTemplate | undefined {
  return TEMPLATES.find((template) => template.id === id);
}

/**
 * The browser a template's workspaces are framed in, if it declares one.
 *
 * Asked by the page, to decide whether there is a Browser tab at all, and by the tab itself, to
 * decide what its frame points at. One function so the two cannot come to different answers.
 */
export function templateBrowser(template: DevTemplate | undefined): DevSidecar | undefined {
  return (template?.sidecars || []).find((sidecar) => sidecar.providesBrowser);
}
