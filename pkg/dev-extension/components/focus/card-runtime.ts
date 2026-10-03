/**
 * Loading a card that is not in this bundle.
 *
 * A card's definition says which artifacts it wants and what its buttons do, out of vocabularies
 * this bundle fixes - eleven surfaces, fifteen verbs. That is enough for a new *kind of work* and
 * not enough for a new *card*: a shape none of the eleven have needs a `.vue` file and a
 * republish, which is a 10-minute round trip through GHCR for a card nobody else will ever use.
 *
 * So a card can instead be a module held in the `dev-focus` ConfigMap and evaluated here. This is
 * the loader: it takes the module's source, runs it with the dependencies it is allowed to ask
 * for, and hands back what it exported. Nothing about the card's own shape is decided here - see
 * `card-api.ts` for what a loaded card is given and what it is expected to return.
 *
 * Three things make this possible, and each one was checked on the installed plugin rather than
 * assumed, because all three are the kind of thing that works on a dev server and not in Rancher:
 *
 *   1. No CSP forbids `new Function`. The dashboard sends no Content-Security-Policy header and
 *      has no `http-equiv` meta for one, so a module can be compiled from text at runtime.
 *   2. The template compiler is reachable. `@vue/compiler-dom` is a real dependency of this
 *      bundle, so a card can be written as a template string rather than as `h()` calls - which
 *      is the difference between a card somebody will edit in the UI and one they will not.
 *   3. Vue has to be *handed* to the card. A UMD bundle resolves its externals through `require`
 *      or through a global, and neither reaches the `vue` this bundle is using - the same reason
 *      `useRouter()` is silently dead in the installed plugin: a UMD-loaded extension gets its own
 *      copy of a library and the injection that composable needs crosses between them. A card
 *      gets every dependency passed in, and asks for nothing from the page.
 */
import * as vue from 'vue';
import { compile } from '@vue/compiler-dom';

/** What a card module is allowed to `require`. Anything else is an error, named. */
export type CardDeps = Record<string, unknown>;

/**
 * Run a module's source and return what it exported.
 *
 * CommonJS, AMD and the browser-global fallback all go through here, because a UMD wrapper picks
 * whichever of the three it finds and a card may have been written by any bundler. `module`,
 * `exports`, `define` and `require` are arguments rather than globals, so a card cannot reach the
 * page's own - and `self` is a plain object, so the `root.Thing = factory(root.Vue)` branch
 * assigns into something we own instead of onto `window`.
 */
export function evalModule(source: string, deps: CardDeps = {}): any {
  const module: { exports: any } = { exports: {} };
  const root: Record<string, any> = {};

  const require = (name: string) => {
    if (name in deps) {
      return deps[name];
    }
    throw new Error(`This card asked for "${ name }", which a card is not given. It gets: ${ Object.keys(deps).join(', ') }.`);
  };

  // AMD: `define([deps], factory)` or `define(factory)`.
  const define: any = (first: any, second?: any) => {
    const factory = typeof first === 'function' ? first : second;
    const names: string[] = Array.isArray(first) ? first : [];

    module.exports = typeof factory === 'function' ? factory(...names.map(require)) : factory;
  };

  define.amd = true;

  // eslint-disable-next-line no-new-func -- the point of the file; see the note at the top.
  const run = new Function('module', 'exports', 'require', 'define', 'self', 'window', 'globalThis', source);

  run(module, module.exports, require, define, root, root, root);

  // What the three wrappers leave behind, in the order a module is most likely to have used.
  const got = module.exports?.default ?? module.exports;

  if (got && (typeof got === 'object' || typeof got === 'function') && Object.keys(got).length) {
    return got;
  }

  // The global branch: whatever single thing it hung off `root`.
  const names = Object.keys(root);

  return names.length === 1 ? root[names[0]] : got;
}

/**
 * A template string, as a render function.
 *
 * `compile` returns the *source* of a render function, which still has to be run - and it is run
 * the same way a module is, with the runtime helpers passed in rather than imported, because the
 * code it generates expects them under `Vue` when compiled in function mode.
 */
export function compileTemplate(template: string, name = 'card'): any {
  /*
   * No `prefixIdentifiers`. It is what the compiler's *bundler* build wants, and what this bundle
   * actually resolves `@vue/compiler-dom` to is its browser build, which refuses the option by
   * name: `"prefixIdentifiers" option is not supported in this build of compiler.` Measured on the
   * page, not read off a docs page - and the second of the three facts that had to be checked
   * somewhere real. The browser build compiles to a `with (this)` body instead, which wants the
   * component instance as `this` and the runtime helpers as `Vue`.
   */
  const { code } = compile(template, { mode: 'function', hoistStatic: true, filename: `${ name }.html` });

  // eslint-disable-next-line no-new-func -- as above.
  return new Function('Vue', `${ code }\nreturn render;`)(vue);
}

/** The Vue a card is given, so it is the same one drawing the page around it. */
export const cardVue = vue;

/**
 * What the loader can prove about where it is running.
 *
 * Kept because all three facts are properties of the *host page* rather than of this code, and the
 * host page is Rancher - which has already had one go at making `vue-router`'s composables useless
 * here. A card that will not load should be able to say which of the three stopped working.
 */
export function runtimeFacts() {
  const facts: Record<string, unknown> = {};

  facts.csp = document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content') || null;

  try {
    facts.newFunction = evalModule('module.exports = { ok: 2 + 2 };').ok === 4;
  } catch (e) {
    facts.newFunction = `threw: ${ (e as Error).message }`;
  }

  try {
    const render = compileTemplate('<p class="probe">{{ word }}</p>');
    /*
     * Run it, because a render function that compiles and throws is no use to a card - and this
     * one did throw, `Cannot convert undefined or null to object`. The browser build's body is
     * `with (_ctx) { ... }` around a function of `(_ctx, _cache)`: the context is an **argument**,
     * not `this`, so calling it the way a method is called hands `with` an undefined scope. It is
     * the shape Vue itself calls a component's `render` with, which is how a card will be drawn.
     */
    const drawn = render({ word: 'drawn' }, []);

    facts.compiler = typeof render === 'function' && drawn?.children === 'drawn' ? true : `compiled, drew ${ JSON.stringify(drawn?.children) }`;
  } catch (e) {
    facts.compiler = `threw: ${ (e as Error).message }`;
  }

  facts.vue = (vue as any).version;
  facts.sameVue = (vue as any).version === (window as any).__VUE_VERSION__ || 'unknown';

  return facts;
}
