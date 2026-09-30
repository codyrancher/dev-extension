// What the app builder is holding, shared by the drawer and by the action on every resource.
//
// One reactive object, module-scoped, because the two halves of this feature are mounted in
// different Vue apps: the drawer is its own app on `document.body` (see overlay.ts), and the
// "Add to Application" action runs from the dashboard's. A Vuex module would have to be
// registered into a store this extension does not own; a plain `reactive` is shared by both
// simply because they import the same file.
//
// The staging is the design decision worth naming. An "add" does not write to the cluster: it
// puts a template in here, and the drawer writes all of them when somebody presses Save. That is
// what makes collecting an app out of pages worth doing - you walk around Rancher, add a
// Deployment here and a Service there, fix the two of them up, and commit once. Writing on every
// click would mean an App object that is half-built whenever somebody wanders off, and no moment
// at which the YAML could be edited before it existed.

import { reactive, watch } from 'vue';
import jsyaml from 'js-yaml';
import { importResource, dumpTemplate } from '../import-resource';

/** One staged file: what it will become in `spec.templates`, plus what it came from. */
export interface StagedTemplate {
  /** File name in the app. */
  name: string;
  /** The kind, kept for grouping the cards. */
  kind: string;
  /** Where it came from, so a card can say so. */
  source: string;
  /** What it was called in the cluster, which is what other templates still point at. */
  origin: string;
  content: string;
}

export interface BuilderState {
  open: boolean;
  /** The App being built. '' means nothing is selected yet. */
  app: string;
  templates: StagedTemplate[];
  /** Values the imports suggested, merged as they arrive. */
  values: Record<string, string>;
  /** What each value should be called on an install form, keyed the same way. */
  labels: Record<string, string>;
  /** How wide the drawer is, in pixels. */
  width: number;
  /**
   * The card the drawer should draw attention to, set when an add turned out to be a re-add.
   * A fresh object each time, so re-adding the same resource twice still registers as a
   * change. Never restored: a flash is an answer to a click, not part of the collection.
   */
  flash: { name: string; at: number } | null;
  /**
   * Selections an add had to drop because a card already answers for their name and kind.
   * Like flash, an answer to a click rather than part of the collection, so never restored.
   */
  notices: SkippedNotice[];
}

/** One dropped selection: what was skipped, and the already-staged resource that kept the name. */
export interface SkippedNotice {
  /** What was selected and not added, e.g. `kube-system/kube-root-ca.crt`. */
  skipped: string;
  /** The kind both of them are. */
  kind: string;
  /** Where the card that kept the name came from. */
  kept: string;
}

const KEY = 'apps-plus.builder';
const MIN_WIDTH = 320;
const DEFAULT_WIDTH = 460;

function empty(): BuilderState {
  return {
    open: false, app: '', templates: [], values: {}, labels: {}, width: DEFAULT_WIDTH, flash: null, notices: [],
  };
}

/**
 * What was stored, as far as it can be trusted.
 *
 * Every field is checked rather than spread, because this is a string a person can edit and a
 * shape that will change - a stored drawer from an older version of this extension should open
 * empty rather than throw on the first render.
 */
function restore(): BuilderState {
  const state = empty();

  try {
    const stored = JSON.parse(window.localStorage.getItem(KEY) || '{}');

    state.open = !!stored.open;
    state.app = typeof stored.app === 'string' ? stored.app : '';
    state.width = Number(stored.width) > MIN_WIDTH ? Number(stored.width) : DEFAULT_WIDTH;
    state.values = stored.values && typeof stored.values === 'object' ? stored.values : {};
    state.labels = stored.labels && typeof stored.labels === 'object' ? stored.labels : {};
    state.templates = Array.isArray(stored.templates) ?
      stored.templates.filter((t: any) => t && typeof t.name === 'string' && typeof t.content === 'string') :
      [];
  } catch {
    // A private window, cleared storage, or something that is not JSON. An empty drawer is the
    // right answer to all three.
  }

  return state;
}

export const builder: BuilderState = reactive(restore());

// Persisted on every change rather than at chosen moments, because the point of this drawer is
// that it survives walking around Rancher - and a navigation is not something this can hook.
watch(builder, (now) => {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(now));
  } catch {
    // Storage can refuse. The drawer still works for this page; it just will not come back.
  }
}, { deep: true });

/** The minimum the drawer may be dragged to, shared with the panel. */
export { MIN_WIDTH };

/**
 * Stage one live resource.
 *
 * Returns the name it was given, so the caller can say what happened. A file name that is
 * already taken gets a number: two templates with one name is a save that silently keeps one of
 * them, and adding two Services is an ordinary thing to do.
 */
