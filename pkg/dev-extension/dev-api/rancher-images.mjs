/**
 * Which Rancher server images exist, for the form that makes a Rancher.
 *
 * The form used to offer Docker Hub's tags whichever build was picked, and Docker Hub's floating
 * `head` and `vX.Y-head` are Docker Hub's alone. The SUSE registries have no floating tag at
 * all: a staging head build is `v2.16.0-9456b5a-head`, one tag per commit, with nothing in the
 * name to say which is newest. So `stgregistry.suse.com/rancher/rancher:head` was offered,
 * picked, and left a Rancher in ImagePullBackOff behind an ingress answering "no available
 * server".
 *
 * What says which staging build is newest is the staging chart repository: each head and alpha
 * build publishes a chart whose `appVersion` is the image tag and whose `created` is when.
 * Released Prime builds are the plain `vX.Y.Z` tags on registry.rancher.com. Both are read here
 * rather than in the page because neither host sends CORS headers.
 *
 * Plain functions with no imports, because scripts/gen-dev-api.mjs inlines this into server.mjs;
 * tests/rancher-images.test.mjs holds them.
 */

/** Head builds of every line (`latest`), then alphas and RCs (`alpha`). */
export const STAGING_CHARTS = {
  latest: 'https://charts.optimus.rancher.io/server-charts/latest/index.yaml',
  alpha:  'https://charts.optimus.rancher.io/server-charts/alpha/index.yaml',
};

/** The registry a form's build id pulls from, as the registry API is addressed. */
export const IMAGE_REGISTRIES = {
  community:       'registry-1.docker.io',
  'prime-staging': 'stgregistry.suse.com',
  prime:           'registry.rancher.com',
};

export const RANCHER_REPO = 'rancher/rancher';

/** How many prereleases and releases a list offers. A tag not on it can still be typed. */
const PRERELEASES = 10;
const RELEASES = 30;

const TAG = /^[\w][\w.-]{0,127}$/;

/**
 * The charts in a Helm repository index, as `{ version, appVersion, created }`.
 *
 * Not a YAML parser, and it need not be: an index is written by `helm repo index`, one list item
 * per chart at two spaces under its name and its fields at four. Nested maps (annotations,
 * maintainers) are deeper and skipped. 900 KB of it parses in a few milliseconds.
 *
 * @param {string} yaml The index.
 * @returns {{ version: string, appVersion: string, created: string }[]} Every chart, in file order.
 */
