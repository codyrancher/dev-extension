# dev-extension

An extension that provides development environment and a collection of tools to simplify and automate the daily developer tasks.

## Infrastructure apart from tools

A workspace talks to whichever Rancher it is told to - the `rancherUrl` value on the
`rancher-dev` app, or the Rancher URL field when creating one - so the Rancher a team
shares is never what a workspace runs; the workspace runs its own checkout, dev server and
tools against it. Alongside it, two more apps a fresh Rancher gets:

- `dashboard-preview` - a static build at a branch, tag or `pull/<n>/head`, served by nginx on
  a NodePort. Two kinds, chosen by its `kind` value: the dashboard itself, under `/dashboard/`
  with `/v1`, `/v3`, `/k8s` and the rest proxied to the Rancher it was built for; or the
  dashboard's Storybook, a plain static site. A workspace's **Share** tab makes either and
  shows the link; a reviewer opens it and, for the dashboard, logs in to that Rancher.
  Rebuilding is restarting the pod.
- `dev-browser` - a Chromium with its DevTools protocol open, shared by whatever points at it.

## Terminals are Extension Studio's

Every pane in this extension that opens onto an agent - a workspace's conversations, the review
agent docked over a pull request, a discussion under one review comment, the Agents page - is
Extension Studio's terminal, pointed at one conversation in the Studio's agent pod. The Studio
hands the component and the agent's conversation API over on `window.__extensionStudio`
(its `public-api.ts`, 0.5.92 and later); `components/StudioTerminal.vue` is the whole of what
this extension adds. One pod, one exec path, one cookie - and one place a terminal is fixed.

The workspace's own shell goes the same way: the agent pod `kubectl exec`s into the workspace's
container, so it too is a Studio pane. A workspace on another cluster is out of the agent's
reach and its shell opens directly.

## The pull request tab

A port of the harness's review panel: the whole diff with GitHub's comments and the local
pending ones inline, a file tree that is also the index of every comment, a commit picker, the
review agent's progress, a discussion under any comment, and submission of the approved
comments to GitHub as one review. Comments and the review's state live in the in-cluster API
(`dev-api`, ConfigMaps in `dev-system`); evidence an agent attaches is read off the Studio
agent's workspace, which the API mounts read-only.
