# This environment

This workspace is a Kubernetes pod the dev extension made, standing in for the harness's project container. The skills, rules and prompts are the harness's, unchanged. What follows is what is different, and what looks like breakage but is not.

## What is where

- `/workspace/dashboard` is the rancher/dashboard checkout and your working directory. `origin` is the fork pushes go to, `upstream` is rancher/dashboard, the same as the harness.
- The dev server for that checkout is already running, as the pod's main process, at `https://localhost:8005`. It rebuilds on edit. Do not start a second one, and do not kill it: it is the pod.
- `https://$RANCHER_HOST_NAME` (also `$RANCHER_URL` and `$API`) is the Rancher this workspace points at. It is shared and long-lived, not a sidecar of yours.
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
- Browser: `node /workspace/bin/rancher-login.mjs` sets the session cookie for the Rancher's origin and for `localhost:8005`, so the tab is signed in without a login form. Run it after `wait-for-sidecars` and before a screenshot or recording that needs a session. If a page still shows the login form, the cookie is missing for that origin: run it again.
- `kubectl` uses `$KUBECONFIG`, which points at the Rancher's local cluster as that user.

Because it is shared: do not change its version, branding or auth provider (the harness's `sidecars/config` route does not exist here for that reason), do not restart it, and delete anything you create in it (clusters, users, projects, settings) once you are done with it. A reproduction that needs a specific Rancher version cannot be done here; say so in your summary instead of reporting "does not reproduce".

## Sidecars

`wait-for-sidecars` blocks until CDP and the Rancher answer, and that is all it does: there is nothing to start. `wait-for-sidecars browser` and `wait-for-sidecars rancher` work. The stop endpoint the harness had does not exist; there is nothing to stop.

## Accessibility

`a11y axtree ...` works (Chromium's accessibility tree over CDP). `a11y tier` and the AT-SPI, speech and Orca stack do not exist here; the `my-a11y-*` skills that depend on them cannot be completed in this environment, and the honest result is to say so.

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
