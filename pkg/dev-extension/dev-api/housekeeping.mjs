/**
 * The node's tidying up, done by a service with a clock instead of by every open page.
 *
 * Conversations joined them later, because a conversation lives in the agent pod and nothing about
 * a workspace going away reaches it unless somebody remembers to say so. What a page says on its
 * way out can fail, and other ways of deleting one never said it, so here they are noticed instead.
 *
 * Three jobs lived in the sidebar's refresh: remove the trees of workspaces that are gone, keep
 * three node_modules templates, and tag each workspace's artifacts with what they are about. Each
 * was a `pods/exec` socket, so each cost a socket per refresh, per tab, per person - about fifteen
 * a minute from one tab, to do work that has nothing to do at all nearly every time it runs.
 *
 * dev-api has the same hostPath the agent pod has and a loop that does not need a page open, so it
 * does the work here. Two of these jobs delete things, so what they may delete is decided by the
 * plain functions in the first half of this file, with no disk and no cluster in reach, and
 * tests/housekeeping.test.mjs holds each refusal. The second half does what they decided.
 *
 * This reaches only this node's disk. A workspace on another cluster is an sshfs mount inside the
 * agent pod, which this service cannot see, so an empty directory is all it finds there: tagging
 * those stays with the page (runHousekeepingFallback), and its tree is never a candidate because
 * the registrar lists it.
 *
 * What a tree holds is not trusted: it is whatever last ran in that workspace, and this is root
 * with its own service account. So a link in a tree is read as a link and never gone through.
 *
 * No imports, because `scripts/gen-dev-api.mjs` inlines this into server.mjs and a second
 * `import fs` would not parse there: `fs`, `path` and the rest come in as arguments. That is also
 * what lets the tests run the whole sweep against a real directory and a fake cluster.
 */

/** A tree this young may be a workspace whose Installation does not exist yet. */
export const TREE_AGE_FLOOR_MS = 60 * 60_000;

/** Newest first: enough for a slightly older branch to link, few enough to stay bounded. */
export const TEMPLATES_KEPT = 3;

/** The browser's REGISTRAR_STALE_MS. Older than this, the list says nothing about today's disk. */
export const REGISTRAR_TRUSTED_MS = 90_000;

/** A bound on a mistake nobody has thought of yet: the next sweep takes the next few. */
export const TREES_PER_SWEEP = 3;

/** The same bound for conversations, which cost only a claude if wrong and come back from a transcript. */
export const CONVERSATIONS_PER_SWEEP = 20;

/** About ten minutes, spread so that nothing lines up with anything else on a timer. */
export const SWEEP_EVERY_MS = 10 * 60_000;
const SWEEP_SPREAD = 0.2;

/** Long enough that a pod rolled by a publish does not start by deleting anything. */
export const SWEEP_FIRST_MS = 3 * 60_000;

/** A page asks a dev-api whether it does this at most this often, and falls back no more often. */
export const BROWSER_FALLBACK_EVERY_MS = 30 * 60_000;

/** More than a tag has ever been, and a thing to refuse rather than read into memory as root. */
const TAG_MAX_BYTES = 64 * 1024;

/** A workspace's name, or nothing. The same rule as safeName in api.ts. */
export function housekeepingName(name) {
  return typeof name === 'string' && /^[a-z0-9][a-z0-9-]{0,62}$/.test(name) ? name : '';
}

/**
 * The workspaces that must be kept, or null when that cannot be known.
 *
 * Null stops the sweep removing any tree. An empty list means "the workspaces did not load" at least
 * as often as it means "there are none", and the cost of guessing wrong is every tree on the node.
 * So does a registrar that has stopped being written, or a list of Installations that failed.
 *
 * @param {object|null} registrar The projection reconcileRegistrar writes: `{ at, workspaces }`.
 * @param {object|null} instances The Installations list, or null when it could not be read.
 * @param {number} now The clock.
 * @returns {Set<string>|null} The names to keep.
 */
