/**
 * The cards that are not in this bundle: where they are kept, and how a change to one arrives.
 *
 * A card held here is a module, one ConfigMap each, labelled `dev.rancher.io/kind=focus-card` in
 * `dev-system`. One map per card rather than one map holding all of them, which buys four things
 * a shared map cannot: a `resourceVersion` per card, so a change says *which* card to reload
 * rather than "something moved"; no shared 1MiB ceiling to run into as a confusing write failure;
 * a malformed card that cannot corrupt the map its siblings live in; and - because the watch is
 * scoped by a label rather than to a name - a card that did not exist when the page loaded
 * appearing on its own.
 *
 * ## How a change arrives
 *
 * A k8s watch, read as a stream in the browser. Three other routes were tried first and each one
 * is worth writing down, because the obvious one does not work:
 *
 *   - **The Steve store, which is what you would reach for.** `cluster/find` for a `configmap`
 *     throws `Unknown schema for type: configmap`. This view runs under `c/_`, which has no
 *     current cluster, so the cluster store has no ConfigMap schema and therefore no subscription
 *     to hang reactivity on. (`useStore()` itself is fine here - unlike `useRouter()`, which is
 *     silently dead in the installed plugin. `management/findAll` is how the Ranchers dock on
 *     this very page gets its list.)
 *   - **Steve's own list endpoint**, `/v1/configmaps?labelSelector=...`. It answers, and it
 *     **ignores the selector**: 163 ConfigMaps came back, every `kube-root-ca.crt` in the
 *     cluster. A selector needs the raw k8s path, not the `/v1/` one.
 *   - **Polling the raw list.** It works and it is cheap - 10ms and 1131 bytes, measured - and it
 *     is the fallback if the stream will not stay up. But it is not live, and live is the point.
 *
 * So: `/k8s/clusters/<cluster>/api/v1/namespaces/dev-system/configmaps?labelSelector=...&watch=1`
 * through the dashboard's own proxy, same-origin, read with `getReader()`. Measured: `ok: 200`
 * and a first frame of `{"type":"ADDED","object":{"kind":"ConfigMap",...`. List first for the
 * `resourceVersion`, then watch from it - the standard list-then-watch, because a watch opened
 * without one replays history and a watch left on a stale one is refused with a 410.
 */
import { ref } from 'vue';
import { evalModule } from './components/focus/card-runtime';

/** Where a card lives, and what marks it as one. */
export const CARD_NS = 'dev-system';
export const CARD_LABEL = 'dev.rancher.io/kind=focus-card';

/** `dev-card-review-pass` holds the card `review-pass`. */
const NAME_PREFIX = 'dev-card-';

/** The one key in the map that is the module. Anything else is the card's own business. */
const SOURCE_KEY = 'card.js';

const idOf = (name: string) => (name.startsWith(NAME_PREFIX) ? name.slice(NAME_PREFIX.length) : name);

export interface LoadedCard {
  id: string;
  /** What the module exported, or null when it would not load. */
  module: any;
  /** Why it would not load, for the card to say so rather than draw nothing. */
  error: string;
  /** The ConfigMap's version, so a change is a change and a re-list is not. */
  rev: string;
  /**
   * Bumped every time this card's source changes.
   *
   * The remount key. Re-evaluating a module gives a new component, but Vue keeps the mounted one
   * unless something it keys on changes - so this is what `:key` reads, and it is a counter
   * rather than the `rev` because a counter is monotonic and a resourceVersion is a string whose
   * ordering is not ours to rely on.
   */
  generation: number;
}

/** Every card currently held outside the bundle, by id. Reactive; the view reads it directly. */
export const loadedCards = ref<Record<string, LoadedCard>>({});

/** Set while the first list is in flight, so the deck can wait rather than flash the built-ins. */
export const cardsSettled = ref(false);

/** What the watch is doing, for the editor to show and for a probe to assert on. */
export const cardsWatch = ref<{ state: 'off' | 'listing' | 'watching' | 'retrying'; since: string; events: number; error: string }>({
  state: 'off', since: '', events: 0, error: '',
});

function evaluate(id: string, source: string, rev: string, was?: LoadedCard): LoadedCard {
  const generation = (was?.generation ?? 0) + 1;

  try {
    const module = evalModule(source, {});

    if (!module || typeof module !== 'object') {
      return {
        id, module: null, error: 'The module exported nothing. A card should `module.exports = { ... }`.', rev, generation,
      };
    }

    return {
      id, module, error: '', rev, generation,
    };
  } catch (e) {
    /*
     * A card that will not load keeps its place and says why.
     *
     * The alternative is a card that silently is not there, which while editing one is the worst
     * of the two: you change a line, the card vanishes, and nothing tells you whether the save
     * failed, the watch dropped or the module threw.
     */
    return {
      id, module: null, error: String((e as Error)?.message || e).slice(0, 400), rev, generation,
    };
  }
}

