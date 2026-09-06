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

## Terminals are the agents extension's

Every pane in this extension that opens onto an agent - a workspace's conversations, the review
agent docked over a pull request, a discussion under one review comment, the Agents page - is
the agents extension's terminal (codyrancher/agents), pointed at one conversation in the agent
pod it keeps. That extension hands the component and the pod's conversations over on
`window.__agents`; `components/StudioTerminal.vue` is the whole of what this extension adds.
One pod, one exec path, one cookie - and one place a terminal is fixed.

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

## The Review tab

What the agent has changed before it is anybody's pull request: the branch's diff, committed
or not, read out of the checkout the agents work in (`/workspace/repos/<repo>` in the agent
pod - one clone, so the tab shows that clone's current branch) and drawn the way the PR tab
draws one. Comments are not kept anywhere: click a line, say what should change or ask what
it is for, and **Send to the agent** puts them into a conversation of the workspace as one
prompt. The agent's reply is the pane docked above the diff.

## Share links

A build is reached through this Rancher's own service proxy, so the link is on this Rancher's
address, a reviewer signs in the way they always do (GitHub included), and the dashboard's API
calls simply land here. The apiserver rewrites absolute URLs in proxied HTML, so the build's
index loads its scripts from an inline script instead. A Storybook build also gets a direct
address on sslip.io (`172-17-0-2.sslip.io:<port>`), which asks for nothing.
