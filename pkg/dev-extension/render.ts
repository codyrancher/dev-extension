// Rendering an App's templates for one instance.
//
// Deliberately not Helm. A chart's templating is a whole language with a runtime, and the
// point here is that a template is a YAML file you can read: the only substitution is
// `${name}`, for the names the app declares in `spec.values` and the built-ins below. Anything
// else is left exactly as written rather than blanked, so a `${...}` that belongs to whatever
// the YAML configures - a script in a ConfigMap, an nginx config - survives being rendered.

import { DEFAULT_CLUSTER_VALUES } from './config/cluster-template';

export interface Template {
  name: string;
  content: string;
}

// No whitespace inside the braces, deliberately. Everything this extension writes is `${name}`
// exactly, while `${ name }` is how JavaScript template literals and shell scripts breathe - and
// a ConfigMap holding a script is an ordinary thing to template. The spacing is the one reliable
// tell between "ours" and "the file's own syntax", so a spaced form is left alone.
const VARIABLE = /\$\{([A-Za-z0-9_.-]+)\}/g;

/**
 * Values nobody has to supply: four the app and installation know about themselves, the id of a
 * cloud credential (resolved from the ones Rancher has, see cloudCredentialId on the model),
 * plus whatever the built-in cluster template defaults. A template using these is satisfied by
 * definition.
 *
 * `instance` is the old name for `install` and is last on purpose: it still resolves, so an app
 * written before the rename keeps working, but it is not offered anywhere.
 */
export const BUILT_IN_VALUES = ['app', 'install', 'cluster', 'namespace', 'cloudCredential', 'instance'];

/**
 * The built-ins worth telling somebody about, and what each one is.
 *
 * A subset of BUILT_IN_VALUES rather than the same list, because two of those are not things to
 * put in front of a person: `instance` is the old name for `install` and only exists so that
 * apps written before the rename still render, and `cloudCredential` belongs to the cluster
 * template rather than to a resource template. Both still resolve; neither is advertised.
 *
 * Kept here, beside the list it is a subset of, so a new built-in is one edit rather than two.
 */
export const DOCUMENTED_VALUES: { name: string; what: string }[] = [
  { name: 'app', what: 'the name of this app' },
  { name: 'install', what: 'the name of the installation being deployed' },
  { name: 'cluster', what: 'the cluster it is going to' },
  { name: 'namespace', what: 'the namespace the resources land in' },
];

/**
 * Names nobody has to supply, given how the installation deploys.
 *
 * The cluster defaults only answer when a cluster template is actually rendered - syncCluster
 * substitutes them in, and nothing else does. Counting them unconditionally meant an app could
 * declare `region` with no default and every non-provisioning installation was told it owed
 * nothing, right up until the deployed YAML said `${region}`.
 */
function autoSatisfied(includeCluster: boolean): string[] {
  return includeCluster ? [...BUILT_IN_VALUES, ...Object.keys(DEFAULT_CLUSTER_VALUES)] : BUILT_IN_VALUES;
}

/** A value counts as supplied only if it is actually set to something. */
export function isSet(bag: Record<string, unknown> | undefined, key: string): boolean {
  const value = bag?.[key];

  return value !== undefined && value !== null && `${ value }`.trim() !== '';
}

/** Every `${...}` a piece of template text refers to, in order of first appearance. */
export function referencedVariables(source: string): string[] {
  const found = new Set<string>();
  const pattern = new RegExp(VARIABLE.source, 'g');
  let match = pattern.exec(source || '');

  while (match !== null) {
    found.add(match[1]);
    match = pattern.exec(source || '');
  }

  return [...found];
}

/**
 * Every variable an app answers for: the ones its definer declared, plus the built-ins.
 *
 * Declared, not scraped. The parameters of an app are exactly the keys in `spec.values` -
 * FieldPicker and the importer write one there for every field they parameterise - so the app
 * already knows its own set. Scanning the template bodies for `${...}` instead is how a
 * ConfigMap holding a shell script or a JS file turns into a form demanding `${TOKEN}` and
 * `${response.status}`: file contents get to use that syntax for themselves.
 *
 * The cluster template is still scanned, and only when it is going to be rendered. It is not
 * built by the picker, so scanning is the only way to learn what a hand-written one asks for -
 * and it is a provisioning manifest, not a file body, so the syntax is not shared with anything.
 * An instance that deploys to clusters that already exist never renders it.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function appVariables(app: any, includeCluster = false): string[] {
  const found = new Set<string>(Object.keys(app?.spec?.values || {}));

  BUILT_IN_VALUES.forEach((name) => found.add(name));

  if (includeCluster) {
    referencedVariables(app?.spec?.clusterTemplate || '').forEach((name) => found.add(name));
  }

  return [...found];
}

/** One template's `${...}` uses that the app does not answer. */
export interface UndeclaredReference {
  /** The template's file name, so the message can say where. */
  file: string;
  names: string[];
}

