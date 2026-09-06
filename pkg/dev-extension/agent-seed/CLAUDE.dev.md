# How this environment differs from the harness

This is a Kubernetes workspace made by the dev extension, not a harness project container. The skills, rules and prompts above are the harness's, unchanged; only the machinery around them is different. `.claude/rules/environment.md` is the full account and replaces `sidecars.md` and `project-environment.md`, which are not here. The short version:

- **Code**: `/workspace/dashboard` is the checkout (`origin` = your fork, `upstream` = rancher/dashboard). Its dev server is already running at `https://localhost:8005` and reloads on edit; do not start or stop one.
- **Rancher**: `https://$RANCHER_HOST_NAME` is a shared Rancher this workspace points at, not your own sidecar. There is no admin password (`RANCHER_ADMIN_USER`/`RANCHER_ADMIN_PASS` are unset); you are its user through `RANCHER_TOKEN` in `/workspace/.env`, and `node /workspace/bin/rancher-login.mjs` signs the browser in. Do not change its version, branding or auth provider, and delete what you create in it.
- **Browser**: Chromium is a container in this pod with CDP on `$CLAUDE_BROWSER_CDP`. `wait-for-sidecars` only waits; nothing needs starting. `browser.mjs` and the recording skills work as in the harness.
- **Harness API**: `$CLAUDE_HARNESS_API` (= `$HARNESS_API`) answers the `/my-work/...` routes with no credential. The sidecar and Jira routes do not exist here.
- **Accessibility**: `a11y axtree` works; `a11y tier` and the speech/Orca stack do not.
- **Publishing**: `gh` is signed in; commit and open draft PRs exactly as the skills say. The person you work for sees uncommitted changes in the workspace's Review tab and the PR in its PR tab.
