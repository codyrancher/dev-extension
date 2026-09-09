---
name: my-server-shared-dev
description: Build this workspace's dashboard as a static site and publish it on its public preview, returning the sslip.io link a reviewer can open without an account here. Mirrors the dev-extension Share tab's "Rancher dashboard" build. Use to share a running change for review, or from my-pr-create to put a live link in the PR.
---

This shares the **dashboard**. For a Storybook link, use `my-server-shared-storybook` (only when the change touches `pkg/rancher-components`).

## Run it

One command. The script is bundled next to this file; it builds in a worktree (the dev server is never touched), refreshes the preview so it serves the new build, and prints the URL on its last line.

```bash
sh ~/.claude/skills/my-server-shared-dev/share.sh dashboard
```

The script is bundled beside this SKILL.md and seeded to `~/.claude/skills/my-server-shared-dev/share.sh` (also `.claude/skills/...` under the checkout). Progress goes to stderr; the URL is the last line of stdout. The build takes a few minutes; the script waits for it and only then prints the link.

## What you get

- **Last line of stdout is the URL**, e.g. `https://preview-<workspace>.dev-extension.<ip>.sslip.io/dashboard/`. Capture that line; everything else is progress on stderr.
- The link is public and asks for no login (it talks to the workspace's Rancher). It reflects the code **as built just now**, uncommitted changes included.

## When there is no preview yet

Creating a preview the first time is a browser action (Apps Plus renders it), so the script cannot stand one up headlessly. If none is live it still builds and prints the URL, and says on stderr to open the workspace's **Share tab once** and press **Rebuild** to publish it. Report that to the user rather than presenting the link as live: say the link and that it goes live after that one-time click.

## Keep it fresh

The link serves a **static build**, not the live dev server, so it is only current as of the last run. Re-run this after any further change you want reflected in the link. `my-pr-create` does this automatically whenever it includes the link in a PR.
