// Turning a live Kubernetes object into a template.
//
// A resource read out of a cluster is not a manifest. It carries what the apiserver wrote on it
// (uid, resourceVersion, managedFields), what the scheduler and the controllers decided
// (clusterIP, nodeName, volumeName), what whatever deployed it left behind (Helm's and Fleet's
// annotations), and a full `status`. Applying that verbatim to a different cluster fails, and
// applying it to the same one quietly re-adopts somebody else's object. So the value of this
// import is almost entirely in what it takes out.
//
// It is a pure function on purpose: no store, no fetch, no Vue. What it does is the part worth
// being able to reason about, and it should be readable without any of that.

import jsyaml from 'js-yaml';

/**
 * YAML for a template, with whole-value placeholders left unquoted.
 *
 * `jsyaml.dump` quotes `${replicas}` because a plain scalar may not begin with `{` and it will
 * not reason about the `$` in front. That is correct YAML and the wrong thing here: the quotes
 * survive substitution, so `replicas: '${replicas}'` becomes `replicas: '1'` and the apiserver
 * refuses it - `cannot unmarshal string into Go struct field DeploymentSpec.spec.replicas of
 * type int32`. A template that saves cleanly and fails on install is the worst kind of wrong.
 *
 * Only a value that is *entirely* one placeholder is unquoted, which is what makes this safe.
 * `name: '${install}-hello-site'` keeps its quotes and stays a string, as a name should; only
 * `${replicas}` and `${image}`, which stand alone, are freed to become whatever they are given.
 */
export function dumpTemplate(manifest: unknown): string {
  return jsyaml.dump(manifest, { noRefs: true, lineWidth: -1 })
    .replace(/^(\s*(?:- )?[\w.\-/]+:\s*)'(\$\{[A-Za-z0-9_.-]+\})'\s*$/gm, '$1$2')
    .replace(/^(\s*- )'(\$\{[A-Za-z0-9_.-]+\})'\s*$/gm, '$1$2');
}

export interface Imported {
  /** The template body. */
  content: string;
  /** A file name for it, derived from the kind. */
  name: string;
  /** Parameters this introduced, with the resource's own values as defaults. */
  values: Record<string, string>;
  /** What each introduced parameter should be called on an install form. */
  labels: Record<string, string>;
  /** What the resource was called before the name was parameterised. See relink in builder/state.ts. */
  originalName: string;
  /** What was taken out, in the order it was taken, so somebody can be told. */
  removed: string[];
}

/**
 * The only metadata a template wants, and everything else goes.
 *
 * A whitelist rather than a list of things to remove, which is what this was first and which
 * kept losing. The apiserver's own fields are a known list (`uid`, `resourceVersion`,
 * `managedFields`, ...), but a resource that arrived as a Vuex model also carries whatever the
 * store hung on it - `associatedData`, `relationships`, `state`, `fields` - and that list is
 * not this extension's to keep up with. Three keys is all a manifest needs; anything new that
 * appears alongside them is by definition not one of them.
 *
 * `namespace` is deliberately not here. Fleet sets it from the installation's target namespace,
 * which is what lets one app deploy to a different namespace per installation.
 */
const METADATA_KEEP = ['name', 'labels', 'annotations'];

/**
 * Annotation and label prefixes written by whatever last deployed the thing.
 *
 * Carrying these into a template is worse than untidy: Helm's `meta.helm.sh/release-name` makes
 * a future release believe it already owns the object, and Fleet's `objectset.rio.cattle.io`
 * hash makes its agent think the object belongs to a bundle it does not.
 */
const MACHINERY_PREFIXES = [
  'kubectl.kubernetes.io/',
  'objectset.rio.cattle.io/',
  'meta.helm.sh/',
  'app.kubernetes.io/managed-by',
  'deployment.kubernetes.io/revision',
  'field.cattle.io/',
  'cattle.io/creator',
  'management.cattle.io/',
  'autoscaling.alpha.kubernetes.io/',
];

/**
 * Spec fields a controller fills in, by kind.
 *
 * Every one of these is rejected or silently ignored on create, and the two IP ones are the
 * reason a copied Service cannot be applied to a second cluster at all.
 */