export function workspacesToKeep(registrar, instances, now) {
  if (!instances || !Array.isArray(instances.items) || !registrar || !Array.isArray(registrar.workspaces)) {
    return null;
  }
  const at = Date.parse(registrar.at || '');

  if (!Number.isFinite(at) || Math.abs(now - at) > REGISTRAR_TRUSTED_MS) {
    return null;
  }
  const keep = new Set(registrar.workspaces.map((w) => housekeepingName(w?.name)).filter(Boolean));

  if (!keep.size) {
    return null;
  }
  for (const item of instances.items) {
    const named = [item?.metadata?.name, item?.metadata?.labels?.['dev.rancher.io/workspace']];

    named.map(housekeepingName).filter(Boolean).forEach((name) => keep.add(name));
  }

  return keep;
}

/**
 * The directories worth asking the cluster about.
 *
 * Real directories only, so a symlink is never followed out of the root; hidden ones are the
 * node's own (`.artifacts`, `.shared`, `.store`) and safeName refuses them; an unreadable age is
 * not an old one.
 *
 * The age is the younger of mtime and ctime. A directory moved into the root keeps the mtime it
 * came with, so that alone calls a seconds-old arrival over an hour old, and that is the one way a
 * tree can be missing from a registrar written seconds ago. A rename, a chown or a chmod all move
 * ctime, and nothing can set it back.
 *
 * @param {{name: string, isDirectory: boolean, isSymbolicLink: boolean, mtimeMs: number, ctimeMs: number}[]} entries
 * @param {Set<string>|null} keep From workspacesToKeep.
 * @param {number} now The clock.
 * @returns {string[]} The names.
 */
export function treeCandidates(entries, keep, now) {
  if (!keep || !keep.size) {
    return [];
  }

  return (entries || []).filter((e) => (
    !!housekeepingName(e.name) &&
    e.isDirectory === true &&
    e.isSymbolicLink !== true &&
    !keep.has(e.name) &&
    Number.isFinite(e.mtimeMs) &&
    Number.isFinite(e.ctimeMs) &&
    now - Math.max(e.mtimeMs, e.ctimeMs) > TREE_AGE_FLOOR_MS
  )).map((e) => e.name);
}

/**
 * What the cluster said, boiled down to the only three answers that exist.
 *
 * Only a 404 is "gone". A 403, a timeout or a 500 is not knowing, and the browser's version of this
 * read those as gone too: it caught every error to null, so an apiserver blip was a delete.
 *
 * @param {() => Promise<object>} read The GET.
 * @returns {Promise<'present'|'absent'|'unknown'>} The answer.
 */
export async function askCluster(read) {
  try {
    return (await read())?.metadata?.name ? 'present' : 'unknown';
  } catch (e) {
    return e?.status === 404 ? 'absent' : 'unknown';
  }
}

/**
 * Whether a tree goes. Asked of the cluster rather than inferred from a list that may be partial:
 * a namespace or an Installation still standing means the workspace is still there.
 *
 * @param {string} namespace askCluster on the workspace's namespace.
 * @param {string} installation askCluster on its Installation.
 * @returns {boolean} True only when both are known to be gone.
 */
export function treeMayGo(namespace, installation) {
  return namespace === 'absent' && installation === 'absent';
}

/**
 * The templates past the newest few. Directories only, hidden ones never (`ls -1dt *\/` could not
 * see them either), and nothing at all if one age is unreadable, since the order would be a guess.
 *
 * @param {{name: string, isDirectory: boolean, isSymbolicLink: boolean, mtimeMs: number}[]|null} entries
 * @param {number} kept How many to keep.
 * @returns {string[]} The names to remove.
 */
