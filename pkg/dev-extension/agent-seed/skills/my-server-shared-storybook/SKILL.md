---
name: my-server-shared-storybook
description: Build this workspace's Storybook as a static site and publish it on its public preview, returning the sslip.io link. Mirrors the dev-extension Share tab's "Storybook" build. Use only when the change touches pkg/rancher-components, to give a reviewer the component stories for the change.
---

This shares **Storybook**, which is only meaningful when the change is to the components it documents. **Only run it when the diff touches `pkg/rancher-components`** (`git diff --name-only master...HEAD | grep -q '^pkg/rancher-components/'`). For the dashboard itself, use `my-server-shared-dev`.

## Run it

The bundled script builds Storybook in a worktree, refreshes the preview, and prints the URL on its last line.

```bash
sh ~/.claude/skills/my-server-shared-storybook/share.sh storybook
```

The script is seeded to `~/.claude/skills/my-server-shared-storybook/share.sh` (also `.claude/skills/...` under the checkout). Progress goes to stderr; the URL is the last line of stdout. The build takes a few minutes; the script waits and only then prints the link.

## What you get

- **Last line of stdout is the URL**, e.g. `https://preview-<workspace>.dev-extension.<ip>.sslip.io/`. Capture that line; progress goes to stderr.
- The link is public and needs no login. It is a static build, current as of this run.

## When there is no preview yet

As with `my-server-shared-dev`, standing up a preview the first time is a browser action. If none is live the script still builds and prints the URL, and says on stderr to open the Share tab once and press **Build and share Storybook**. Report that rather than presenting the link as already live.

## Keep it fresh

Re-run after any further component change you want reflected. `my-pr-create` re-runs it automatically when it includes the Storybook link in a PR.
