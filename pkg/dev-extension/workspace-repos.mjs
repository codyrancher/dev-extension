/**
 * The repository each workspace is for, as told by whoever has read it.
 *
 * Not every workspace is a `rancher/dashboard` one - `lte-pr-1202` is a pull request in
 * `harvester/harvester-ui-extension` - and every GitHub read about a workspace used the constant,
 * so that workspace asked for `rancher/dashboard` PR 1202, was told 404, and fell through to "not
 * named for an issue or a PR, so it has no stages". Two readers tell this: the sidebar's list,
 * on every poll, and the workspace's own page, which has the Installation before it reads
 * anything.
 *
 * A reader that does not know the repository says nothing. An empty value used to overwrite a
 * known one, and a page loaded straight onto `lte-pr-850` (rancher/security-ui-exts) read before
 * the sidebar had told it anything: it asked rancher/dashboard about #850, a merged pull request
 * there, and stored the workspace as Merged.
 *
 * Pure and importless so `node --test` loads it directly, like review-stage.mjs.
 */
const repos = new Map();

export function noteRepo(name, repo) {
  const known = String(repo || '').trim();

  if (name && known) {
    repos.set(name, known);
  }
}

/** The repository noted for a workspace, or '' when nobody has said. */
export function notedRepo(name) {
  return repos.get(name) || '';
}
