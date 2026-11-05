// Whether a workspace's checkout has commits of its own, read from git's files rather than by
// running git.
//
// The sidebar shows a fix as Assess until the agent has committed, then Code. That used to be
// learnt only by the workspace page, which runs `git log base..HEAD` in the workspace's own pod -
// so a row said Assess for as long as nobody opened it, which is exactly when it needed to say
// Code. This answers the same question for every workspace at once, from the disk dev-api
// already has mounted, and without the workspace's pod (a leased workspace runs nothing).
//
// Not by running git here. The comment on readBranchNow (workspace-rail.ts) says why: git run on
// a tree runs what the tree's config says, and this pod is not one to run a PR's config in. Two
// small text files are read instead: HEAD, for the branch, and that branch's reflog, which git
// writes a line to for every commit made in the checkout (core.logAllRefUpdates is on in every
// non-bare repository by default).

/** `ref: refs/heads/<branch>` -> the branch; a detached HEAD has none. */
export function branchOfHead(text) {
  return /^ref:\s*refs\/heads\/(.+?)\s*$/m.exec(String(text || ''))?.[1] || '';
}

/**
 * Whether a branch's reflog says commits were made on it, and are still on it.
 *
 * A line is `<old> <new> <who> <when>\t<message>`. A commit, an amend, a cherry-pick and a
 * rebase replaying a commit all mean work of this checkout's own. A reset back to a remote or a
 * default branch throws that work away, so it clears what came before; a reset to anything else
 * (HEAD~1, a sha) is a person reshaping their commits and leaves it standing. Merges and
 * fast-forwards are other people's commits arriving, and say nothing.
 */
export function reflogHasCommits(text) {
  let coded = false;

  for (const line of String(text || '').split('\n')) {
    const message = line.slice(line.indexOf('\t') + 1);

    if (line.indexOf('\t') < 0) {
      continue;
    }
    if (/^(commit( \((initial|amend)\))?|cherry-pick|rebase( -i)? \(pick\)):/.test(message)) {
      coded = true;
    } else if (/^reset: moving to (refs\/remotes\/|origin\/|upstream\/|master$|main$)/.test(message)) {
      coded = false;
    }
  }

  return coded;
}

/**
 * One workspace's answer: `{ branch, coded }`, with `coded` null when there is no checkout to
 * read (not cloned yet, or not a git checkout) - which is not the same as a checkout with no
 * commits, and the caller keeps whatever it knew.
 */
export function branchState(root, name, { fs, path }) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name || '')) {
    return { branch: '', coded: null };
  }
  const git = path.join(root, name, 'dashboard', '.git');

  try {
    const branch = branchOfHead(fs.readFileSync(path.join(git, 'HEAD'), 'utf8'));

    if (!branch || branch.includes('..')) {
      return { branch: '', coded: null };
    }
    let log = '';

    try {
      const file = path.join(git, 'logs', 'refs', 'heads', branch);
      const size = fs.statSync(file).size;

      // A reflog is a line per ref update; a megabyte is years of them. The tail is the part
      // that can have been reset, so a longer one is read from its end.
      if (size > 1048576) {
        const fd = fs.openSync(file, 'r');
        const buf = Buffer.alloc(1048576);

        fs.readSync(fd, buf, 0, buf.length, size - buf.length);
        fs.closeSync(fd);
        log = buf.toString('utf8');
      } else {
        log = fs.readFileSync(file, 'utf8');
      }
    } catch {
      // A branch with no reflog has had nothing done to it in this checkout.
      return { branch, coded: false };
    }

    return { branch, coded: reflogHasCommits(log) };
  } catch {
    return { branch: '', coded: null };
  }
}