export function templatesToRemove(entries, kept = TEMPLATES_KEPT) {
  if (!entries || !Number.isInteger(kept) || kept < 1) {
    return [];
  }
  const templates = entries.filter((e) => (
    e.isDirectory === true &&
    e.isSymbolicLink !== true &&
    typeof e.name === 'string' &&
    e.name !== '' &&
    !e.name.startsWith('.') &&
    !e.name.includes('/')
  ));

  if (templates.some((e) => !Number.isFinite(e.mtimeMs))) {
    return [];
  }

  return templates
    .sort((a, b) => (b.mtimeMs - a.mtimeMs) || a.name.localeCompare(b.name))
    .slice(kept)
    .map((e) => e.name);
}

/**
 * The tag written beside a live workspace's artifacts, byte for byte what the browser wrote.
 *
 * The name is the whole of its input: numbersIn reads the issue and the pull request out of it, so
 * the server knows everything the page knew and nothing has to be posted.
 *
 * @param {string} name The workspace.
 * @param {{issue: number, pr: number}} numbers numbersIn(name).
 * @param {string} at When, as ISO text.
 * @returns {string} The file's content.
 */
export function artifactTag(name, numbers, at) {
  return JSON.stringify({
    workspace: name, issue: numbers.issue, pr: numbers.pr, taggedAt: at
  });
}

/**
 * The tag on a set kept as its tree goes: one that exists is only dated, since it may say what no
 * name could, and otherwise the capture in api.ts's words.
 *
 * @param {string|null} existing The set's tag as it stands.
 * @param {string} name The workspace.
 * @param {{issue: number, pr: number}} numbers numbersIn(name).
 * @param {string} at When, as ISO text.
 * @returns {string} The file's content.
 */
export function capturedTag(existing, name, numbers, at) {
  if (existing !== null && existing !== undefined) {
    return existing.replace(/}\s*$/, `,"capturedAt":"${ at }"}`);
  }

  return JSON.stringify({
    workspace: name, issue: numbers.issue, pr: numbers.pr, capturedAt: at
  });
}

/**
 * The conversations whose workspace is worth asking the cluster about, by workspace.
 *
 * A tree on the disk keeps its conversations: the registrar lists it, so a person can still open
 * them. The drawer's belong to no workspace and are never here. With no list to trust, nothing is.
 *
 * @param {string[]} ids What the pod holds.
 * @param {Set<string>|null} keep From workspacesToKeep.
 * @param {{name: string}[]} entries The root's directory listing.
 * @param {(id: string) => string} projectOf The workspace an id belongs to, or ''.
 * @returns {Map<string, string[]>} The ids of each workspace that looks gone.
 */
export function orphanedConversations(ids, keep, entries, projectOf) {
  const found = new Map();

  if (!keep || !keep.size) {
    return found;
  }
  const onDisk = new Set((entries || []).map((e) => e.name));

  for (const id of ids || []) {
    const name = housekeepingName(projectOf(id));

    if (name && !keep.has(name) && !onDisk.has(name)) {
      found.set(name, [...(found.get(name) || []), id]);
    }
  }

  return found;
}

/**
 * End the conversations nothing can reach any more, and drop the terminals nobody is holding.
 *
 * Ended by the same verb as a person's press, so the transcript stays and the record that would
 * start it again after a restart goes. Any failure here is the next sweep's: none of this is worth
 * stopping the template trim for.
 */
async function sweepConversations(deps, keep, entries, report) {
  const {
    listConversations, endConversation, reapClients, sweepImages, projectOf, readNamespace, readInstance
  } = deps;

  if (listConversations) {
    const ids = await listConversations().catch(() => null);

    for (const [name, held] of orphanedConversations(ids, keep, entries, projectOf)) {
      if (report.conversations.length >= CONVERSATIONS_PER_SWEEP) {
        break;
      }
      const [namespace, installation] = await Promise.all([
        askCluster(() => readNamespace(name)),
        askCluster(() => readInstance(name)),
      ]);

      if (!treeMayGo(namespace, installation)) {
        continue;
      }
      for (const id of held.slice(0, CONVERSATIONS_PER_SWEEP - report.conversations.length)) {
        if (await endConversation(id).catch(() => false)) {
          report.conversations.push(id);
        } else {
          report.errors.push(`end ${ id }`);
        }
      }
    }
  }
  if (reapClients) {
    report.clients = await reapClients().catch(() => null) || report.clients;
  }
  // After the conversations above are ended, so the screenshots of one ended this pass go in it.
  if (sweepImages) {
    report.images = await sweepImages().catch(() => null) || report.images;
  }
}

