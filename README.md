# dev-extension

The **Dev** product for Rancher: the Claude Harness rebuilt on Kubernetes. A workspace is a
namespace with a Deployment and a Service, on any cluster this Rancher manages, with terminals
on the pod's exec subresource, conversations that are tmux sessions, forwarded and
password-shared ports, GitHub work queues, and a SQLite database per person.

It used to live inside [codyrancher/barn](https://github.com/codyrancher/barn), vendored at
`pkg/barn/dev-extension`, because barn had to bake it into its own bundle as a seed - which was
once the only way a pod could be given a tree to serve. Barn imports from a repository now, so
this is a repository.

## Getting it

**Into barn's editor**: Publish → Import from GitHub, and give it `codyrancher/dev-extension`.
The pod clones this repo, and what is under `pkg/` becomes the tree its dev server serves and
you edit.

**Into a Rancher**: add this repository's GitHub Pages URL under Apps → Repositories and it
appears in Extensions, like any other chart-published extension.

## Building it

```bash
yarn install
yarn build-pkg dev-extension
```

Publishing is automatic. `.github/workflows/build-extension-charts.yml` builds and publishes to
the `gh-pages` branch when the version in `pkg/dev-extension/package.json` changes on `main`,
and also on a `dev-extension-<version>` release or by hand. It does not run on every push,
because what it publishes is a Helm repository and a chart version is meant to be immutable:
bumping the number is what means "publish".
