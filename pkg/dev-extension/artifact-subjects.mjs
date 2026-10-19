/**
 * What a set of artifacts is evidence about.
 *
 * An agent that reproduces an issue leaves a recording, a screenshot, a script and a note behind,
 * and those files are the answer to a question somebody asked: issue 19517, or pull request
 * 19152. The files lived in the workspace, so the page that showed them showed workspaces - which
 * meant the evidence for one issue was split across however many workspaces had worked on it, and
 * a workspace still running showed nothing at all, because only a deleted one left a kept set.
 *
 * So the unit is the subject, not the directory: every source of artifacts - a live workspace or
 * a set kept from a deleted one - says which issue or pull request it is about, and the sources
 * that agree about that are one thing on the page.
 *
 * Where the subject comes from, in order:
 *   1. the tag written beside the files (.set.json), which survives a rename and can say what no
 *      name could - a workspace called `scratch` working on issue 19517 is still about 19517;
 *   2. the workspace's name, for everything made before there were tags.
 *
 * Plain JavaScript and no imports, so `node --test` loads it directly - see
 * tests/artifact-subjects.test.mjs.
 */

/** The issue and PR a workspace name is about: `lte-issue-14904` is issue 14904. */
export function numbersIn(name) {
  return {
    issue: Number(/(?:^|-)issue-(\d+)(?:-|$)/.exec(name || '')?.[1]) || 0,
    pr:    Number(/(?:^|-)pr-(\d+)(?:-|$)/.exec(name || '')?.[1]) || 0,
  };
}

/**
 * One source's subject, tag first and name second.
 *
 * A tag of 0, or no tag at all, is not an answer - it is the absence of one - so the name is read
 * whenever the tag says nothing, rather than only when the file is missing. That matters for the
 * sets written before tags existed: they have a marker file with no numbers in it.
 */
export function subjectOf(source) {
  const tagged = { issue: Number(source?.issue) || 0, pr: Number(source?.pr) || 0 };

  if (tagged.issue || tagged.pr) {
    return tagged;
  }

  return numbersIn(source?.workspace);
}

/**
 * The key sources are gathered under.
 *
 * An issue outranks a pull request, because a PR raised for an issue is the same piece of work
 * and the issue is the thing it is about; a workspace that is about neither is its own subject,
 * so it is still on the page rather than in an "other" bucket that nobody opens.
 */
export function subjectKey(source) {
  const { issue, pr } = subjectOf(source);

  if (issue) {
    return `issue-${ issue }`;
  }

  return pr ? `pr-${ pr }` : `ws-${ source?.workspace || '' }`;
}

/** When a source last had anything written into it, as a number; 0 when it never said. */
function whenOf(source) {
  const at = source?.at || source?.capturedAt || source?.createdAt || '';
  const ms = typeof at === 'number' ? at : Date.parse(at);

  return Number.isFinite(ms) ? ms : 0;
}

/**
 * Sources gathered into subjects, newest first.
 *
 * Within a subject the live workspaces come before the kept sets: one is work in progress and
 * the other is a record of work that is over, and that is the order a person reads them in.
 * Across subjects it is the most recent thing that happened, wherever it happened - a kept set
 * that was captured this morning is above a workspace that has been quiet for a week.
 */
export function groupSubjects(sources) {
  const subjects = new Map();

  for (const source of sources || []) {
    if (!source?.workspace) {
      continue;
    }
    const key = subjectKey(source);
    const { issue, pr } = subjectOf(source);

    if (!subjects.has(key)) {
      subjects.set(key, {
        key,
        kind:   issue ? 'issue' : (pr ? 'pr' : 'workspace'),
        number: issue || pr || 0,
        issue,
        pr,
        sources: [],
        at:      0,
        files:   0,
      });
    }
    const subject = subjects.get(key);

    subject.sources.push(source);
    subject.at = Math.max(subject.at, whenOf(source));
    subject.files += Number(source.files) || (Array.isArray(source.paths) ? source.paths.length : 0);
  }

  for (const subject of subjects.values()) {
    subject.sources.sort((a, b) => (Number(!!b.live) - Number(!!a.live)) || (whenOf(b) - whenOf(a)));
  }

  return [...subjects.values()].sort((a, b) => (b.at - a.at) || a.key.localeCompare(b.key));
}