/**
 * Whether a page may leave this work to this service, going by what its last sweep managed.
 *
 * A sweep stopped at `installations` or `disk` did nothing at all, however often it runs. One stopped
 * at `registrar` still tagged and trimmed, and only left the trees, which no page removes either.
 *
 * @param {object|null} last The last sweep's report; null before the first.
 * @returns {boolean} False when a page should do its fallback.
 */
export function sweepsAreWorking(last) {
  return !['installations', 'disk'].includes(last?.skipped);
}

/** The gap before the next sweep: SWEEP_EVERY_MS, give or take a fifth. */
export function nextSweepDelay(random = Math.random) {
  return SWEEP_EVERY_MS * (1 - SWEEP_SPREAD + (2 * SWEEP_SPREAD * random()));
}

/** The gap before the first: at least SWEEP_FIRST_MS after the process starts. */
export function firstSweepDelay(random = Math.random) {
  return SWEEP_FIRST_MS * (1 + random());
}

/** A sweep that is called while one runs does nothing and says so with `false`. */
export function singleFlight(fn) {
  let running = false;

  return async(...args) => {
    if (running) {
      return false;
    }
    running = true;
    try {
      return await fn(...args);
    } finally {
      running = false;
    }
  };
}

/**
 * Whether this tab may ask about housekeeping yet.
 *
 * The clock and not the answer decides, so that nothing a dev-api says can bring this back to once
 * per refresh: a missing route, a failure and a yes all wait out the same half hour.
 *
 * @param {number} lastAsked When this tab last asked; 0 when it never has.
 * @param {number} now The clock.
 * @returns {boolean} True when it is time.
 */
export function browserFallbackDue(lastAsked, now) {
  return !(lastAsked > 0) || now - lastAsked >= BROWSER_FALLBACK_EVERY_MS || now < lastAsked;
}

/** A listing's directory entries with their ages, or null when it could not be read. */
async function listDirectory(fs, path, dir) {
  let names;

  try {
    names = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return null;
  }

  return Promise.all(names.map(async(entry) => {
    let mtimeMs = NaN;
    let ctimeMs = NaN;

    try {
      ({ mtimeMs, ctimeMs } = await fs.promises.lstat(path.join(dir, entry.name)));
    } catch { /* gone, or unreadable: an unknown age, which nothing acts on */ }

    return {
      name: entry.name, isDirectory: entry.isDirectory(), isSymbolicLink: entry.isSymbolicLink(), mtimeMs, ctimeMs
    };
  }));
}

/** Tag what has no tag. `wx` is what makes this write-once: an existing tag fails the open. */
async function tagArtifacts({ fs, path, root, numbersIn, now }, entries, report) {
  const at = new Date(now()).toISOString();

  for (const entry of entries) {
    const name = housekeepingName(entry.name);

    if (!name || !entry.isDirectory) {
      continue;
    }
    const dir = path.join(root, name, 'artifacts');

    try {
      if (!(await fs.promises.lstat(dir)).isDirectory()) {
        continue;
      }
      await fs.promises.writeFile(path.join(dir, '.set.json'), artifactTag(name, numbersIn(name), at), { flag: 'wx' });
      report.tagged += 1;
    } catch (e) {
      if (e.code !== 'ENOENT' && e.code !== 'EEXIST') {
        report.errors.push(`tag ${ name }: ${ e.code || e.message }`);
      }
    }
  }
}

/**
 * Where a tree's artifacts really are: a directory to copy, '' for nothing to keep, null to keep the
 * tree because that cannot be said.
 *
 * A symlink is followed only as far as the tree it is in, because that is what removing the tree
 * would destroy. A link out of the tree loses nothing, and is not copied: this is root, and the link
 * is the tree's to aim, at this service's own token for one. A link that resolves to nothing here may
 * still mean something in the pod that wrote it, whose mounts differ from this one's.
 */
