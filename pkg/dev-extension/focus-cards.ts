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
import { evalModule, DEFAULT_BODY } from './components/focus/card-runtime';
import { missingComponents } from './components/focus/card-modules';
import { CARD_SOURCES } from './cards.generated';

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
  /**
   * What the module exported, or the last version of it that worked.
   *
   * **Not null on failure, and that is the point.** A card carries `rules` now - the join to the
   * queue - so a module that will not evaluate stops claiming its work, and the items it would
   * have drawn fall through to the fallback card. Mid-edit that means a missing semicolon does not
   * break one card's body, it unroutes that whole kind of work out of the deck. So a card that
   * fails keeps the last module that worked: its rules go on claiming, its chip and title go on
   * drawing, and `error` is what the body shows. You see exactly what broke and nothing vanishes
   * from the queue while you are typing.
   */
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

/**
 * Every card, by id. Reactive; the view reads it directly.
 *
 * Seeded synchronously from the cards this extension ships - see `cards.generated.ts` - so the
 * deck has its cards on the first paint rather than after a round trip, and then overridden per
 * id by whatever the watch finds. Both arrive here as source and both go through `evaluate`,
 * which is the whole point: a bundled card and an edited card are the same kind of thing.
 */
export const loadedCards = ref<Record<string, LoadedCard>>(Object.fromEntries(
  Object.entries(CARD_SOURCES).map(([id, source]) => [id, evaluate(id, source, `bundled`)]),
));

/** Where a card's source came from, for the editor to say so before someone overwrites it. */
export const cardSource = (id: string) => (loadedCards.value[id]?.rev === 'bundled' ? 'bundled' : 'configmap');

/** Set while the first list is in flight, so the deck can wait rather than flash the built-ins. */
export const cardsSettled = ref(false);

/** What the watch is doing, for the editor to show and for a probe to assert on. */
export const cardsWatch = ref<{ state: 'off' | 'listing' | 'watching' | 'retrying'; since: string; events: number; error: string }>({
  state: 'off', since: '', events: 0, error: '',
});

function evaluate(id: string, source: string, rev: string, was?: LoadedCard): LoadedCard {
  const generation = (was?.generation ?? 0) + 1;
  /* The last thing that worked, which a failure falls back to rather than through. */
  const kept = was?.module ?? null;

  const failed = (why: string): LoadedCard => ({
    id, module: kept, error: why.slice(0, 400), rev, generation,
  });

  try {
    const module = evalModule(source);

    if (!module || typeof module !== 'object') {
      return failed('The module exported nothing. A card should `module.exports = { ... }`.');
    }
    if (!module.rules && !kept) {
      /*
       * Said once, here, rather than discovered as an empty deck. A card with no rules claims no
       * work, so it is not that the card looks wrong - it never reaches the top of the deck at
       * all, and the work it was for goes to the fallback card with no hint why.
       */
      return failed('This card claims nothing: a module needs `rules`, the rule ids whose work it draws.');
    }

    /*
     * A template naming a component this bundle has nothing for.
     *
     * The one authoring mistake that fails *silently*: Vue's runtime compiler treats an unknown
     * capitalised tag as a native element, so the card renders an empty `<thatname>` and nothing
     * anywhere says why. It cost all nineteen cards their bodies once, because `CardSurface` had
     * been written and never registered, and no probe caught it - the wrapper was present, the
     * card was the right height, and the body inside it was an empty unknown element.
     *
     * Reported as the card's error, so the card says it where its body would have been. The
     * module is kept, so its `rules` go on claiming the work rather than sending it to fallback.
     */
    const missing = missingComponents(String(module.template || DEFAULT_BODY));

    if (missing.length) {
      return {
        id,
        module,
        error: `This card's template uses <${ missing.join('>, <') }>, which this bundle has nothing for. A component is found by its file name - check the spelling, or require it in the module.`,
        rev,
        generation,
      };
    }

    styleFor(id, module.styles);

    return {
      id, module, error: '', rev, generation,
    };
  } catch (e) {
    return failed(String((e as Error)?.message || e));
  }
}

/**
 * A card's own CSS, scoped to that card.
 *
 * Written in the module beside the template it belongs to, because a card in one piece is a card
 * somebody can edit in one box. It is prefixed with the card's own class before it goes in: the
 * browser's parser does the prefixing (a stylesheet built here and walked rule by rule) rather
 * than a regular expression over the text, which gets `@media`, commas and pseudo-classes wrong
 * in that order. Without it a card that styles `.note` restyles every other card that has one.
 */
function styleFor(id: string, css: unknown) {
  const tag = `focus-card-${ id }`;
  let element = document.getElementById(tag) as HTMLStyleElement | null;

  if (typeof css !== 'string' || !css.trim()) {
    element?.remove();

    return;
  }
  if (!element) {
    element = document.createElement('style');
    element.id = tag;
    document.head.appendChild(element);
  }

  try {
    const sheet = new CSSStyleSheet();

    sheet.replaceSync(css);
    element.textContent = scoped([...sheet.cssRules], `.card--mod-${ id }`);
  } catch {
    /*
     * A stylesheet that will not parse is dropped rather than injected raw. The card still draws;
     * only its own styling is missing, which is visible, and the body is where an error belongs.
     */
    element.textContent = '';
  }
}

/** Every selector in these rules, prefixed - walking into `@media` and friends. */
function scoped(rules: CSSRule[], prefix: string): string {
  return rules.map((rule) => {
    const style = rule as CSSStyleRule;
    const group = rule as CSSGroupingRule;

    if (style.selectorText) {
      const selector = style.selectorText.split(',')
        .map((one) => `${ prefix } ${ one.trim() }`)
        .join(', ');

      return `${ selector } { ${ style.style.cssText } }`;
    }
    if (group.cssRules) {
      // `@media`, `@supports`, `@container`: keep the condition, scope what is inside it.
      const head = group.cssText.slice(0, group.cssText.indexOf('{'));

      return `${ head.trim() } { ${ scoped([...group.cssRules], prefix) } }`;
    }

    // `@keyframes`, `@font-face`: nothing to scope, and both are global by nature.
    return rule.cssText;
  }).join('\n');
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

/**
 * A card's ConfigMap has gone: fall back to the card this extension ships, if it ships one.
 *
 * Deleting the override is how a card is put back to its shipped version, so it has to restore
 * rather than remove - otherwise reverting an experiment would take the card out of the deck and
 * send its work to the fallback card.
 */
function forget(map: any) {
  const id = idOf(map?.metadata?.name || '');

  if (!loadedCards.value[id]) {
    return;
  }

  const shipped = CARD_SOURCES[id];

  if (shipped) {
    loadedCards.value = { ...loadedCards.value, [id]: evaluate(id, shipped, 'bundled', loadedCards.value[id]) };

    return;
  }
  const { [id]: gone, ...rest } = loadedCards.value;

  loadedCards.value = rest;
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
        /*
         * An override we were holding that the list no longer has was deleted while we were away.
         * Only an override: a bundled card is not in that list and never was, so comparing the
         * list against everything loaded would delete all nineteen on the first sweep.
         */
        for (const [id, card] of Object.entries(loadedCards.value)) {
          if (card.rev !== 'bundled' && !seen.has(id)) {
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
        /*
         * Settled, even though this failed. The deck asks this flag "have the overrides had
         * their chance yet?", not "did the list work?" - and the honest answer after a failed
         * attempt is yes. Set only on success, a cluster that cannot serve the list (no
         * permission, no proxy) left the flag false through every retry, and a deck gated on
         * it would spin for ever over the nineteen bundled cards it already had in hand.
         */
        cardsSettled.value = true;
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
