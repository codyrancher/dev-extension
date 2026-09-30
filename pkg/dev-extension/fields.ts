// Which fields of a manifest are worth offering as parameters, and how to set one.
//
// The YAML is the source of truth and stays that way: a toggle writes `${name}` into it and a
// default into the values, and turning the toggle off puts the value back. Nothing is stored
// twice, so hand-editing the YAML and using the picker cannot disagree.
//
// Pure on purpose - no Vue, no store. What counts as a field worth suggesting is the whole
// judgement of this feature, and it should be readable without any of that.

/** One scalar in a manifest, addressed by the path that reaches it. */
export interface Field {
  /** `spec.template.spec.containers.0.image` */
  path: string;
  /** What a person should read: `containers[0].image`, trimmed of the noise above it. */
  label: string;
  /** The words Rancher's own form uses, when there are any. See labelFriendly. */
  friendly: string | null;
  /** The value as it stands, or the parameter name when it is already one. */
  value: string;
  /** Set when this field is already `${something}`. */
  parameter: string | null;
}

/**
 * Paths worth offering without being asked, most useful first.
 *
 * Ordered rules rather than a set, because the order is the suggestion: an image and a replica
 * count are what almost every installation changes, and a `terminationGracePeriodSeconds` is
 * what almost none of them do. The last segment of each pattern is matched against the path, so
 * `image` catches a container's image wherever the kind happens to put it.
 *
 * Everything not listed is still reachable - see `searchFields` - this only decides what is on
 * screen before anybody types.
 */
const SUGGESTED = [
  /(^|\.)image$/,
  /(^|\.)replicas$/,
  /(^|\.)host$/,
  /(^|\.)storageClassName$/,
  /(^|\.)storage$/,
  /(^|\.)cpu$/,
  /(^|\.)memory$/,
  /(^|\.)containerPort$/,
  /(^|\.)port$/,
  /(^|\.)targetPort$/,
  /(^|\.)nodePort$/,
  /(^|\.)secretName$/,
  /(^|\.)serviceAccountName$/,
  /^data\./,
  /(^|\.)env\.\d+\.value$/,
];

/**
 * Paths never worth offering.
 *
 * Two kinds. Fields the apiserver or a controller owns, which a person setting them would only
 * be fighting; and the name, which is already parameterised on import and offering again would
 * suggest it was not.
 */
const NEVER = [
  /^apiVersion$/, /^kind$/,
  /^metadata\.name$/,
  /(^|\.)creationTimestamp$/,
  /(^|\.)progressDeadlineSeconds$/,
  /(^|\.)revisionHistoryLimit$/,
  /(^|\.)terminationGracePeriodSeconds$/,
  /(^|\.)dnsPolicy$/,
  /(^|\.)restartPolicy$/,
  /(^|\.)schedulerName$/,
  /(^|\.)terminationMessage/,
  /(^|\.)imagePullPolicy$/,
  /(^|\.)protocol$/,
  /(^|\.)sessionAffinity$/,
  /(^|\.)internalTrafficPolicy$/,
  /(^|\.)ipFamil/,
  /^status(\.|$)/,
];

// No whitespace inside the braces, matching VARIABLE in render.ts: `${ name }` is a script's
// own syntax, not one of this extension's parameters, and must not present as already toggled.
const PLACEHOLDER = /^\$\{([A-Za-z0-9_.-]+)\}$/;

/**
 * What a field is called on Rancher's own form for it.
 *
 * The point of the picker is that somebody should not have to read YAML to find the three
 * fields that matter, and `spec.template.spec.containers.0.image` is YAML with the punctuation
 * changed. These are the words the resource's own edit page uses, which is what somebody is
 * looking for.
 *
 * Matched on the path's tail so one entry covers every kind that has the field, and the raw
 * path is still shown underneath - the label is for finding it, the path is for being sure.
 *
 * Every pattern in SUGGESTED must be covered here, which is what the generic entries at the
 * bottom are for. A promoted field with no label renders its raw JSONPath as a title, which is
 * exactly the thing the labels exist to spare people - so a new suggestion comes with a label
 * or it inherits a generic one, never neither.
 */