const SPEC_DROP: Record<string, string[]> = {
  Service:               ['clusterIP', 'clusterIPs', 'ipFamilies', 'ipFamilyPolicy', 'healthCheckNodePort'],
  PersistentVolumeClaim: ['volumeName'],
  ServiceAccount:        ['secrets'],
  Pod:                   ['nodeName', 'nodeSelector', 'serviceAccount'],
};

function isMachinery(key: string): boolean {
  return MACHINERY_PREFIXES.some((prefix) => key === prefix || key.startsWith(prefix));
}

function stripMachinery(bag: Record<string, string> | undefined, removed: string[], what: string): Record<string, string> | undefined {
  if (!bag) {
    return undefined;
  }

  const kept: Record<string, string> = {};

  Object.entries(bag).forEach(([key, value]) => {
    if (isMachinery(key)) {
      removed.push(`${ what } ${ key }`);
    } else {
      kept[key] = value;
    }
  });

  return Object.keys(kept).length ? kept : undefined;
}

/**
 * Whether this object's `type` is Steve's rather than the resource's own.
 *
 * Steve overwrites `type` with the schema id - `apps.deployment`, `secret` - and dropping it
 * blindly would take a Secret's `type: Opaque` with it, which is a field that matters. The
 * schema id always ends in the lowercased kind; `Opaque` and `kubernetes.io/tls` do not.
 *
 * A Secret read through Steve has already lost its own `type` to the envelope before it reaches
 * here, which is Steve's doing and not something this can recover.
 */
function isSteveType(manifest: Record<string, any>): boolean {
  const type = manifest?.type;
  const kind = String(manifest?.kind || '').toLowerCase();

  if (typeof type !== 'string' || !kind) {
    return false;
  }

  return type.toLowerCase() === kind || type.toLowerCase().endsWith(`.${ kind }`);
}

/** Drop a key and say so, but only when it was actually there. */
function drop(holder: Record<string, unknown>, key: string, removed: string[], what: string): void {
  if (holder && key in holder) {
    delete holder[key];
    removed.push(`${ what }${ key }`);
  }
}

/**
 * The parameters worth introducing, and nothing beyond them.
 *
 * The name always becomes one, because two installations of the same app deploying into one
 * namespace would otherwise write the same object twice - which is not an error anybody sees,
 * it is the second installation silently taking the first one's resource.
 *
 * The other two are judgement, and both are things people change per installation rather than
 * per app: how many replicas, and which image tag. Everything else is left as it was found. A
 * template full of variables nobody wanted is harder to read than one with none, and unused
 * defaults are exactly what the stale marker on the values editor complains about.
 */
function parameterise(manifest: Record<string, any>, values: Record<string, string>, labels: Record<string, string>, taken: Set<string>): void {
  const name = manifest.metadata?.name;

  if (name) {
    manifest.metadata.name = `\${install}-${ name }`;
  }

  // The labels are the same words the Customizable tab would use for these fields, so a
  // parameter reads the same on the install form as it did when it was chosen.
  if (typeof manifest.spec?.replicas === 'number') {
    const key = parameterName('replicas', name, taken);

    values[key] = String(manifest.spec.replicas);
    labels[key] = 'Replicas';
    manifest.spec.replicas = `\${${ key }}`;
  }

  // Only for a single container: with two, `${image}` would have to mean both, and naming them
  // apart is a decision this cannot make for somebody.
  const containers = manifest.spec?.template?.spec?.containers || manifest.spec?.containers;

  if (Array.isArray(containers) && containers.length === 1 && containers[0]?.image) {
    const key = parameterName('image', name, taken);

    values[key] = containers[0].image;
    labels[key] = 'Container Image';
    containers[0].image = `\${${ key }}`;
  }
}

/**
 * A parameter name no other resource in this app has already claimed.
 *
 * The bare name first, because one workload is the ordinary case and `${image}` reads better on
 * an install form than `${hello-site-image}`. A second one has to say which resource it means:
 * two Deployments both parameterised to `${image}` is a single field on the install form
 * setting both containers to the same tag, which nothing warns about and nobody asked for.
 */
