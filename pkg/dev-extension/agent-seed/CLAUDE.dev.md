# How this environment differs from the harness

This is a Kubernetes workspace made by the dev extension, not a harness project container. The skills, rules and prompts above are the harness's, unchanged; only the machinery around them is different. `.claude/rules/environment.md` is the full account and replaces `sidecars.md` and `project-environment.md`, which are not here. The short version:

- **Code**: `/workspace/dashboard` is the checkout (`origin` = your fork, `upstream` = rancher/dashboard). Its dev server is already running at `https://localhost:8005` and reloads on edit; do not start or stop one.
- **Rancher**: a shared Rancher this workspace points at, not your own sidecar. You are its user through `RANCHER_TOKEN` (no admin password; `RANCHER_ADMIN_USER`/`RANCHER_ADMIN_PASS` are unset), and `node /workspace/bin/rancher-login.mjs` signs the browser in. Do not change its version, branding or auth provider, and delete what you create in it. **Which URL is it?** The shell's `$RANCHER_URL`/`$API` (the ones the dev server runs against) are authoritative; `/workspace/.env` also has a `RANCHER_URL`/`RANCHER_HOST_NAME`, but `.env` is written once at setup and can name a *different* Rancher than the one your token is for. This Rancher may be the parent Rancher in this cluster or a downstream one it manages, and a token for one gets a **401** from the other. So do not assume: verify once, and use the URL that answers `200`:

  ```bash
  for U in "$RANCHER_URL" "$API" "$(grep '^RANCHER_URL=' /workspace/.env | cut -d= -f2-)"; do
    [ -n "$U" ] && [ "$(curl -sk -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $RANCHER_TOKEN" "$U/v3/users?me=true")" = 200 ] && { echo "use $U"; break; }
  done
  ```
- **Browser**: Chromium is a container in this pod with CDP on `$CLAUDE_BROWSER_CDP`. `wait-for-sidecars` only waits; nothing needs starting. `browser.mjs` and the recording skills work as in the harness.
- **Harness API**: `$CLAUDE_HARNESS_API` (= `$HARNESS_API`) answers the `/my-work/...` routes with no credential. The sidecar and Jira routes do not exist here.
- **Accessibility**: the whole toolkit works. `a11y axtree` reads Chromium's tree over CDP; `a11y tree`, `say`, `record`, `orca`, `key`, `type`, `screen`, `click` and `shot` run in the browser container, which this one reaches with `kubectl exec -c browser` rather than through a harness API. AT-SPI and speech are installed already; `a11y tier orca` adds Orca and restarts that container.
- **Publishing**: `gh` is signed in; commit and open draft PRs exactly as the skills say. The person you work for sees uncommitted changes in the workspace's Review tab and the PR in its PR tab.