/** Take one ConfigMap and keep what it holds, if it changed. */
function absorb(map: any) {
  const name = map?.metadata?.name;
  const rev = map?.metadata?.resourceVersion || '';
  const source = map?.data?.[SOURCE_KEY];

  if (!name || typeof source !== 'string') {
    return;
  }
  const id = idOf(name);
  const was = loadedCards.value[id];

  if (was && was.rev === rev) {
    return;
  }
  loadedCards.value = { ...loadedCards.value, [id]: evaluate(id, source, rev, was) };
}

function forget(map: any) {
  const id = idOf(map?.metadata?.name || '');
  const { [id]: gone, ...rest } = loadedCards.value;

  if (gone) {
    loadedCards.value = rest;
  }
}

type Requester = (url: string) => Promise<any>;

const listUrl = (cluster: string) => `/k8s/clusters/${ cluster }/api/v1/namespaces/${ CARD_NS }/configmaps?labelSelector=${ encodeURIComponent(CARD_LABEL) }`;

/**
 * Follow the cards until told to stop.
 *
 * Returns the stopper. One loop: list, absorb, watch from that version, and when the stream ends -
 * which it will, a watch is not forever and a proxy has its own ideas about idle connections -
 * list again. The backoff is on *failure* only; a clean end reconnects at once, because that is
 * the normal case and a delay there is a delay in a card appearing.
 */
export function followCards(request: Requester, cluster = 'local'): () => void {
  let stopped = false;
  let abort: AbortController | null = null;

  const tick = async() => {
    let wait = 1000;

    while (!stopped) {
      try {
        cardsWatch.value = { ...cardsWatch.value, state: 'listing', error: '' };

        const list = await request(listUrl(cluster));
        const seen = new Set<string>();

        for (const map of list?.items || []) {
          absorb(map);
          seen.add(idOf(map?.metadata?.name || ''));
        }
        // Anything we were holding that the list no longer has was deleted while we were away.
        for (const id of Object.keys(loadedCards.value)) {
          if (!seen.has(id)) {
            forget({ metadata: { name: `${ NAME_PREFIX }${ id }` } });
          }
        }
        cardsSettled.value = true;
        wait = 1000;

        const from = list?.metadata?.resourceVersion || '';

        abort = new AbortController();
        cardsWatch.value = {
          ...cardsWatch.value, state: 'watching', since: from, error: '',
        };

        const res = await fetch(`${ listUrl(cluster) }&watch=1&resourceVersion=${ encodeURIComponent(from) }`, {
          signal: abort.signal, headers: { accept: 'application/json' },
        });

        if (!res.ok || !res.body) {
          throw new Error(`the watch answered ${ res.status }`);
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        // A watch is newline-delimited JSON, and a frame can arrive in pieces.
        for (;;) {
          const { done, value } = await reader.read();

          if (done || stopped) {
            break;
          }
          buffer += decoder.decode(value, { stream: true });

          const lines = buffer.split('\n');

          buffer = lines.pop() || '';
          for (const line of lines) {
            if (!line.trim()) {
              continue;
            }
            let event: any;

            try {
              event = JSON.parse(line);
            } catch {
              continue;
            }
            cardsWatch.value = { ...cardsWatch.value, events: cardsWatch.value.events + 1 };

            if (event.type === 'DELETED') {
              forget(event.object);
            } else if (event.type === 'ADDED' || event.type === 'MODIFIED') {
              absorb(event.object);
            } else if (event.type === 'ERROR') {
              // Usually a 410: the version we asked from has aged out. List again.
              throw new Error(event.object?.message || 'the watch expired');
            }
          }
        }
      } catch (e) {
        if (stopped) {
          return;
        }
        cardsWatch.value = {
          ...cardsWatch.value, state: 'retrying', error: String((e as Error)?.message || e).slice(0, 200),
        };
        await new Promise((resolve) => setTimeout(resolve, wait));
        wait = Math.min(wait * 2, 30000);
      }
    }
  };

  tick();

  return () => {
    stopped = true;
    abort?.abort();
    cardsWatch.value = { ...cardsWatch.value, state: 'off' };
  };
}
