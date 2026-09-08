# This environment

This workspace is a Kubernetes pod the dev extension made, standing in for the harness's project container. The skills, rules and prompts are the harness's, unchanged. What follows is what is different, and what looks like breakage but is not.

## What is where

- `/workspace/dashboard` is the rancher/dashboard checkout and your working directory. `origin` is the fork pushes go to, `upstream` is rancher/dashboard, the same as the harness.
- The dev server for that checkout is already running, as the pod's main process, at `https://localhost:8005`. It rebuilds on edit. Do not start a second one, and do not kill it: it is the pod.
- `$RANCHER_URL` (= `$API` in the shell) is the Rancher this workspace points at, the one the dev server runs against. It is shared and long-lived, not a sidecar of yours. It may be the **parent** Rancher in this cluster (`rancher.cattle-system.svc` internally) or a **downstream** one the parent manages (a `*.sslip.io` address); which one is not fixed, so read it rather than assume. Note the shell `$RANCHER_URL` and the `RANCHER_URL`/`RANCHER_HOST_NAME` in `/workspace/.env` can differ - see "The Rancher" below.
- Chromium is a second container in this pod. CDP is on `$CLAUDE_BROWSER_CDP` (localhost:9222) and the browser opened on the dev server when the pod started. `/workspace/browser.mjs`, `/workspace/axtree.mjs` and the recording skills work exactly as in the harness. What you record lands in `/workspace/artifacts`, which the browser container also sees as `/artifacts`.
- `/workspace/bin` has `wait-for-sidecars`, `git-fix-commit`, `a11y`, `rancher-login.mjs`, `gh`, `jq`. It is on the PATH of every pane, and the same commands are in `~/.local/bin`.
- `$CLAUDE_HARNESS_API` and `$HARNESS_API` are the same URL: the dev extension's in-cluster API. It answers every `/my-work/...` route the skills use (PR detail, comments, review-run, CI, dependabot) with no credential. It does not answer `/projects/.../sidecars...`, `/sidecars/start`, or the Jira routes: there is nothing behind them here.

## Environment variables

The container itself carries `API`, `RANCHER_URL`, `HARNESS_API`, `CLAUDE_HARNESS_API`, `HARNESS_PROJECT`, `PROJECT_NAME` and `CLAUDE_BROWSER_CDP`, so every shell and every tool call sees them. `RANCHER_HOST_NAME` and `KUBECONFIG` come from `.claude/settings.json`.

`/workspace/.env` has all of those plus the two secrets, `RANCHER_TOKEN` and `GH_TOKEN`. A script that needs a secret sources it:

```bash
set -a; source /workspace/.env; set +a
```

`RANCHER_ADMIN_USER` and `RANCHER_ADMIN_PASS` are unset. There is no local admin password to type: this Rancher's people sign in with GitHub. See the next section.

## The Rancher: signing in, and what not to do

You act in Rancher as the person who made this workspace, through `RANCHER_TOKEN`:

- API: `curl -sk -H "Authorization: Bearer $RANCHER_TOKEN" $RANCHER_URL/v3/users?me=true`
- **The token belongs to one Rancher, and a 401 means you aimed it at the wrong one.** `RANCHER_TOKEN` authenticates against exactly one Rancher - the parent, or a downstream one, not both. `/workspace/.env` is written once when the workspace is set up and is not rewritten when the target changes, so its `RANCHER_URL`/`RANCHER_HOST_NAME` can name a Rancher the token no longer matches, while the shell's `$RANCHER_URL` (what the dev server uses) still matches. So a `401` is not a dead token to work around - it is the wrong host. Do not spend time proving the token is invalid; find the host it is *for* and use that:

  ```bash
  for U in "$RANCHER_URL" "$API" "$(grep '^RANCHER_URL=' /workspace/.env 2>/dev/null | cut -d= -f2-)"; do
    [ -n "$U" ] && [ "$(curl -sk -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $RANCHER_TOKEN" "$U/v3/users?me=true")" = 200 ] && { export RANCHER_URL="$U" API="$U"; echo "Rancher is $U"; break; }
  done
  ```

  If none answer `200`, the token is genuinely stale (they expire) - say so and ask the user to reopen the workspace, rather than digging further.
- Browser: `node /workspace/bin/rancher-login.mjs` sets the session cookie for the Rancher's origin and for `localhost:8005`, so the tab is signed in without a login form. Run it after `wait-for-sidecars` and before a screenshot or recording that needs a session. If a page still shows the login form, the cookie is missing for that origin: run it again.
- `kubectl` uses `$KUBECONFIG`, which points at the Rancher's local cluster as that user.

Because it is shared: do not change its version, branding or auth provider (the harness's `sidecars/config` route does not exist here for that reason), do not restart it, and delete anything you create in it (clusters, users, projects, settings) once you are done with it. A reproduction that needs a specific Rancher version cannot be done here; say so in your summary instead of reporting "does not reproduce".

## Sidecars

`wait-for-sidecars` blocks until CDP and the Rancher answer, and that is all it does: there is nothing to start. `wait-for-sidecars browser` and `wait-for-sidecars rancher` work. The stop endpoint the harness had does not exist; there is nothing to stop.

## Accessibility

The whole stack works here, as it does in the harness, and `.claude/rules/accessibility.md` is the guide to it. What is different is only how the two halves reach each other.

`a11y axtree ...` reads Chromium's own accessibility tree over CDP and needs nothing installed. Everything else - `a11y tree`, `say`, `record`, `orca`, `key`, `type`, `screen`, `click`, `shot`, `desktop` - runs inside the browser container, because AT-SPI, X and PulseAudio belong to that desktop; this container reaches it with `kubectl exec -c browser` (its ServiceAccount is the pod's), where the harness used its API.

The AT-SPI bridge and speech (espeak-ng, speech-dispatcher, sox, xdotool) are installed in every workspace's browser, and Chromium is started with `--force-renderer-accessibility` on a session bus, so `a11y enable` and `a11y tree` work without setting anything up. Orca is the exception: `a11y tier orca` installs it and switches that desktop to X11, which replaces the browser container and takes a few minutes - the same trade the harness makes, for the same reason.

## Publishing

`gh` is signed in and `git push origin <branch>` works with the credential helper the harness uses. Commits and draft PRs go exactly as the skills describe (`my-commit-create`, `my-pr-create`). The person you work for sees uncommitted changes in the workspace's Review tab and the PR in its PR tab; review comments you file through `$CLAUDE_HARNESS_API/my-work/pr/<N>/comments` appear there as pending until they submit them.

## Things that look broken

- `git` as root refuses `/workspace/dashboard` ("dubious ownership"). Every pane runs as `node`, which owns the tree, so this only comes up if you `su` to root. Do not.
- `node_modules` belongs to `node`, and `yarn install` works. There is no `sudo` and no root shell; anything that needs a system package is not available unless `ffmpeg`, `jq`, `lsof` and `ss` already are (they are installed on boot).
- `yarn lint` and `yarn type-check` walk the whole repo and take minutes. Scope them while iterating:

```bash
./node_modules/.bin/eslint --max-warnings 0 <changed files>
npx jest --ci <path or pattern>
yarn type-check
```