const LABELS: [RegExp, string][] = [
  [/(^|\.)containers\.\d+\.image$/, 'Container Image'],
  [/(^|\.)image$/, 'Image'],
  [/(^|\.)replicas$/, 'Replicas'],
  [/(^|\.)containers\.\d+\.ports\.\d+\.containerPort$/, 'Container Port'],
  [/(^|\.)containerPort$/, 'Container Port'],
  [/(^|\.)targetPort$/, 'Target Port'],
  [/(^|\.)nodePort$/, 'Node Port'],
  [/(^|\.)ports\.\d+\.port$/, 'Service Port'],
  // Probe ports before the generic port: a probe's port usually holds the same value as the
  // container port beside it, and two rows that only differ in a JSONPath read as duplicates.
  [/(^|\.)livenessProbe\.\w+\.port$/, 'Liveness Probe Port'],
  [/(^|\.)readinessProbe\.\w+\.port$/, 'Readiness Probe Port'],
  [/(^|\.)startupProbe\.\w+\.port$/, 'Startup Probe Port'],
  [/(^|\.)host$/, 'Host'],
  [/(^|\.)storageClassName$/, 'Storage Class'],
  [/(^|\.)requests\.storage$/, 'Storage Size'],
  [/(^|\.)limits\.cpu$/, 'CPU Limit'],
  [/(^|\.)requests\.cpu$/, 'CPU Reservation'],
  [/(^|\.)limits\.memory$/, 'Memory Limit'],
  [/(^|\.)requests\.memory$/, 'Memory Reservation'],
  [/(^|\.)secretName$/, 'Secret Name'],
  [/(^|\.)serviceAccountName$/, 'Service Account'],
  [/(^|\.)env\.\d+\.value$/, 'Environment Variable'],
  [/^data\./, 'Data'],
  // The safety net for SUGGESTED: anything promoted without a more specific label above still
  // gets a readable title rather than its path.
  [/(^|\.)port$/, 'Port'],
  [/(^|\.)storage$/, 'Storage Size'],
  [/(^|\.)cpu$/, 'CPU'],
  [/(^|\.)memory$/, 'Memory'],
];

/** The words for a path, or null when there are none worth inventing. */
export function labelFriendly(path: string): string | null {
  const hit = LABELS.find(([pattern]) => pattern.test(path));

  if (!hit) {
    return null;
  }

  // `data.index.html` is "Data: index.html" - the key is the useful half, not the word Data.
  if (hit[1] === 'Data') {
    return `Data: ${ path.slice('data.'.length) }`;
  }

  return hit[1];
}

/** A path a person can read: the array indices kept, the long prefix dropped. */
function labelFor(path: string): string {
  const parts = path.split('.');
  const short = parts.length > 3 ? parts.slice(-3) : parts;

  return short
    .reduce((out, part) => (/^\d+$/.test(part) ? `${ out }[${ part }]` : `${ out }${ out ? '.' : '' }${ part }`), '');
}

const ENV_VALUE = /(^|\.)env\.\d+\.value$/;
const CONTAINER_IMAGE = /(^|\.)containers\.\d+\.image$/;

/**
 * The label for one field, given the whole manifest to look around in.
 *
 * Env values and container images need the manifest: three rows all reading "Container Image"
 * cannot be told apart without decoding the JSONPath under them, and the sibling `name` key is
 * sitting right beside the value - so the label borrows it and reads "Container Image: nginx",
 * "Environment Variable: PORT".
 */
function friendlyFor(path: string, root: any): string | null {
  const friendly = labelFriendly(path);
  // A sibling name that is itself a parameter is a placeholder, not a name worth borrowing:
  // "Container Image: ${name}" reads as a bug, not a label.
  const usable = (name: any) => name && !PLACEHOLDER.test(String(name));

  if (friendly === 'Environment Variable' && ENV_VALUE.test(path)) {
    const name = readAt(root, path.replace(/value$/, 'name'));

    if (usable(name)) {
      return `Environment Variable: ${ name }`;
    }
  }

  if (friendly === 'Container Image' && CONTAINER_IMAGE.test(path)) {
    const name = readAt(root, path.replace(/image$/, 'name'));

    if (usable(name)) {
      return `Container Image: ${ name }`;
    }
  }

  return friendly;
}

/** Every scalar in the manifest, with the path that reaches it. */
export function leafFields(manifest: any, prefix = '', root: any = manifest): Field[] {
  if (manifest === null || manifest === undefined) {
    return [];
  }

  if (Array.isArray(manifest)) {
    return manifest.flatMap((item, i) => leafFields(item, prefix ? `${ prefix }.${ i }` : `${ i }`, root));
  }

  if (typeof manifest === 'object') {
    return Object.entries(manifest)
      .flatMap(([key, value]) => leafFields(value, prefix ? `${ prefix }.${ key }` : key, root));
  }

  const value = String(manifest);
  const placeholder = PLACEHOLDER.exec(value);

  return [{
    path:      prefix,
    label:     labelFor(prefix),
    friendly:  friendlyFor(prefix, root),
    value,
    parameter: placeholder ? placeholder[1] : null,
  }];
}

