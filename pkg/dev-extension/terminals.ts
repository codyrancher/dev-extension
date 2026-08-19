/**
 * The global terminals, as tabs in Rancher's window manager.
 *
 * The harness puts its terminals in a resizable drawer across the bottom of the page, with a
 * tab per terminal, a close on each and a plus at the end. Rancher already has that drawer:
 * the window manager is where container shells and logs open, it is resizable, it keeps its
 * tabs across navigation, and it takes tabs from extensions. So none of it is rebuilt here.
 * This file is only the bookkeeping: which numbers are taken, and what a tab is made of.
 *
 * One tab is one tmux session in the dev server's pod, with a working directory of its own, so
 * two tabs are two conversations rather than two views of one (see pod/shell.sh). Closing a tab
 * closes this end of the socket and leaves the session running, which is what makes reopening
 * the same number a reattach rather than a fresh start.
 */
import {
  DEV_POD_NAMESPACE, DEV_POD_LABELS, DEV_POD_CONTAINER, TERMINAL_SESSION_PREFIX
} from './config/constants';

/** Tab ids, so the tabs belonging to this product can be told from anyone else's. */
const TAB_PREFIX = 'dev-terminal-';

/**
 * The window manager's layouts, as strings.
 *
 * `Layout` in @shell/types/window-manager is a `const enum`, which this build erases rather
 * than emits, so importing it would compile and then be undefined at runtime. The values are
 * these three strings.
 *
 * All three, because the drawer should be usable from anywhere in the product. The window
 * manager hides the whole panel if any tab in it lacks the current layout, so a tab that only
 * claimed `default` would take Rancher's own container shells down with it on the home page.
 */
const LAYOUTS = ['default', 'home', 'plain'];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Store = any;

interface TerminalTab {
  id: string;
  label: string;
}

/** The tmux session, and so the conversation, that a numbered terminal attaches to. */
export function terminalSession(n: number): string {
  return `${ TERMINAL_SESSION_PREFIX }-${ n }`;
}

/** The numbers currently open in the drawer, in order. */
export function openTerminals(store: Store): number[] {
  return (store.getters['wm/tabs'] || [])
    .filter((tab: TerminalTab) => tab.id?.startsWith(TAB_PREFIX))
    .map((tab: TerminalTab) => Number(tab.id.slice(TAB_PREFIX.length)))
    .filter((n: number) => Number.isInteger(n))
    .sort((a: number, b: number) => a - b);
}

/**
 * The next number to hand out: the smallest that is not taken.
 *
 * Smallest rather than one past the largest, so closing Terminal 2 and adding one gives
 * Terminal 2 back, which is also the session it left running. Numbering upwards forever would
 * make every new terminal a new conversation and quietly strand the old ones.
 *
 * Shared with a workspace's conversation list, which numbers its panes the same way, so the
 * two cannot come to disagree about what the numbers mean.
 */
export function nextNumber(taken: number[]): number {
  let n = 1;

  while (taken.includes(n)) {
    n += 1;
  }

  return n;
}

export function nextTerminalNumber(store: Store): number {
  return nextNumber(openTerminals(store));
}

/**
 * What the sidebar's terminal icon does: show a terminal, or hide the one that is showing.
 *
 * A toggle, because the icon is the only thing in the product that opens the drawer and a
 * control that can only ever open something is one you have to close another way. With nothing
 * open it opens one, so a terminal is one click from anywhere; with one already in front of you
 * it puts the drawer away.
 *
 * Hiding is `setOpen`, not `close`. Closing a tab would end the session and throw away what is
 * on screen; this collapses the panel and leaves every tab where it was, so reopening shows the
 * same session with its scrollback, still attached to the same tmux in the pod. The window
 * manager keeps the components alive across it, which is what makes that true of the socket too.
 */
export function showTerminal(store: Store): number {
  const open = openTerminals(store);

  if (!open.length) {
    return openTerminal(store);
  }

  // The one the drawer was last showing, if it is one of ours, since that is the session the
  // person was in.
  const active = store.state.wm?.active?.bottom;
  const activeNumber = typeof active === 'string' && active.startsWith(TAB_PREFIX) ? Number(active.slice(TAB_PREFIX.length)) : NaN;
  const showing = open.includes(activeNumber);

  // Showing one of ours already: the icon is asking for it to go away.
  if (showing && store.state.wm?.open?.bottom) {
    store.commit('wm/setOpen', { position: 'bottom', open: false }, { root: true });

    return activeNumber;
  }

  return openTerminal(store, showing ? activeNumber : open[0]);
}

/**
 * Open a terminal in the drawer, or bring it to the front if it is already there.
 *
 * `wm/open` does both: its addTab keeps an existing tab as it is and makes it the active one,
 * so this is also how a link to a terminal focuses it.
 */
export function openTerminal(store: Store, n?: number): number {
  const number = n || nextTerminalNumber(store);
  const session = terminalSession(number);

  store.dispatch('wm/open', {
    id:    `${ TAB_PREFIX }${ number }`,
    label: `Terminal ${ number }`,
    icon:  'terminal',
    // Looked up through the extension registry rather than the shell's own window components,
    // which is what any truthy extensionId selects. See index.ts, where the name is registered.
    component:   'DevTerminalTab',
    extensionId: 'dev-extension',
    position:    'bottom',
    layouts:     LAYOUTS,
    // True, despite what the window manager's own docs suggest: the panel only draws its tab
    // bar when every tab in it wants a header, so a tab asking for no header takes away the
    // tab strip, the close buttons and the drag handle for everything else in the drawer too.
    showHeader:  true,
    attrs:       {
      session,
      number,
      namespace: DEV_POD_NAMESPACE,
      labels:    DEV_POD_LABELS,
      container: DEV_POD_CONTAINER,
    },
  }, { root: true });

  return number;
}