async function artifactSource({ fs, path, root }, name) {
  const src = path.join(root, name, 'artifacts');
  let from = src;
  let seen;

  try {
    seen = await fs.promises.lstat(src);
  } catch (e) {
    return e.code === 'ENOENT' ? '' : null;
  }
  if (seen.isSymbolicLink()) {
    let tree;

    try {
      tree = await fs.promises.realpath(path.join(root, name));
      from = await fs.promises.realpath(src);
    } catch {
      return null;
    }
    if (from === tree) {
      return null; // The whole tree under another name, which is not a set of anything.
    }
    if (!from.startsWith(`${ tree }${ path.sep }`)) {
      return '';
    }
  }
  try {
    if (!(await fs.promises.lstat(from)).isDirectory() || !(await fs.promises.readdir(from)).length) {
      return '';
    }
  } catch {
    return null;
  }

  return from;
}

/** The tag that came across in a copy, if it is a file. A link or a fifo in its place is no tag. */
async function readCapturedTag(fs, tag) {
  const seen = await fs.promises.lstat(tag).catch(() => null);

  if (!seen?.isFile() || seen.size > TAG_MAX_BYTES) {
    return null;
  }

  return fs.promises.readFile(tag, { encoding: 'utf8', flag: fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW }).catch(() => null);
}

/**
 * Keep a tree's artifacts, the way keep-artifacts.sh does, and say whether that worked.
 *
 * False keeps the tree. A person's delete goes on regardless (see removeWorkspaceTree), but a person
 * asked for that one; nobody asked for this, and the tree can wait for the next sweep.
 *
 * `cp -a` brings the tree's links across as links, so from here on the copy is as untrusted as the
 * tree: the tag is read without following anything, and written to a name nothing else may hold.
 */
async function captureArtifacts(deps, name) {
  const {
    fs, path, root, numbersIn, run, now
  } = deps;
  const src = await artifactSource(deps, name);

  if (src === null) {
    return false;
  }
  if (src === '') {
    return true;
  }
  const store = path.join(root, '.artifacts');
  const dst = path.join(store, name);

  try {
    await fs.promises.mkdir(dst, { recursive: true });
    if (!(await fs.promises.lstat(store)).isDirectory() || !(await fs.promises.lstat(dst)).isDirectory()) {
      return false;
    }
  } catch {
    return false;
  }
  // Without hardlinks this really writes, and a link left in the store must be replaced, not written through.
  if (await run('cp', ['-alfu', `${ src }/.`, `${ dst }/`]) !== 0 && await run('cp', ['-afu', '--remove-destination', `${ src }/.`, `${ dst }/`]) !== 0) {
    return false;
  }
  const tag = path.join(dst, '.set.json');
  const next = `${ tag }.new`;
  const existing = await readCapturedTag(fs, tag);
  const at = new Date(now()).toISOString();

  // Beside it and renamed, as sed -i does: the tag may be the same inode as the tree's own copy, and
  // a rename replaces a link where a write would go through it. A directory at either name throws.
  await fs.promises.rm(next, { force: true });
  await fs.promises.writeFile(next, capturedTag(existing, name, numbersIn(name), at), { flag: 'wx' });
  await fs.promises.rename(next, tag);

  return true;
}

/** Remove one directory directly under `parent`. `--one-file-system` stops it at any mount inside. */
async function removeInside({ path, run }, parent, name) {
  const target = path.join(parent, name);

  if (name === '.' || name === '..' || path.dirname(target) !== path.normalize(parent)) {
    return false;
  }

  return await run('rm', ['-rf', '--one-file-system', '--', target]) === 0;
}