/** Paths that must never be offered as parameters, wherever the offer would come from. */
export function isNever(path: string): boolean {
  return NEVER.some((pattern) => pattern.test(path));
}

/**
 * What to show before anybody searches: what is already a parameter, then the suggestions.
 *
 * A field that is already `${something}` comes first whatever it is - somebody chose it, and a
 * list that hid their choice below a suggestion would be a list they had to search to audit.
 */
export function suggestedFields(manifest: any): Field[] {
  const all = leafFields(manifest).filter((field) => !isNever(field.path));
  const chosen = all.filter((field) => field.parameter);
  const rest = all.filter((field) => !field.parameter);
  const suggested: Field[] = [];

  SUGGESTED.forEach((pattern) => {
    rest.forEach((field) => {
      if (pattern.test(field.path) && !suggested.includes(field)) {
        suggested.push(field);
      }
    });
  });

  return [...chosen, ...suggested];
}

/** Anything matching what was typed, for the fields the suggestions do not cover. */
export function searchFields(manifest: any, query: string): Field[] {
  const needle = query.trim().toLowerCase();

  if (!needle) {
    return [];
  }

  return leafFields(manifest)
    .filter((field) => !isNever(field.path))
    .filter((field) => field.path.toLowerCase().includes(needle) || field.value.toLowerCase().includes(needle))
    .slice(0, 40);
}

/**
 * A parameter name for a field, not already taken.
 *
 * The last readable segment of the path, so `containers[0].image` is `image` and
 * `resources.limits.memory` is `memory` - which is what somebody would have typed. An index is
 * skipped rather than included: `image` reads better than `image0`, and the second one only
 * needs a suffix because the first one took the name.
 */
export function parameterNameFor(path: string, taken: Iterable<string>): string {
  const parts = path.split('.').filter((part) => !/^\d+$/.test(part));
  const base = parts[parts.length - 1] || 'value';
  const used = new Set(taken);

  if (!used.has(base)) {
    return base;
  }

  for (let i = 2; ; i++) {
    if (!used.has(`${ base }${ i }`)) {
      return `${ base }${ i }`;
    }
  }
}

/** A default comes back as a string; a number that was a number should go back as one. */
function coerce(value: string): unknown {
  if (/^-?\d+$/.test(value)) {
    return Number(value);
  }

  if (value === 'true' || value === 'false') {
    return value === 'true';
  }

  return value;
}

/**
 * Turn the field at a path into a parameter, or turn it back into a value.
 *
 * On: the current value becomes the default and the field becomes `${name}`. Off: the default
 * is written back into the YAML and dropped from the values, because a default for a parameter
 * nothing refers to is exactly what the stale marker in the values editor complains about.
 *
 * The manifest is mutated in place; the returned values and labels are fresh objects. Shared by
 * both places a field can be toggled - the Customizable list and the Configure form - so the two
 * can never disagree about what a toggle means.
 */
export function applyToggle(
  manifest: any,
  path: string,
  values: Record<string, unknown>,
  labels: Record<string, string>,
): { values: Record<string, unknown>; labels: Record<string, string> } {
  const current = readAt(manifest, path);
  const placeholder = PLACEHOLDER.exec(String(current ?? ''));
  const nextValues = { ...values };
  const nextLabels = { ...labels };

  if (placeholder) {
    const name = placeholder[1];
    const previous = nextValues[name];

    writeAt(manifest, path, previous === undefined ? '' : coerce(String(previous)));
    delete nextValues[name];
    delete nextLabels[name];
  } else {
    const name = parameterNameFor(path, Object.keys(nextValues));

    nextValues[name] = String(current ?? '');
    nextLabels[name] = friendlyFor(path, manifest) || labelFor(path);
    writeAt(manifest, path, `\${${ name }}`);
  }

  return { values: nextValues, labels: nextLabels };
}

/** The parameter name at a path, when the field there is `${something}`. */
export function parameterAt(manifest: any, path: string): string | null {
  const match = PLACEHOLDER.exec(String(readAt(manifest, path) ?? ''));

  return match ? match[1] : null;
}

/** Read the scalar at a path. */
export function readAt(manifest: any, path: string): any {
  return path.split('.').reduce((node, key) => (node === undefined || node === null ? node : node[key]), manifest);
}

/** Write a scalar at a path, in place. */
export function writeAt(manifest: any, path: string, value: unknown): void {
  const parts = path.split('.');
  const last = parts.pop() as string;
  const holder = parts.reduce((node, key) => node?.[key], manifest);

  if (holder && typeof holder === 'object') {
    holder[last] = value;
  }
}
