// Resolving which manifest path a form input edits, by asking the form instead of guessing.
//
// The old approach read the label beside an input and tried to translate words into a path; it
// resolved nothing. This one observes the actual data binding: write a sentinel value into the
// input, dispatch the events Vue listens for, and deep-diff the bound model against a snapshot.
// The path that changed IS the input's path. Then put the original value back.
//
// Pure DOM + data functions - no Vue instance, no store - so the whole judgement of "did the
// probe resolve this input" is testable and readable on its own.

/** `apps/v1` + `Deployment` -> `apps.deployment`, the way Steve names types. */
export function steveTypeFor(apiVersion: string, kind: string): string | null {
  if (!apiVersion || !kind) {
    return null;
  }

  const group = apiVersion.includes('/') ? apiVersion.split('/')[0] : '';

  return group ? `${ group }.${ kind.toLowerCase() }` : kind.toLowerCase();
}

/**
 * A plain deep copy of the manifest-shaped part of a model.
 *
 * Steve models carry bookkeeping (`__rehydrate`, `$`-prefixed context, functions); none of it
 * is manifest, and diffing it would report changes nobody made. JSON round-tripping drops the
 * functions, and the filter drops the bookkeeping keys at every level.
 */
export function plainManifest(model: any): any {
  return strip(JSON.parse(JSON.stringify(model, (key, value) => {
    return key.startsWith('__') || key.startsWith('$') ? undefined : value;
  })));
}

function strip(node: any): any {
  if (Array.isArray(node)) {
    return node.map(strip);
  }

  if (node && typeof node === 'object') {
    const out: Record<string, any> = {};

    Object.keys(node).forEach((key) => {
      if (!key.startsWith('__') && !key.startsWith('$') && key !== '_type') {
        out[key] = strip(node[key]);
      }
    });

    return out;
  }

  return node;
}

/**
 * The resource model an input on one of Rancher's own edit pages is bound to.
 *
 * The edit form binds a clone, not the store's copy, so the store cannot answer this; the
 * component tree can. Vue leaves `__vueParentComponent` on the DOM nodes it renders (in the
 * development builds this dev server serves), and walking parent-ward from the input, the first
 * component whose `value` prop is an object with `metadata` and a `kind` or `type` is the
 * resource the form is editing - deeper components pass fragments (a container, an env row),
 * none of which carry `metadata`.
 */
export function modelFor(el: Element): any {
  let component = (el as any).__vueParentComponent;

  while (component) {
    const value = component.props?.value;

    if (value && typeof value === 'object' && value.metadata && (value.kind || value.type)) {
      return value;
    }

    component = component.parent;
  }

  return null;
}

export interface Change {
  path: string;
  from: unknown;
  to: unknown;
}

/** Every leaf that differs between two plain objects, with the path that reaches it. */
export function diffPaths(before: any, after: any, prefix = ''): Change[] {
  if (before === after) {
    return [];
  }

  const bothObjects = before && after && typeof before === 'object' && typeof after === 'object' &&
    Array.isArray(before) === Array.isArray(after);

  if (!bothObjects) {
    // Scalars, or a scalar on one side: one leaf changed. NaN !== NaN, but two NaNs are not a
    // change anybody made.
    if (typeof before === 'number' && typeof after === 'number' && isNaN(before) && isNaN(after)) {
      return [];
    }

    return String(before) === String(after) && typeof before === typeof after
      ? []
      : [{ path: prefix, from: before, to: after }];
  }

  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const out: Change[] = [];

  keys.forEach((key) => {
    out.push(...diffPaths(before[key], after[key], prefix ? `${ prefix }.${ key }` : key));
  });

  return out;
}

/** Read the scalar at a dotted path. Duplicated from fields.ts to keep this module pure DOM+data. */
function at(node: any, path: string): any {
  return path.split('.').reduce((n, key) => (n === undefined || n === null ? n : n[key]), node);
}

export interface ProbeResult {
  /** The manifest path this input edits, when the probe resolved exactly one. */
  path: string | null;
  /** Why there is no path, when there is none. */
  reason?: 'no-change' | 'ambiguous' | 'dirty-revert';
  /** The input's displayed value before the probe. */
  original: string;
}

/**
 * Which path one input edits.
 *
 * `read()` must return the current model as a plain object (see plainManifest); `restore(path,
 * value)` must write a value back into the model, for the one case where replaying the original
 * value through the input does not reproduce the original model (e.g. a number input whose
 * original model value was not a number).
 *
 * The waits matter: a plain LabeledInput updates the model inside dispatchEvent, but the row
 * components (ports, env, key-value) copy edits into the model from a watcher, which runs a
 * tick later. Waiting one macrotask after each write catches both. A component that debounces
 * longer than that reads as unresolved, which is the safe answer for it anyway.
 */
export async function probeInput(
  el: HTMLInputElement | HTMLTextAreaElement,
  read: () => any,
  restore: (path: string, value: unknown) => void,
): Promise<ProbeResult> {
  const original = el.value;
  const numeric = (el as HTMLInputElement).type === 'number';
  // A value no real manifest holds. The numeric one stays within what a number input accepts.
  const sentinel = numeric ? '196883' : 'zzAppsPlusProbe7731';

  const before = read();

  setAndNotify(el, sentinel);
  await settle();

  const changed = diffPaths(before, read())
    .filter((change) => String(change.to ?? '').includes(sentinel));

  // Put it back through the same channel, so the form's own state (not just the model) reverts.
  setAndNotify(el, original);
  await settle();

  // Belt and braces: if replaying the original did not restore the model exactly, write the
  // snapshot back directly. The model must leave this function untouched no matter what.
  const residue = diffPaths(read(), before);

  residue.forEach((change) => restore(change.path, at(before, change.path)));

  const clean = residue.length === 0 || diffPaths(read(), before).length === 0;

  if (!clean) {
    return { path: null, reason: 'dirty-revert', original };
  }

  if (changed.length === 1) {
    return { path: changed[0].path, original };
  }

  return { path: null, reason: changed.length === 0 ? 'no-change' : 'ambiguous', original };
}

function setAndNotify(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

/** One macrotask: long enough for watchers and zero-delay debounces, short enough to not show. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 15));
}

/**
 * The inputs worth probing inside a container element.
 *
 * Text and number boxes only. Selects are skipped whole - LabeledSelect's search box edits its
 * filter, not the model - and so are checkboxes/radios (setting `.value` on those does not mean
 * what it means on a text box), disabled inputs, and anything this extension renders itself.
 */
export function probeCandidates(host: HTMLElement): (HTMLInputElement | HTMLTextAreaElement)[] {
  const all = Array.from(host.querySelectorAll('input, textarea')) as (HTMLInputElement | HTMLTextAreaElement)[];

  return all.filter((el) => {
    const input = el as HTMLInputElement;

    if (input.disabled || input.readOnly) {
      return false;
    }

    // The builder drawer and anything else this extension renders is not part of the form.
    if (el.closest('.builder, .ap-page-marks')) {
      return false;
    }

    // vue-select's filter box, and anything else living inside a select.
    if (el.closest('.labeled-select, .v-select, .vs__dropdown-toggle')) {
      return false;
    }

    const type = (input.type || 'text').toLowerCase();

    return ['text', 'number', 'search', 'url', 'email', 'textarea'].includes(type) || el.tagName === 'TEXTAREA';
  });
}
