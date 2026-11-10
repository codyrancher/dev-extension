/**
 * Rendering an App's templates for one Installation: the core, shared.
 *
 * render.ts is what the dashboard's Apps Plus model renders with when an Installation is saved -
 * the App's templates, `${name}` substituted, written into a Fleet Bundle. dev-api makes a
 * workspace by itself now (a review that starts with nobody's dashboard open), and a Bundle it
 * writes has to be the Bundle the dashboard would have written, or the two would fight over it the
 * next time somebody saves. So the substitution and the values it uses are here, once, and both
 * import them. Pure and importless: tests/render-core.test.mjs.
 */

// No whitespace inside the braces, deliberately: `${ name }` is how a JavaScript template literal
// or a shell script in a ConfigMap breathes, and the spacing is the tell between ours and theirs.
export const VARIABLE = /\$\{([A-Za-z0-9_.-]+)\}/g;

/** Replace `${name}` for the names in the bag, and leave every other `${...}` exactly as written. */
export function substituteValues(source, values) {
  return (source || '').replace(VARIABLE, (match, key) => {
    const value = values[key];

    return value === undefined || value === null ? match : String(value);
  });
}

/** The App's defaults, the Installation's overrides on top, and the values the pair knows about itself. */
export function mergeAppValues(app, instance) {
  const namespace = instance?.spec?.namespace || 'default';

  return {
    ...(app?.spec?.values || {}),
    ...(instance?.spec?.values || {}),
    app:      app?.metadata?.name || instance?.spec?.app || '',
    install:  instance?.metadata?.name || '',
    // The name `install` had before Installations were called that; an App still using it renders.
    instance: instance?.metadata?.name || '',
    // The cluster an Installation provisions, so its resource and cluster templates agree on it.
    cluster:  instance?.clusterName || instance?.spec?.provisionCluster?.name || instance?.metadata?.name || '',
    namespace,
  };
}

/** Every template of the App, rendered for this Installation, as `{ name, content }`. */
export function renderAppTemplates(app, instance) {
  const values = mergeAppValues(app, instance);

  return (app?.spec?.templates || []).map((template, i) => ({
    name:    substituteValues(template?.name || `resource-${ i }.yaml`, values),
    content: substituteValues(template?.content || '', values),
  }));
}
