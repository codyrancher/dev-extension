# dev-extension

An extension that provides development environment and a collection of tools to simplify and automate the daily developer tasks.

## Infrastructure apart from tools

A workspace talks to whichever Rancher it is told to - the `rancherUrl` value on the
`rancher-workspace` app, or the Rancher URL field when creating one - so the Rancher a team
shares is never what a workspace runs; the workspace runs its own checkout, dev server and
tools against it. Alongside it, two more apps a fresh Rancher gets:

- `dashboard-preview` - the dashboard built once at a branch, tag or `pull/<n>/head` and
  served by nginx on a NodePort, with `/v1`, `/v3`, `/k8s` and the rest proxied to the
  Rancher it was built for. **Deploy static preview** on a workspace's PR tab makes one and
  shows the link; a reviewer opens it and logs in to that Rancher. Rebuilding is restarting
  the pod.
- `dev-browser` - a Chromium with its DevTools protocol open, shared by whatever points at it.