export function stageResource(resource: any): string {
  // The same live resource, though, is not: the drawer persists across pages, so re-selecting
  // a row already added is an easy slip, and honouring it would mint x-deployment-2.yaml - two
  // templates rendering one metadata.name, which Fleet then fights over. Same origin and kind
  // means it is already here, so the re-add is a no-op that answers with the existing card.
  const already = builder.templates.find((template) => template.origin &&
    template.origin === resource?.metadata?.name &&
    template.kind === resource?.kind);

  if (already) {
    // Answered visibly, not just returned: from the resource list a swallowed re-add reads as
    // a button that did nothing. The drawer watches this and flashes the card it already has.
    builder.flash = { name: already.name, at: Date.now() };

    // A re-add of the same object is a slip, and the flash is answer enough. The same name
    // arriving from a *different* namespace is a real resource being dropped - "2 selected"
    // silently becoming one card - so the drawer has to say which one it kept.
    const source = String(resource?.id || resource?.metadata?.name || '');

    if (source && already.source && source !== already.source) {
      builder.notices = [
        ...builder.notices.filter((notice) => notice.skipped !== source),
        { skipped: source, kind: already.kind, kept: already.source },
      ];
    }

    return already.name;
  }

  // The values already claimed, so a second Deployment does not silently share `${image}`.
  const imported = importResource(resource, Object.keys(builder.values));
  const taken = new Set(builder.templates.map((template) => template.name));
  let name = imported.name;

  for (let i = 2; taken.has(name); i++) {
    name = imported.name.replace(/\.yaml$/, `-${ i }.yaml`);
  }

  builder.templates.push({
    name,
    kind:    resource?.kind || imported.name.replace(/\.yaml$/, ''),
    source:  resource?.id || resource?.metadata?.name || '',
    origin:  imported.originalName,
    content: imported.content,
  });

  // Under what is already there: a value somebody has typed outranks one an import guessed.
  builder.values = { ...imported.values, ...builder.values };
  builder.labels = { ...imported.labels, ...builder.labels };

  relinkStaged();

  return name;
}

/**
 * Keys whose value is the name of another object, and the kind that object can only be.
 *
 * The parent is what makes this safe. `name` on its own is far too common - a container is
 * called `nginx`, a volume is called `content` - so the rule is not "a key called name" but "a
 * name inside a reference", plus the handful of keys that are references on their own.
 *
 * The kind is what makes the rewrite safe. A reference is `<kind> + <name>`, not `<name>`: a
 * Deployment's `serviceAccountName: dev-api` names a ServiceAccount, and staging a Deployment
 * that happens to be called `dev-api` must not capture it - the rewritten pod would look for a
 * ServiceAccount that can never exist and sit unschedulable.
 */
const PARENT_KINDS: Record<string, string> = {
  configMap:             'ConfigMap',
  configMapRef:          'ConfigMap',
  configMapKeyRef:       'ConfigMap',
  secret:                'Secret',
  secretRef:             'Secret',
  secretKeyRef:          'Secret',
  service:               'Service',
  persistentVolumeClaim: 'PersistentVolumeClaim',
};

// References that say their own kind in a sibling field, the way an HPA's scaleTargetRef does.
const KINDED_PARENTS = ['targetRef', 'scaleTargetRef', 'localObjectReference'];

// `serviceAccount` beside `serviceAccountName` is the deprecated alias the apiserver still
// fills in; rewriting one without the other is a manifest disagreeing with itself.
const KEY_KINDS: Record<string, string> = {
  secretName:         'Secret',
  claimName:          'PersistentVolumeClaim',
  serviceAccountName: 'ServiceAccount',
  serviceAccount:     'ServiceAccount',
};

/**
 * The kind a reference at this position must resolve to, or null when this is not a reference.
 */
function referenceKind(key: string, parentKey: string | null, node: any): string | null {
  if (key === 'name' && parentKey) {
    if (PARENT_KINDS[parentKey]) {
      return PARENT_KINDS[parentKey];
    }

    if (KINDED_PARENTS.includes(parentKey) && typeof node?.kind === 'string') {
      return node.kind;
    }
  }

  return KEY_KINDS[key] || null;
}

/** What is staged, as origin name -> the kinds staged under that name. */
function stagedKinds(): Map<string, Set<string>> {
  const staged = new Map<string, Set<string>>();

  builder.templates.forEach((template) => {
    if (template.origin && template.kind) {
      staged.set(template.origin, new Set([...(staged.get(template.origin) || []), template.kind]));
    }
  });

  return staged;
}

/**
 * Point the staged templates at each other rather than at the cluster they came from.
 *
 * This is the difference between collecting an app and collecting a broken one. Every resource
 * gets its name parameterised to `${install}-<name>` so two installations can coexist - but a
 * Deployment that mounts a ConfigMap still says the *old* name, so installing the collected app
 * produces a pod looking for a ConfigMap nobody created. It is not an error anybody sees at save
 * time; it is a container stuck on ContainerCreating a day later.
 *
 * So every reference to something else in the set is rewritten the same way its owner was.
 * Re-run on every add, because the resource that resolves a dangling reference is usually added
 * after the one that makes it, and it is idempotent: a value already carrying `${install}` is
 * not one of the original names it looks for.
 */