function parameterName(base: string, resourceName: string, taken: Set<string>): string {
  if (!taken.has(base)) {
    taken.add(base);

    return base;
  }

  const scoped = `${ String(resourceName || '').replace(/[^A-Za-z0-9_.-]+/g, '-') }-${ base }`;

  if (resourceName && !taken.has(scoped)) {
    taken.add(scoped);

    return scoped;
  }

  for (let i = 2; ; i++) {
    if (!taken.has(`${ base }${ i }`)) {
      taken.add(`${ base }${ i }`);

      return `${ base }${ i }`;
    }
  }
}

/** `hello-site` + `Deployment` -> `hello-site-deployment.yaml`. */
function fileNameFor(name: string, kind: string): string {
  const parts = [name, String(kind || 'resource').toLowerCase()]
    .map((part) => String(part || '').replace(/[^A-Za-z0-9.-]+/g, '-').replace(/^-|-$/g, ''))
    .filter(Boolean);

  return `${ parts.join('-') || 'resource' }.yaml`;
}

/**
 * One live resource as a template, with everything that made it live taken back out.
 *
 * `resource` is what Steve returns, which is the Kubernetes object plus an envelope of its own.
 */
export function importResource(resource: any, taken: Iterable<string> = []): Imported {
  const removed: string[] = [];
  const values: Record<string, string> = {};
  const labels: Record<string, string> = {};
  const manifest = JSON.parse(JSON.stringify(resource || {}));

  // Steve's envelope, which is not part of the object at all.
  ['id', 'links', 'actions', 'count', 'revision'].forEach((key) => drop(manifest, key, removed, ''));

  // And the store model's own bookkeeping. A resource that came from a Vuex model rather than
  // straight off the wire carries `_id`, `_type` and friends, which serialise like any other
  // field and ended up at the top of the imported YAML. Kubernetes has no underscore-prefixed
  // fields, so the prefix is a safe rule rather than a list to keep up to date.
  Object.keys(manifest)
    .filter((key) => key.startsWith('_'))
    .forEach((key) => drop(manifest, key, removed, ''));

  if (isSteveType(manifest)) {
    drop(manifest, 'type', removed, '');
  }

  drop(manifest, 'status', removed, '');

  if (manifest.metadata) {
    Object.keys(manifest.metadata)
      .filter((key) => !METADATA_KEEP.includes(key))
      .forEach((key) => drop(manifest.metadata, key, removed, 'metadata.'));

    const labels = stripMachinery(manifest.metadata.labels, removed, 'label');
    const annotations = stripMachinery(manifest.metadata.annotations, removed, 'annotation');

    if (labels) {
      manifest.metadata.labels = labels;
    } else {
      delete manifest.metadata.labels;
    }

    if (annotations) {
      manifest.metadata.annotations = annotations;
    } else {
      delete manifest.metadata.annotations;
    }
  }

  (SPEC_DROP[manifest.kind] || []).forEach((key) => drop(manifest.spec || {}, key, removed, 'spec.'));

  // A pod template carries its own empty creationTimestamp, which yaml renders as `null` and
  // which nothing needs.
  if (manifest.spec?.template?.metadata) {
    drop(manifest.spec.template.metadata, 'creationTimestamp', removed, 'spec.template.metadata.');
  }

  // Ports keep their number and lose the one the cluster picked.
  (manifest.spec?.ports || []).forEach((port: Record<string, unknown>) => drop(port, 'nodePort', removed, 'spec.ports[].'));

  const original = String(manifest.metadata?.name || '');

  parameterise(manifest, values, labels, new Set(taken));

  return {
    content:      dumpTemplate(manifest),
    // Named after the resource as well as its kind. An app that collects two Deployments
    // otherwise lists `deployment.yaml` and `deployment-2.yaml`, and the only way to tell which
    // is which is to open both.
    name:         fileNameFor(original, manifest.kind),
    originalName: original,
    values,
    labels,
    removed,
  };
}
