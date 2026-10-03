/**
 * What a card is allowed to import, which is everything.
 *
 * The first cut of this was a hand-written map of 24 components, and the line it drew was wherever
 * I had stopped typing: `FocusModal` was missing, so a card had no way to open a dialog, and so
 * were `IconButton`, `MiniCard` and every one of the chat components. A curated vocabulary is a
 * defensible design and it was not the one asked for - a card should reach anything the extension
 * has, the same as a file in the repo does.
 *
 * So the registry is the bundle itself. `require.context` makes webpack enumerate every module
 * under `pkg/dev-extension`, and a card's `require('./components/focus/FocusModal.vue')` resolves
 * through it.
 *
 * **Lazily.** The context is asked for a key only when a card names it. Eagerly walking
 * `ctx.keys()` and evaluating all of them would run every module's top-level side effects at page
 * load, in an order webpack picks rather than one the imports imply - which is how a circular
 * import becomes `undefined` at startup instead of at the point of use. Nothing here is evaluated
 * until a card asks for it, and a card that asks for nothing costs nothing.
 *
 * **The host's own modules are the exception, and it is a real one.** `@shell/...` and
 * `@components/...` belong to Rancher and are resolved by *its* build; only the ones this
 * extension already references are present in our bundle at all, so they cannot be enumerated -
 * they are listed by name below. Reaching a new one means adding it here first, which is a build
 * change rather than a card change. Worth knowing before writing a card that wants `@shell`.
 */

// Rancher's own, which cannot be enumerated: a `require.context` over `@shell` would ask webpack
// to bundle the host's entire component tree into this plugin. These are the ones the extension
// already pulls in, so they cost nothing extra.
// @ts-ignore - Rancher's own, shipped without declarations this build can see. Same reason as
// the `@ts-ignore` over marked in components/pr/diff.ts. The import shapes match how the rest of
// this extension already imports them: Banner is named, the three @shell ones are default.
import { Banner } from '@components/Banner';
// @ts-ignore
import AsyncButton from '@shell/components/AsyncButton';
// @ts-ignore
import Loading from '@shell/components/Loading';
// @ts-ignore
import BrandImage from '@shell/components/BrandImage';

/**
 * Everything this extension is made of, resolved on demand. See the note above.
 *
 * Two exclusions in the pattern, both found by the build refusing:
 *
 *   - `node_modules`. The context root is `pkg/dev-extension`, which has its own, so a bare
 *     `\.(vue|ts)$` asks webpack to bundle every TypeScript file in every dependency.
 *   - `.d.ts`. A declaration file matches `\.ts$` and has no output to generate: the build died
 *     with `error in ./js-yaml.d.ts - Debug Failure. Output generation failed`, which names the
 *     file but not the reason.
 */
const own = (require as any).context('../../', true, /^\.\/(?!node_modules\/)(?!.*\.d\.ts$).*\.(vue|ts)$/);

const HOST: Record<string, any> = {
  '@components/Banner':            Banner,
  '@shell/components/AsyncButton': AsyncButton,
  '@shell/components/Loading':     Loading,
  '@shell/components/BrandImage':  BrandImage,
};

/**
 * The spellings a card might reasonably use for one module.
 *
 * `require.context` keys are relative and carry their extension (`./components/focus/AppIcon.vue`),
 * and nobody writing a card will remember that. A card may write the path with or without a
 * leading `./`, with or without the extension, and a bare name for anything in the view's own two
 * component directories - `require('AppIcon')` finds `./components/focus/AppIcon.vue`.
 */
function spellings(name: string): string[] {
  const clean = String(name || '').replace(/^\.\//, '').replace(/^\//, '');
  const bare = clean.replace(/\.(vue|ts)$/, '');
  const out = [
    `./${ clean }`,
    `./${ bare }.ts`,
    `./${ bare }.vue`,
    // A bare name, in the places a card's parts actually live.
    `./components/focus/${ bare }.vue`,
    `./components/code/${ bare }.vue`,
    `./components/chat/${ bare }.vue`,
    `./components/${ bare }.vue`,
    `./${ bare }`,
  ];

  return [...new Set(out)];
}

/** What a module gets back from `require`, or an error naming what it asked for. */
export function resolveForCard(name: string): any {
  if (name === 'vue') {
    // Handed in rather than resolved: see the note in card-api.ts about two copies of Vue.
    throw new Error('A card does not require("vue"); it is given `api.vue`.');
  }
  if (HOST[name]) {
    return HOST[name];
  }

  const keys = spellings(name);

  for (const key of keys) {
    try {
      const got = own(key);

      if (got) {
        // An ES module's default export is what a `.vue` file means by itself.
        return got.__esModule && 'default' in got ? got.default : got;
      }
    } catch {
      // Not that spelling; try the next.
    }
  }

  throw new Error(`A card asked for "${ name }", which is not in this bundle. Tried: ${ keys.join(', ') }. Rancher's own modules must be registered by name in card-modules.ts.`);
}

/**
 * The components a template names, resolved - so nobody has to remember to register one.
 *
 * This exists because of a bug I shipped. `CardSurface.vue` was written after the component map
 * and never added to it, so every one of the nineteen cards' templates failed to resolve
 * `<CardSurface>`; Vue's runtime compiler falls back to a native element for an unknown tag, so
 * each card rendered `<cardsurface api="[object Object]"></cardsurface>` - an empty box with no
 * error anywhere. A hand-maintained map of components is a list somebody forgets to append to,
 * and the failure is silent, which is the worst pair of properties a registry can have.
 *
 * So the template says which components it wants and they are looked up. Lazily, by scanning for
 * capitalised tags: a card that names three components evaluates three modules, not the sixty in
 * the view.
 */
const TAG = /<([A-Z][A-Za-z0-9_]*)/g;

export function componentsIn(template: string): Record<string, any> {
  const found: Record<string, any> = {};

  for (const name of new Set(String(template || '').match(TAG)?.map((tag) => tag.slice(1)) || [])) {
    try {
      found[name] = resolveForCard(name);
    } catch {
      // Reported by `missingComponents`, which is what turns this into something the card says.
    }
  }

  return found;
}

/**
 * The capitalised tags a template names that this bundle has nothing for.
 *
 * Checked before a card is accepted, because an unresolved component is the one authoring mistake
 * that draws *nothing* and says *nothing* - Vue treats the tag as a native element and renders an
 * empty one. A card that names a component we cannot find should say so where its body would be.
 */
export function missingComponents(template: string): string[] {
  const missing: string[] = [];

  for (const name of new Set(String(template || '').match(TAG)?.map((tag) => tag.slice(1)) || [])) {
    try {
      resolveForCard(name);
    } catch {
      missing.push(name);
    }
  }

  return missing;
}
