# DevExtension, from inside the pod

You are running in the pod that serves this extension, in the tree it serves. `/app` is a
whole Rancher dashboard build with this package (`/app/pkg/dev-extension`) compiled into it,
and `vue-cli-service serve` is watching it. Every file you save here is recompiled and
pushed into the browser over the hot-reload socket, usually within a few seconds. That
includes `/app/node_modules/@rancher/shell`, which is watched too, so the login page, the
nav and the rest of the dashboard are editable the same way.

So: edit files and look at the result. There is no build step to run and no server to
restart, and restarting the dev server is the one thing that will interrupt the person
watching it.

- `pkg/dev-extension/` is this extension: `product.ts` (nav entries), `routing/index.ts`,
  `pages/`, `models/` (overrides of the shell's models, which win over the shell's own).
- It registers two products. `devextension` is the live-reload demo. `dev` is the Claude
  Harness rebuilt on Kubernetes: a workspace is a namespace with a Deployment and a Service,
  started and stopped by scaling, with a terminal on the pod's exec subresource. Its
  Kubernetes calls are in `api.ts`, the container each workspace runs is in `templates.ts`,
  and the terminal is `components/DevTerminal.vue`, which will point at any pod given a
  namespace, labels, a container and an argv.
- The `dev` product's nav is Workspaces, Terminal, My Work, Templates, Settings. A workspace
  opens as tabs (Overview, Conversations, Browser, Ports) at
  `/dev/c/_/workspaces/<name>#<tab>`; the tab is the hash rather than a path segment, and
  `pages/WorkspaceDetail.vue` says at the top why that is not cosmetic. Terminal is the same
  DevTerminal pointed at this pod, running `/seed/shell.sh <session> /app/.sessions/<session>`,
  so it is a tmux session that survives the browser and a conversation of its own. My Work and
  Settings are deliberately empty pages describing what they are waiting on, which is a GitHub
  token in a Secret and shared claude credentials.
- Editing anything in `pod/` needs three steps, and the third is the one that gets forgotten:
  edit it in the repo, regenerate the seed, then `scripts/apply-dev-extension-seed.mjs` to put
  it in the ConfigMap this pod mounts at `/seed`. Without the third it only reaches a fresh pod;
  patched by hand instead, the extension writes its own copy back over it on the next load.
- The harness calls a workspace a project. This does not, because Rancher's own nav already
  uses that word for a group of namespaces in a cluster. The `dev-` namespace prefix is
  unchanged by that: it names the product, not the concept.
- The dashboard is reached through the Kubernetes service proxy, not on its own port. Never
  hardcode a hostname; every URL the build hands out is derived from the proxy path in
  `/app/vue.config.js`.
- `yarn` is available. Adding a dependency means an install in here, which is slow and
  survives only as long as this pod's `/app` does.

## What you can reach from here

This pod runs as the `barn-extension` ServiceAccount, bound to **cluster-admin**, and `kubectl`
is installed. So every resource in the cluster this Rancher manages is readable and writable
from a terminal in here, including Rancher's own, which are CRDs in the same apiserver:

```bash
kubectl get settings.management.cattle.io      # what Rancher is configured to do
kubectl get projects.management.cattle.io -A   # its grouping of namespaces
kubectl get clusterrepos.catalog.cattle.io     # where its Apps come from
kubectl get uiplugins.catalog.cattle.io -A     # extensions installed into its UI
kubectl api-resources | grep cattle.io         # the rest, and there is a lot of it
```

That is deliberate: an extension is mostly a UI over those resources and cannot be tried from a
pane that gets 403 to every question about them. It is also a live Rancher somebody is looking
at, so read freely and say what you are about to change before you change it.

The dashboard's own components are the best documentation available and they are already here:
`/app/node_modules/@rancher/shell/components` and `.../components/form`. `SortableTable`,
`LabeledSelect`, `AsyncButton`, `Banner`, `AppModal` and `Card` cover most of what a page needs.
The published docs are at <https://extensions.rancher.io/extensions/next/home>.

## The browser you can look at it in

Editing here is only half a loop. The other half is a Chromium in this namespace with its
DevTools protocol open, so you can open the page you just changed and see what it did rather
than describing what it should have done. One browser serves every extension in here, and
somebody may be watching it, so leave it somewhere sensible and expect tabs you did not open.

