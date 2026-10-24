/**
 * Where you were last, so that coming back lands there.
 *
 * Two things, and they are the same idea one level apart: which workspace you had open, and
 * which of its tabs. Pressing Dev in Rancher's rail takes you back to the workspace you were in
 * rather than to a list you then have to click through, and switching from one workspace to
 * another keeps the tab you were on, because somebody moving between two workspaces is usually
 * looking at the same thing in both.
 *
 * localStorage rather than the shell's preferences store, which is a Kubernetes resource per
 * user: this is where a browser tab was a moment ago, it is worth nothing to anybody else, and
 * writing it through the apiserver on every navigation would be a request per click for it.
 *
 * Every read is guarded. A browser with storage disabled is one where this does nothing and the
 * product opens on its list, which is exactly what it did before any of this existed.
 */
const WORKSPACE_KEY = 'dev-extension.last-workspace';
const TAB_KEY = 'dev-extension.last-tab';
/**
 * The discussions a person has open, by the comment they are under.
 *
 * A discussion is a conversation with an agent about one finding, and it was open only for as
 * long as the component drawing it stayed mounted: a refresh, or a navigation that remounted
 * the column, closed every one of them. The conversation itself survived - it is a real
 * conversation in the agent pod, and reopening the panel reattaches to it - but you had to
 * know that, find the finding again and press Discuss a second time to get back to something
 * you never finished.
 *
 * So which ones are open is kept here, beside the other "where you were" facts, and for the
 * same reason: it is this browser's business, it is worth nothing to anybody else, and writing
 * it through the apiserver would be a request per press. The conversation id is kept with it,
 * so reattaching needs no lookup.
 */
const DISCUSSIONS_KEY = 'dev-extension.open-discussions';

function read(key: string): string {
  try {
    return window.localStorage.getItem(key) || '';
  } catch {
    return '';
  }
}

function write(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch { /* a browser that will not store this is one that opens on the list */ }
}

/** The workspace last opened, which may since have been deleted. Callers check. */
export function lastWorkspace(): string {
  return read(WORKSPACE_KEY);
}

export function rememberWorkspace(name: string): void {
  write(WORKSPACE_KEY, name);
}

/**
 * The tab last looked at, across workspaces rather than per workspace.
 *
 * Per workspace was the other option and it is worse: the reason to keep a tab at all is that
 * somebody comparing two workspaces wants the same view of both, and a remembered-per-workspace
 * tab is exactly what defeats that.
 */
export function lastTab(): string {
  return read(TAB_KEY);
}

export function rememberTab(tab: string): void {
  write(TAB_KEY, tab);
}


/** One open discussion: which comment it is under and which conversation it is. */
export interface OpenDiscussion {
  session: string;
  at: string;
}

function readMap(): Record<string, OpenDiscussion> {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(DISCUSSIONS_KEY) || '{}');

    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * The discussions open under one pull request, by comment id.
 *
 * Keyed by PR as well as comment, because comment ids are only unique within one: two pull
 * requests open in two tabs must not reopen each other's discussions.
 */
export function openDiscussions(pr: number): Record<string, OpenDiscussion> {
  const prefix = `${ pr }:`;
  const out: Record<string, OpenDiscussion> = {};

  for (const [key, value] of Object.entries(readMap())) {
    if (key.startsWith(prefix) && value?.session !== undefined) {
      out[key.slice(prefix.length)] = value;
    }
  }

  return out;
}

/**
 * Remember that a discussion is open, or forget it.
 *
 * Forgetting is what the close control does, and it is the only thing that does: a refresh, a
 * remount and a navigation all leave the record alone, which is the whole point.
 */
export function rememberDiscussion(pr: number, comment: string | number, session: string): void {
  const map = readMap();

  map[`${ pr }:${ comment }`] = { session, at: new Date().toISOString() };
  write(DISCUSSIONS_KEY, JSON.stringify(map));
}

export function forgetDiscussion(pr: number, comment: string | number): void {
  const map = readMap();

  delete map[`${ pr }:${ comment }`];
  write(DISCUSSIONS_KEY, JSON.stringify(map));
}