/**
 * `${...}` in an app's templates that neither the app nor the built-ins answer.
 *
 * The complement of the declared model. Parameters are exactly the keys in `spec.values`, and
 * scraping template bodies must never feed `substitute` - but an app authored by hand or by
 * kubectl can write `${maxmemory}` in a template and declare nothing, and then every screen
 * that trusts the declaration says "no values" while the rendered YAML says otherwise. Whether
 * that `${...}` is a forgotten parameter or a script's own syntax is not decidable here, so
 * this names it and the screens warn: it deploys as written unless somebody declares it.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function undeclaredReferences(app: any): UndeclaredReference[] {
  const declared = new Set([...Object.keys(app?.spec?.values || {}), ...BUILT_IN_VALUES]);

  return (app?.spec?.templates || [])
    .map((template: Template, i: number) => ({
      file:  template?.name || `resource-${ i }.yaml`,
      names: referencedVariables(template?.content || '').filter((name) => !declared.has(name)),
    }))
    .filter((reference: UndeclaredReference) => reference.names.length);
}

/**
 * The same references shaped for the warning banner - four surfaces show one, and the shape
 * has to match the l10n message everywhere, so the mapping lives beside the scan rather than
 * being repeated at each of them.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function undeclaredWarnings(app: any): { file: string; count: number; refs: string }[] {
  return undeclaredReferences(app).map(({ file, names }) => ({
    file,
    count: names.length,
    refs:  names.map((name) => `\${${ name }}`).join(', '),
  }));
}

/**
 * The variables an app cannot answer itself, so every instance of it has to supply them.
 *
 * This is what makes a template change safe or unsafe. Declaring `replicas` with a default
 * changes nothing for existing instances; declaring it with an empty one means none of them
 * can be rendered until somebody says what replicas is.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function requiredValues(app: any, includeCluster = false): string[] {
  return appVariables(app, includeCluster)
    .filter((name) => !autoSatisfied(includeCluster).includes(name))
    .filter((name) => !isSet(app?.spec?.values, name));
}

/** What this instance still owes its app before it can be rendered at all. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function missingValues(app: any, instance: any): string[] {
  const includeCluster = !!instance?.spec?.provisionCluster?.enabled;

  return requiredValues(app, includeCluster)
    .filter((name) => !isSet(instance?.spec?.values, name));
}

/**
 * Replace `${name}` for the names in the bag, and nothing else.
 *
 * The bag is the declared values plus the built-ins (see mergeValues), which is what makes this
 * safe to run over a template whose file bodies use `${...}` for their own purposes: an
 * entrypoint script's `${SA}` is not in the bag, so it survives rendering exactly as written.
 */
export function substitute(source: string, values: Record<string, unknown>): string {
  return (source || '').replace(VARIABLE, (match, key) => {
    const value = values[key];

    return value === undefined || value === null ? match : String(value);
  });
}

/**
 * The values one instance renders with: the App's defaults, the instance's overrides on top,
 * and three the pair always knows about themselves.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function mergeValues(app: any, instance: any): Record<string, unknown> {
  const namespace = instance?.spec?.namespace || 'default';

  return {
    ...(app?.spec?.values || {}),
    ...(instance?.spec?.values || {}),
    app:      app?.metadata?.name || instance?.spec?.app || '',
    install:  instance?.metadata?.name || '',
    // The name this had before installations were called installations. Kept because the
    // substitution leaves an unmatched `${...}` exactly as written rather than blanking it, so
    // dropping it would not fail an app that still uses it - it would deploy a resource
    // literally named `${instance}-hello`. It costs one line and it is in BUILT_IN_VALUES, so
    // nothing asks anybody to supply it.
    instance: instance?.metadata?.name || '',
    // The cluster an instance provisions, so one app's resource templates and its cluster
    // template can both refer to it by the same name.
    cluster:  instance?.clusterName || instance?.spec?.provisionCluster?.name || instance?.metadata?.name || '',
    namespace,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function renderTemplates(app: any, instance: any): Template[] {
  const values = mergeValues(app, instance);

  return (app?.spec?.templates || []).map((template: Template, i: number) => ({
    name:    substitute(template?.name || `resource-${ i }.yaml`, values),
    content: substitute(template?.content || '', values),
  }));
}