export function relinkStaged(): void {
  const staged = stagedKinds();

  if (!staged.size) {
    return;
  }

  builder.templates.forEach((template) => {
    let manifest;

    try {
      manifest = jsyaml.load(template.content);
    } catch {
      // Somebody is mid-edit and the YAML does not parse yet. Leave it exactly as typed.
      return;
    }

    if (!manifest || typeof manifest !== 'object') {
      return;
    }

    if (rewrite(manifest, staged, null)) {
      template.content = dumpTemplate(manifest);
    }
  });
}

/**
 * Walk one manifest, rewriting references. Returns whether anything changed.
 *
 * A reference is rewritten only when a staged template of the kind it expects carries that
 * origin - see referenceKind. A name that merely coincides with a staged template of some other
 * kind is left alone, and shows up as dangling instead.
 */
function rewrite(node: any, staged: Map<string, Set<string>>, parentKey: string | null): boolean {
  if (Array.isArray(node)) {
    return node.map((child) => rewrite(child, staged, parentKey)).some(Boolean);
  }

  if (!node || typeof node !== 'object') {
    return false;
  }

  let changed = false;

  Object.entries(node).forEach(([key, value]) => {
    const expected = referenceKind(key, parentKey, node);

    if (expected && typeof value === 'string' && staged.get(value)?.has(expected)) {
      node[key] = `\${install}-${ value }`;
      changed = true;

      return;
    }

    if (value && typeof value === 'object') {
      changed = rewrite(value, staged, key) || changed;
    }
  });

  return changed;
}

/**
 * Names the cluster provides on its own, not worth flagging as dangling: every namespace has a
 * `default` ServiceAccount, and `kube-root-ca.crt` is projected into each one.
 */
const PROVIDED = new Set(['ServiceAccount default', 'ConfigMap kube-root-ca.crt']);

export interface DanglingReference {
  kind: string;
  name: string;
}

/**
 * References in one staged template that nothing staged satisfies.
 *
 * The card says so rather than anything blocking the save, because pointing outside the set is
 * sometimes the intent - a Secret managed by hand, an operator's ConfigMap. What must not
 * happen is silence: a Deployment mounting `dev-api-templates` with no such ConfigMap in the
 * app installs cleanly and sits on ContainerCreating a day later.
 */
export function danglingReferences(template: StagedTemplate): DanglingReference[] {
  let manifest;

  try {
    manifest = jsyaml.load(template.content);
  } catch {
    return [];
  }

  if (!manifest || typeof manifest !== 'object') {
    return [];
  }

  const staged = stagedKinds();
  const found: DanglingReference[] = [];
  const seen = new Set<string>();

  collectDangling(manifest, staged, null, found, seen);

  return found;
}

function collectDangling(node: any, staged: Map<string, Set<string>>, parentKey: string | null, found: DanglingReference[], seen: Set<string>): void {
  if (Array.isArray(node)) {
    node.forEach((child) => collectDangling(child, staged, parentKey, found, seen));

    return;
  }

  if (!node || typeof node !== 'object') {
    return;
  }

  Object.entries(node).forEach(([key, value]) => {
    const expected = referenceKind(key, parentKey, node);

    if (expected && typeof value === 'string' && value && !value.includes('${')) {
      const label = `${ expected } ${ value }`;

      if (!staged.get(value)?.has(expected) && !PROVIDED.has(label) && !seen.has(label)) {
        seen.add(label);
        found.push({ kind: expected, name: value });
      }

      return;
    }

    if (value && typeof value === 'object') {
      collectDangling(value, staged, key, found, seen);
    }
  });
}

export function removeTemplate(name: string): void {
  const at = builder.templates.findIndex((template) => template.name === name);

  if (at !== -1) {
    builder.templates.splice(at, 1);
  }
}

/** Everything staged, by kind, for the cards. Sorted so the groups do not reorder as you add. */
export function groupedTemplates(): { kind: string; templates: StagedTemplate[] }[] {
  const groups = new Map<string, StagedTemplate[]>();

  builder.templates.forEach((template) => {
    const kind = template.kind || 'Other';

    groups.set(kind, [...(groups.get(kind) || []), template]);
  });

  return [...groups.entries()]
    .map(([kind, templates]) => ({ kind, templates }))
    .sort((a, b) => a.kind.localeCompare(b.kind));
}

/** Forget what is staged, keeping the drawer open and the app selected. */
export function clearStaged(): void {
  builder.templates = [];
  builder.values = {};
  builder.labels = {};
  builder.notices = [];
}