/**
 * One sweep.
 *
 * `listInstances` answering null ends it before anything is touched: that is a dev-api on a cluster
 * with no Apps Plus (a downstream one) or one that cannot read its own Installations. A registrar
 * that cannot be trusted stops trees going and nothing else: which templates to trim does not depend
 * on which workspaces exist, and losing one drops a set of hardlinks that can be made again.
 *
 * @param {object} deps
 * @param {object} deps.fs node:fs.
 * @param {object} deps.path node:path.
 * @param {string} deps.root The workspaces mount.
 * @param {(name: string) => {issue: number, pr: number}} deps.numbersIn From artifact-subjects.mjs.
 * @param {() => Promise<object|null>} deps.listInstances The Installations, or null.
 * @param {() => Promise<object|null>} deps.readRegistrar The projection, or null.
 * @param {(name: string) => Promise<object>} deps.readNamespace A workspace's namespace; throws with `.status`.
 * @param {(name: string) => Promise<object>} deps.readInstance Its Installation; throws with `.status`.
 * @param {(cmd: string, args: string[]) => Promise<number>} deps.run Runs a command, resolves its exit code.
 * @param {() => number} deps.now The clock.
 * @param {() => Promise<string[]|null>} [deps.listConversations] Every workspace conversation the agent pod holds, or null.
 * @param {(id: string) => Promise<boolean>} [deps.endConversation] End one, and say whether it worked.
 * @param {() => Promise<{stuck: number, idle: number}|null>} [deps.reapClients] Drop the dead tmux clients.
 * @param {() => Promise<{owned: number, loose: number}|null>} [deps.sweepImages] Drop the screenshots no conversation holds.
 * @param {(id: string) => string} [deps.projectOf] The workspace a conversation's id names.
 * @returns {Promise<object>} What it did.
 */
export async function sweepHousekeeping(deps) {
  const {
    fs, path, root, listInstances, readRegistrar, readNamespace, readInstance, now
  } = deps;
  const report = {
    at: new Date(now()).toISOString(), skipped: '', tagged: 0, trees: [], templates: [], kept: [], conversations: [], clients: { stuck: 0, idle: 0 }, images: { owned: 0, loose: 0 }, errors: []
  };
  const instances = await listInstances().catch(() => null);

  if (!instances) {
    report.skipped = 'installations';

    return report;
  }
  const entries = await listDirectory(fs, path, root);

  if (!entries) {
    report.skipped = 'disk';

    return report;
  }
  await tagArtifacts(deps, entries, report);

  const keep = workspacesToKeep(await readRegistrar().catch(() => null), instances, now());

  if (!keep) {
    report.skipped = 'registrar';
  }

  for (const name of treeCandidates(entries, keep, now())) {
    if (report.trees.length >= TREES_PER_SWEEP) {
      break;
    }
    const [namespace, installation] = await Promise.all([
      askCluster(() => readNamespace(name)),
      askCluster(() => readInstance(name)),
    ]);

    if (!treeMayGo(namespace, installation)) {
      report.kept.push(name);
      continue;
    }
    if (!(await captureArtifacts(deps, name).catch(() => false))) {
      report.kept.push(name);
      report.errors.push(`capture ${ name }`);
      continue;
    }
    if (await removeInside(deps, root, name)) {
      report.trees.push(name);
    } else {
      report.errors.push(`remove ${ name }`);
    }
  }

  await sweepConversations(deps, keep, entries, report);

  // `cd` that fails removes nothing, and neither does a directory that is not where it claims to
  // be: `.shared` or `template` being a symlink is not something to rm -rf through.
  const templates = path.join(root, '.shared', 'template');
  let real = '';

  try {
    real = await fs.promises.realpath(templates);
    if (real !== path.join(await fs.promises.realpath(root), '.shared', 'template')) {
      return report;
    }
  } catch {
    return report;
  }

  for (const name of templatesToRemove(await listDirectory(fs, path, templates))) {
    if (await removeInside(deps, templates, name)) {
      report.templates.push(name);
    } else {
      report.errors.push(`template ${ name }`);
    }
  }

  return report;
}
