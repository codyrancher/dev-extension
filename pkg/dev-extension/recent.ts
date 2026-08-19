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
