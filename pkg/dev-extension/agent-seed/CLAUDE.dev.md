# How this environment differs from the harness

{{#if leased}}**This is a leased workspace, and it runs nothing.** The checkout, the artifacts and the
command-line tools are here; a dev server, a browser, a Firefox, a storybook and a Rancher are
*tools* you attach while you need them and release when you are done - `tools`, `tools start
dev-server`, `tools stop dev-server`. `.claude/rules/tools.md` is the whole of it, and it overrides the
bullets below wherever they disagree: there is no dev server on `localhost:8005` in this pod,
there is no Chromium container beside you (the browser is shared, and `tools start browser`
gives you a session of your own on it), and `dev-server ...` still works because it hands every
verb to `tools`. Release what you attached before you write your summary.

{{/if}}
This is a Kubernetes workspace made by the dev extension, not a harness project container. The skills, rules and prompts above are the harness's, unchanged; only the machinery around them is different. `.claude/rules/environment.md` is the full account and replaces `sidecars.md` and `project-environment.md`, which are not here. The short version:

- **Code**: `/workspace/dashboard` is the checkout (`origin` = your fork, `upstream` = rancher/dashboard). Its dev server is already running at `https://localhost:8005` and reloads on edit. `dev-server status` says which Rancher it runs against, `dev-server --api URL` points it at another one (it restarts and compiles again, 1-3 minutes), `dev-server logs` shows its output and `dev-server restart` restarts it. **Never start a second dev server**, on any port: two webpacks exceed the pod's memory, the container is OOM-killed under both, and every command you were running in it dies with it - and the pod stops its own server while yours runs, so nothing is gained either.
- **Rancher**: a shared Rancher this workspace points at, not your own sidecar. You are its user through `RANCHER_TOKEN` (no admin password; `RANCHER_ADMIN_USER`/`RANCHER_ADMIN_PASS` are unset), and `node /workspace/bin/rancher-login.mjs` signs the browser in. Do not change its version, branding or auth provider, and delete what you create in it. **Which URL is it?** Your shell's `$RANCHER_URL`/`$API` come from `/workspace/.env`, which is written once at setup; the dev server runs against the pod's own `API`, which `dev-server status` shows, and the two can name *different* Ranchers - the one your token is for, and one it gets a **401** or a **404** from. This Rancher may be the parent Rancher in this cluster or a downstream one it manages, and a token for one gets a **401** from the other. So do not assume: verify once, and use the URL that answers `200`:

  ```bash
  for U in "$RANCHER_URL" "$API" "$(grep '^RANCHER_URL=' /workspace/.env | cut -d= -f2-)"; do
    [ -n "$U" ] && [ "$(curl -sk -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $RANCHER_TOKEN" "$U/v3/users?me=true")" = 200 ] && { echo "use $U"; break; }
  done
  ```

  If that is not the URL `dev-server status` shows, `dev-server --api <that URL>` points the running server at it: that, not a server of your own.
- **Its preferences belong to a person, not to you**: every dashboard you drive - the shared browser and your own dev server alike - is signed in as the person you work for, so Rancher's user preferences (theme, pinned clusters, table views, landing page) are *theirs*. Do not tidy them. The theme is the one that used to leak: the dev extension re-registers it as a cookie of the browser it is loaded in, so switching to light to check a bug now stays with you - but a dashboard without the extension writes it straight to their account, and there the local flip is

  ```js
  document.querySelector('#app').__vue_app__.config.globalProperties.$store.commit('prefs/load', { key: 'theme', value: 'light' })
  ```

  which repaints immediately and is forgotten on reload. Worth knowing either way: `Shift+T` toggles the theme for anybody whose `plugin-developer` preference is set, and the shortcut is only suppressed inside inputs - so a stray keystroke with focus on the page body flips it with nothing to point at.
- **Browser**: Chromium is a container in this pod with CDP on `$CLAUDE_BROWSER_CDP`. `wait-for-sidecars` only waits; nothing needs starting. `browser.mjs` and the recording skills work as in the harness.
- **Firefox**: `tools start firefox` attaches one, for a bug that only happens outside Chromium. It is **not** a second Chromium and **not** CDP: Firefox has had no DevTools Protocol since version 129, so `/json/version` answers 404 and `browser.mjs`, `a11y axtree` and anything else built on CDP will not drive it. It speaks **WebDriver BiDi**, and the endpoint is the session - connect a websocket to the `bidi` address `tools` prints for it, then:

  ```
  session.new  {"capabilities": {"alwaysMatch": {"acceptInsecureCerts": true}}}
  browsingContext.getTree {}                    -> contexts[0].context
  browsingContext.navigate {"context": ..., "url": ..., "wait": "complete"}
  script.evaluate {"expression": "document.title", "target": {"context": ...}}
  browsingContext.captureScreenshot {"context": ...}    -> base64 PNG
  session.end {}
  ```

  **One session at a time.** A second `session.new` is refused with "Maximum number of active sessions", and a client that disconnects without ending its session holds the browser until the pod restarts - so always `session.end`, and if you inherit a locked one, `tools stop firefox` then `tools start firefox` replaces the pod, which is the reliable reset. `data:` URLs are refused by this build; navigate to a real URL. The desktop on its `http` address is what a person watches, so a screenshot taken there is what they will compare against.
- **Harness API**: `$CLAUDE_HARNESS_API` (= `$HARNESS_API`) answers the `/my-work/...` routes with no credential. The sidecar and Jira routes do not exist here.
- **Accessibility**: the whole toolkit works. `a11y axtree` reads Chromium's tree over CDP; `a11y tree`, `say`, `record`, `orca`, `key`, `type`, `screen`, `click` and `shot` run in the browser container, which this one reaches with `kubectl exec -c browser` rather than through a harness API. AT-SPI and speech are installed already; `a11y tier orca` adds Orca and restarts that container.
- **The disk under you is shared with every other workspace on this node**, and three things follow from it. **The package caches are one store**: `YARN_CACHE_FOLDER`, `npm_config_cache` and `CYPRESS_CACHE_FOLDER` all point into `/workspaces/.shared`, so an install here is usually a copy out of a cache somebody else's branch already filled. Leave them where they are - a cache dir of your own re-downloads a gigabyte, and `yarn cache clean` empties the store for all of them. **Installed packages are hardlinked across workspaces**: a sweep runs daily and collapses identical files into one inode, so editing a file under `node_modules` in place edits it in every workspace that has the same version. Patch a dependency the way the ecosystem does - a `resolutions` entry, a patch file, a copy into the repo - never with an editor pointed at `node_modules`. **The command-line tools are one install too**: `bin/gh` and `bin/jq` are symlinks into `/workspaces/.shared/tools`, so replace one by pointing the symlink somewhere else, not by writing over it. Your checkout is yours alone and none of this touches it.
- **Artifacts outlive this workspace**: everything you leave under `/workspace/artifacts` - recordings, screenshots, a11y reports, review notes - is kept on the node after the workspace itself is gone, and nothing deletes it but a person choosing to. So it is worth writing for a reader who arrives months later with no pod to ask: name a file for what it shows rather than for the run that made it, and say in the review note what the recording is of.
- **A Rancher of your own, on one EC2 instance**: `node /seed/rancher-ec2.mjs create <name>` in the agent pod, with `RANCHER_EC2_CREDENTIAL` naming the amazonec2 cloud credential (`cc-5snk6` here - the other one on this account is DigitalOcean, so check before you reach for it). It launches an instance whose user-data installs docker and runs `rancher/rancher` with `--restart=unless-stopped`, finds the newest Ubuntu 24.04 AMI itself, and finds-or-creates a `rancher-ec2` security group with 80 and 443 open and no SSH. `create` prints the bootstrap password **once** - it is never written to the cluster - and `list`, `sync` and `delete <name>` do what they say. Rancher answers in three or four minutes; `/ping` returning 200 is the signal.

  This is **not** the same thing as an Apps Plus `rancher-single` instance, and the difference matters for what you can do with one. There is no cluster registered with this Rancher, so there is no Fleet target, no `clusterId`, and nothing can be delivered to it the way a workspace share is - `pickShareHost` will not choose it. What it is good for is a real Rancher, at a public address, that nothing else has to keep alive: three moving parts instead of seven, and none of them a tunnel back to this machine.

  The sidebar lists these beside the Apps Plus ones, from `dev-rancher-ec2` in dev-system - a ConfigMap the tool rewrites on every create, delete and sync, because a browser cannot call EC2. If an instance you made is missing from the list, run `sync`; nothing polls AWS on its own.
- **Publishing**: `gh` is signed in; commit and open draft PRs exactly as the skills say. The person you work for sees uncommitted changes in the workspace's Review tab and the PR in its PR tab.