**Where to point it.** `https://$NODE_IP$DEV_PROXY_PATH/` - both are set on this pod.
`DEV_PROXY_PATH` is the service-proxy path this dev server is reached at, and it is
root-relative, which means nothing to something driving a browser from outside a page: it has
to be made absolute. `NODE_IP` is what it is absolute against, and it is Rancher's address
because this cluster is k3s inside the Rancher container - the node and Rancher are one
address. Never write a hostname in yourself; those two are the whole URL.

**Where the browser is, and the one trap in it.** `$BARN_BROWSER_SERVICE` names the Service
(`barn-browser`) and `$BARN_BROWSER_CDP_PORT` its port. You have to resolve that name to an
address yourself:

```bash
CDP="http://$(kubectl -n barn get svc "$BARN_BROWSER_SERVICE" -o jsonpath='{.spec.clusterIP}'):$BARN_BROWSER_CDP_PORT"
```

Chromium validates the `Host` header on the debugging port and answers anything that is not an
IP or `localhost` with a 403, so `http://barn-browser:9222` fails and the ClusterIP works. This
is also why there is no environment variable holding a ready-made CDP URL: one would look like
an endpoint and behave like a bug. A pod older than the browser has neither variable; the
Service is `barn-browser` on 9222 either way.

### Getting past the login page

A fresh profile has no Rancher session, so the first navigation lands on Rancher's login page
rather than your dashboard. Rancher's session is a cookie whose value is an API token, so mint
one from the endpoint the rest of this product uses:

```bash
curl -sk -X POST "https://$NODE_IP/v3-public/localProviders/local?action=login" \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"<the admin password>"}' | jq -r .token
```

That token is the whole value of the `R_SESS` cookie. Set it over CDP (`Network.setCookie`,
domain `$NODE_IP`) before navigating, and the dashboard loads logged in.

The password is the one thing this pod is not given. If you have not been told it, ask - do not
guess, and do not go fishing for it in Secrets you happen to be able to read. The alternative
that needs no password is to log in once by hand in the browser's own web UI: the session lives
in the profile and lasts until that pod restarts, which is usually longer than the work.

### Driving it

Node 24 is what runs here and it has `fetch` and `WebSocket` built in, so this needs no install
- which matters, because `yarn add` in this pod is slow and survives only as long as `/app`.

```js
const cdp = process.env.CDP;                       // resolved as above
const url = `https://${ process.env.NODE_IP }${ process.env.DEV_PROXY_PATH }/`;

// A tab of your own rather than the one somebody is looking at.
const tab = await (await fetch(`${ cdp }/json/new?${ encodeURIComponent(url) }`, { method: 'PUT' })).json();

// The websocket URL comes back with 127.0.0.1 in it, because that is the address Chromium
// thinks it is on: it binds CDP to loopback and a forwarder in the pod republishes it. Point
// it back at the address you reached it on or the connection is refused.
const ws = new WebSocket(tab.webSocketDebuggerUrl.replace('ws://127.0.0.1:9222', cdp.replace('http://', 'ws://')));
let id = 0;

await new Promise((ok) => { ws.onopen = ok; });
const send = (method, params = {}) => ws.send(JSON.stringify({ id: ++id, method, params }));

// Console output and page errors are most of what you are looking for: a change that failed to
// compile shows up here long before it shows up in a picture.
ws.onmessage = (e) => console.log(e.data.slice(0, 400));
send('Runtime.enable');
send('Log.enable');
```

`Page.captureScreenshot` returns base64 PNG when you want a picture rather than a log. It works
with nobody watching because a keepalive service in that pod holds the display open; without it
the display collapses to 1x1 and the call hangs rather than failing, which is worth knowing if
screenshots ever start timing out.

Two things about this dev server in particular:

- **A save is not instant.** The compile is a few seconds and the result is pushed to the page
  over the hot-reload socket. Navigating immediately after a save shows you the old page or a
  half-compiled one, so wait for the recompile rather than racing it.
- **Hot reload needs the session too.** That socket rides the same proxy, so it works on every
  page you are logged in for and not on the login page. A page that never updates is usually a
  page that is not logged in.

## This tree is not the repo

Nothing here is checked out from git and nothing syncs back. The repo copy lives in
`pkg/barn/dev-extension/` in the barn repo, and it is what a fresh pod is
seeded from, so a change that should outlive this pod has to be copied back there (and the
seed regenerated with `node scripts/gen-dev-extension-seed.mjs`).

If you are asked to make a change permanent and you cannot reach the repo, say so rather
than assuming the edit will survive.
