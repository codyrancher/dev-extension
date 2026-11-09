/**
 * The repository each workspace is for.
 *
 * Not every workspace is a `rancher/dashboard` one - `lte-pr-1202` is a pull request in
 * `harvester/harvester-ui-extension` - and every GitHub read about a workspace used the constant,
 * so that workspace asked for `rancher/dashboard` PR 1202, was told 404, and fell through to "not
 * named for an issue or a PR, so it has no stages".
 *
 * It was known only once somebody noted it: the sidebar's poll, or the workspace's own page. A
 * tab that read a workspace's status before either had - Focus, My Work's queue, a workspace page
 * opened from a link - asked rancher/dashboard about lte-pr-850 (rancher/security-ui-exts), was
 * told #850 there is merged, and stored the workspace as Merged. So a read that finds nothing
 * noted asks the workspace's own record (resolveRepo), and a reader that does not know the
 * repository says nothing rather than erasing one that is known.
 *
 * Pure and importless so `node --test` loads it directly, like review-stage.mjs.
 */
const repos = new Map();
/** Workspaces whose own record has been read and named no repository: the default is right. */
const checked = new Set();
/** Workspaces the last successful lookup did not list, and when to ask about them again. */
const absent = new Map();
const ABSENT_RETRY_MS = 60_000;
let reading = null;

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

/**
 * The repository a workspace is for, asking its own record when nothing has been noted.
 *
 * `lookup` answers for every workspace at once - a Map of name to repo, '' for a record with
 * none - or null when it could not be read. One lookup serves every caller waiting on it. What it
 * says is remembered: a repo is noted, a record with none is the default from then on. A failed
 * lookup decides nothing and the next read asks again. '' means "the default".
 */
export async function resolveRepo(name, lookup, now = Date.now()) {
  if (!name || repos.has(name) || checked.has(name) || (absent.get(name) || 0) > now) {
    return notedRepo(name);
  }
  const read = reading || (reading = Promise.resolve().then(lookup).catch(() => null).finally(() => {
    reading = null;
  }));
  const found = await read;

  if (!found) {
    return notedRepo(name);
  }
  for (const [each, repo] of found) {
    noteRepo(each, repo);
    checked.add(each);
    absent.delete(each);
  }
  if (!found.has(name)) {
    absent.set(name, now + ABSENT_RETRY_MS);
  }

  return notedRepo(name);
}

/**
 * Whether a stored stage was read from this repository.
 *
 * A record from another one is not this workspace's stage, whatever it says: it is what a read
 * of the wrong repository's pull request concluded. A record with no repo is from before records
 * said, when every read went to `fallback`, so a rancher/dashboard workspace keeps its stage.
 */
export function readFrom(record, repo, fallback) {
  return (record?.repo || fallback) === (repo || fallback);
}

/** For tests: forget everything noted. */
export function forgetRepos() {
  repos.clear();
  checked.clear();
  absent.clear();
  reading = null;
}
