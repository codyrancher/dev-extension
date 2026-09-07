// Whether this browser will open a websocket to the page's own origin.
//
// Everything interactive in this product is a websocket: a terminal, a chat pane, the exec that
// lists a workspace's conversations, and Rancher's own subscribe. They all go to the origin the
// page was served from, and there is one common reason they all fail at once - the certificate
// that origin is served with is one the browser does not trust.
//
// A person can click through an interstitial to *see* a page, and its fetches then work, because
// the exception covers them. Chrome does not extend that exception to a websocket handshake: it
// refuses, with no interstitial and no reason on the console beyond "failed". So a shared
// preview link (dashboard-preview's ingress serves ingress-nginx's own fake certificate) loads,
// looks right, and then every terminal is dead and the console fills with the same line.
//
// This is one probe, once per page load, so the product can say that in a sentence instead.
const PROBE_TIMEOUT_MS = 6000;

export type SocketState = 'unknown' | 'ok' | 'blocked';

let probed: Promise<SocketState> | null = null;

/**
 * Open a websocket at the origin and see whether it gets as far as the server.
 *
 * `/v1/subscribe` is Rancher's own, and it answers any authenticated session. What is being
 * asked is not whether it works but whether the handshake is allowed to happen: a socket that
 * opens, or one that closes with a code the server chose, has been through the certificate. One
 * that errors without ever opening, immediately, has not.
 */
export function socketsWork(): Promise<SocketState> {
  if (probed) {
    return probed;
  }

  probed = new Promise<SocketState>((resolve) => {
    if (typeof WebSocket === 'undefined' || window.location.protocol !== 'https:') {
      resolve('unknown');

      return;
    }
    let socket: WebSocket;

    try {
      socket = new WebSocket(`wss://${ window.location.host }/v1/subscribe`);
    } catch {
      resolve('blocked');

      return;
    }
    const done = (state: SocketState) => {
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        // Already closed, which is one of the answers.
      }
      resolve(state);
    };
    const timer = setTimeout(() => done('unknown'), PROBE_TIMEOUT_MS);

    socket.onopen = () => done('ok');
    // A close *with* a code from the server is a socket that got there; 1006 is the browser's
    // own "it never connected", which is what a refused certificate looks like from here.
    socket.onclose = (event) => done(event.code && event.code !== 1006 ? 'ok' : 'blocked');
    socket.onerror = () => done('blocked');
  });

  return probed;
}

/** Where the same Rancher answers on a name the browser trusts, from its own setting. */
export async function rancherOwnAddress(store: unknown): Promise<string> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const setting: any = await (store as any).dispatch('management/find', { type: 'management.cattle.io.setting', id: 'server-url' });
    const url = String(setting?.value || setting?.default || '').replace(/\/$/, '');

    return url && !url.startsWith(window.location.origin) ? url : '';
  } catch {
    return '';
  }
}
