// Apps Plus, now part of this extension rather than beside it.
//
// The Dev product is a UI over Apps and Installations: a workspace *is* an Installation of an
// App, a preview and a tool are Installations of other Apps, and the rendering of an App's
// templates into a Fleet Bundle is what makes any of them exist. That was a second extension
// somebody had to install first, and "somebody had to install it first" was the whole of the
// coupling - a Dev product on a Rancher without it drew every page and could do nothing.
//
// So the types, the models, the pages and the builder came in here, and this is the part that
// makes the move true: the CRDs are created if they are missing, and the Apps this product
// needs are created on top of them. Installing this extension is all it takes.
import { APPS_PLUS_CRDS } from './apps-plus-crds.generated';
import { devFetch, clusterBase } from './api';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

/** Where a CRD is created; the apiserver's own path, through Rancher's proxy to the local cluster. */
const CRDS = 'apis/apiextensions.k8s.io/v1/customresourcedefinitions';

/**
 * Make sure `appsplus.io`'s two types exist.
 *
 * Create-if-missing, and quiet: this runs for everyone who opens a Dev page, and most of them
 * are opening a Rancher where the types have been there for weeks. A CRD that is already there
 * is left exactly as it is - an extension that rewrote the cluster's types on every page load
 * would be a worse version of the problem this replaces.
 *
 * Whoever administers this Rancher can create a CRD; anyone else gets a refused create, which
 * is not worth a banner of its own - `appsPlusAvailable` already says what is missing, in the
 * one place it matters.
 *
 * Returns whether both types are now there, so a caller can tell "ready" from "asked for".
 */
export async function ensureAppsPlusCrds(): Promise<boolean> {
  const base = `${ clusterBase('local') }/${ CRDS }`;
  let all = true;

  for (const crd of APPS_PLUS_CRDS) {
    const name = crd?.metadata?.name;

    if (!name) {
      continue;
    }

    const existing = await devFetch(`${ base }/${ name }`, { timeoutMs: 8000 }).catch(() => null);

    if (existing?.metadata?.name === name) {
      continue;
    }

    const made = await devFetch(base, { method: 'POST', body: JSON.stringify(crd) }).catch((e: Json) => {
      // A 409 is two tabs doing this at once, which is fine and common.
      if (e?.status !== 409) {
        console.info(`[dev] the ${ name } type could not be created: ${ e?.message || e }`); // eslint-disable-line no-console
      }

      return null;
    });

    all = all && !!made;
  }

  return all;
}