export function chartEntries(yaml) {
  const entries = [];
  let item = null;

  for (const line of String(yaml).split('\n')) {
    const start = /^ {2}- (?:(\w+):\s*(.*))?$/.exec(line);
    const field = start ? start : /^ {4}(\w+):\s*(.+)$/.exec(line);

    if (start) {
      item = { version: '', appVersion: '', created: '' };
      entries.push(item);
    } else if (/^\S/.test(line) || /^ {2}\S/.test(line)) {
      item = null;
    }
    if (item && field?.[1] && field[1] in item) {
      item[field[1]] = field[2].trim().replace(/^["']|["']$/g, '');
    }
  }

  return entries;
}

function lineOf(tag) {
  const m = /^v(\d+)\.(\d+)\./.exec(tag);

  return m ? [Number(m[1]), Number(m[2])] : null;
}

function byLineDesc(a, b) {
  return b.line[0] - a.line[0] || b.line[1] - a.line[1];
}

/**
 * What the form offers for a staging build: the newest head of each line, newest line first,
 * then the newest alphas and RCs. The first is the default - the newest build of main.
 *
 * @param {string} latestYaml The `latest` chart index (head builds).
 * @param {string} alphaYaml The `alpha` chart index (alphas and RCs).
 * @returns {{ default: string, versions: { tag: string, note: string }[] }}
 */
export function stagingVersions(latestYaml, alphaYaml) {
  const newest = new Map();

  for (const chart of chartEntries(latestYaml)) {
    const line = /^v\d+\.\d+\.\d+-[0-9a-f]{7,40}-head$/.test(chart.appVersion) && lineOf(chart.appVersion);

    if (!line) {
      continue;
    }
    const key = line.join('.');
    const held = newest.get(key);

    if (!held || chart.created > held.created) {
      newest.set(key, { tag: chart.appVersion, created: chart.created, line });
    }
  }
  const heads = [...newest.values()].sort(byLineDesc).map((h, i) => ({
    tag:  h.tag,
    note: `${ i ? `newest ${ h.line.join('.') }` : 'newest main' } build, ${ h.created.slice(0, 10) }`,
  }));

  const prereleases = chartEntries(alphaYaml)
    .filter((c) => /^v\d+\.\d+\.\d+-(alpha|rc)\d+$/.test(c.appVersion))
    .sort((a, b) => (a.created < b.created ? 1 : -1))
    .slice(0, PRERELEASES)
    .map((c) => ({ tag: c.appVersion, note: `prerelease, ${ c.created.slice(0, 10) }` }));

  const versions = [...heads, ...prereleases];

  return { default: versions[0]?.tag || '', versions };
}

/**
 * What the form offers for a released Prime build: the plain `vX.Y.Z` tags, newest first.
 *
 * @param {string[]} tags Every tag the registry lists for rancher/rancher.
 * @returns {{ default: string, versions: { tag: string, note: string }[] }}
 */
export function releasedVersions(tags) {
  const versions = tags
    .map((tag) => ({ tag, v: /^v(\d+)\.(\d+)\.(\d+)$/.exec(tag)?.slice(1).map(Number) }))
    .filter((t) => t.v)
    .sort((a, b) => b.v[0] - a.v[0] || b.v[1] - a.v[1] || b.v[2] - a.v[2])
    .slice(0, RELEASES)
    .map((t) => ({ tag: t.tag, note: '' }));

  return { default: versions[0]?.tag || '', versions };
}

/**
 * The token server a registry's 401 names: `Bearer realm="...",service="..."`.
 *
 * @param {string} header WWW-Authenticate.
 * @returns {{ realm: string, service: string } | null}
 */
export function bearerChallenge(header) {
  if (!/^Bearer\s/i.test(String(header || ''))) {
    return null;
  }
  const params = Object.fromEntries([...String(header).matchAll(/(\w+)="([^"]*)"/g)].map((m) => [m[1], m[2]]));

  return params.realm ? { realm: params.realm, service: params.service || '' } : null;
}

/**
 * An anonymous pull token for a repository, or '' when the registry wants none.
 *
 * All three registries open with a 401 naming their token server and all three issue a pull
 * token with no login, which is how an anonymous `docker pull` works.
 */
export async function registryToken(host, repo, fetchImpl = fetch) {
  const probe = await fetchImpl(`https://${ host }/v2/`);

  if (probe.status !== 401) {
    return '';
  }
  const challenge = bearerChallenge(probe.headers.get('www-authenticate'));

  if (!challenge) {
    throw new Error(`${ host } asked for a login this cannot give.`);
  }
  const url = new URL(challenge.realm);

  if (challenge.service) {
    url.searchParams.set('service', challenge.service);
  }
  url.searchParams.set('scope', `repository:${ repo }:pull`);
  const answer = await fetchImpl(url.toString());

  if (!answer.ok) {
    throw new Error(`${ url.host } would not issue a pull token (${ answer.status }).`);
  }
  const body = await answer.json();

  return body.token || body.access_token || '';
}

const MANIFESTS = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(', ');

/**
 * Whether a tag is there to pull: true, false, or a throw when the registry would not say.
 *
 * @param {string} host The registry, as IMAGE_REGISTRIES names it.
 * @param {string} repo The repository.
 * @param {string} tag The tag.
 * @returns {Promise<boolean>}
 */
export async function imageExists(host, repo, tag, fetchImpl = fetch) {
  if (!TAG.test(tag)) {
    return false;
  }
  const token = await registryToken(host, repo, fetchImpl);
  const answer = await fetchImpl(`https://${ host }/v2/${ repo }/manifests/${ encodeURIComponent(tag) }`, {
    method:  'HEAD',
    headers: { accept: MANIFESTS, ...(token ? { authorization: `Bearer ${ token }` } : {}) },
  });

  if (answer.status === 404) {
    return false;
  }
  if (!answer.ok) {
    throw new Error(`${ host } answered ${ answer.status } for ${ repo }:${ tag }.`);
  }

  return true;
}

/**
 * Every tag of a repository, following the registry's `Link` pages. Ten pages at most: the
 * registries here answer in one or two.
 */
export async function registryTags(host, repo, fetchImpl = fetch) {
  const token = await registryToken(host, repo, fetchImpl);
  const tags = [];
  let next = `/v2/${ repo }/tags/list?n=10000`;

  for (let page = 0; next && page < 10; page++) {
    const answer = await fetchImpl(`https://${ host }${ next }`, { headers: token ? { authorization: `Bearer ${ token }` } : {} });

    if (!answer.ok) {
      throw new Error(`${ host } would not list ${ repo }'s tags (${ answer.status }).`);
    }
    tags.push(...((await answer.json()).tags || []));
    next = /<([^>]+)>/.exec(answer.headers.get('link') || '')?.[1] || '';
  }

  return tags;
}
