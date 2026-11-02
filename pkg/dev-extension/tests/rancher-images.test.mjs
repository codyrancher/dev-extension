// Which Rancher tags the create form offers per build, and whether a tag is there to pull. The
// one that went wrong: Docker Hub's floating `head` offered for a staging build, which has none.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chartEntries, stagingVersions, releasedVersions, bearerChallenge, imageExists, registryTags
} from '../dev-api/rancher-images.mjs';

// The shape `helm repo index` writes, cut down: nested maps, quoted and bare values.
const LATEST = `apiVersion: v1
entries:
  rancher:
  - annotations:
      catalog.cattle.io/release-name: rancher
    apiVersion: v2
    appVersion: v2.16.0-9456b5a-head
    created: "2026-11-02T15:55:39.1Z"
    version: 2.16.0-9456b5a-head
  - apiVersion: v2
    appVersion: v2.16.0-e9d23b0-head
    created: "2026-11-02T09:43:43.1Z"
    version: 2.16.0-e9d23b0-head
  - apiVersion: v2
    appVersion: v2.15.4-97fac5a-head
    created: "2026-11-02T15:57:38.1Z"
    maintainers:
    - name: rancher
      version: not-this
    version: 2.15.4-97fac5a-head
  - apiVersion: v2
    appVersion: v2.12.16-27a0f76-head
    created: "2026-11-02T16:08:56.1Z"
    version: 2.12.16-27a0f76-head
  - apiVersion: v2
    appVersion: v2.13.0
    created: "2026-11-03T00:00:00Z"
    version: 2.13.0
generated: "2026-11-02T16:09:00Z"
`;

const ALPHA = `apiVersion: v1
entries:
  rancher:
  - appVersion: v2.15.3-alpha1
    created: "2026-10-15T19:32:39Z"
    version: 2.15.3-alpha1
  - appVersion: v2.15.3-rc2
    created: "2026-10-20T00:00:00Z"
    version: 2.15.3-rc2
`;

test('a chart index reads as its charts, skipping nested maps', () => {
  const charts = chartEntries(LATEST);

  assert.equal(charts.length, 5);
  assert.deepEqual(charts[0], { version: '2.16.0-9456b5a-head', appVersion: 'v2.16.0-9456b5a-head', created: '2026-11-02T15:55:39.1Z' });
  assert.equal(charts[2].version, '2.15.4-97fac5a-head', 'a maintainer\'s `version` is not the chart\'s');
  assert.equal(chartEntries(ALPHA)[0].appVersion, 'v2.15.3-alpha1', 'a first field on the dash line counts');
});

test('staging offers the newest head of each line, newest line first, then prereleases', () => {
  const { default: first, versions } = stagingVersions(LATEST, ALPHA);

  assert.equal(first, 'v2.16.0-9456b5a-head', 'the newest main build, not the newest-created chart');
  assert.deepEqual(versions.map((v) => v.tag), [
    'v2.16.0-9456b5a-head', 'v2.15.4-97fac5a-head', 'v2.12.16-27a0f76-head', 'v2.15.3-rc2', 'v2.15.3-alpha1',
  ]);
  assert.match(versions[0].note, /main.*2026-11-02/);
  assert.ok(!versions.some((v) => v.tag === 'head' || v.tag === 'v2.13.0'), 'no floating tag, nothing that is not a head build');
});

test('released offers plain vX.Y.Z tags, newest first by number', () => {
  const { default: first, versions } = releasedVersions(['v2.9.10', 'v2.15.3', 'v2.15.2-hotfix-0921.1', 'v2.15.10', 'sha256-abc', 'head', 'v2.14.7']);

  assert.equal(first, 'v2.15.10');
  assert.deepEqual(versions.map((v) => v.tag), ['v2.15.10', 'v2.15.3', 'v2.14.7', 'v2.9.10']);
  assert.deepEqual(releasedVersions([]), { default: '', versions: [] });
});

test('a 401 names its token server', () => {
  assert.deepEqual(
    bearerChallenge('Bearer realm="https://stgscc.suse.com/api/registry/authorize",service="SUSE Linux Docker Registry"'),
    { realm: 'https://stgscc.suse.com/api/registry/authorize', service: 'SUSE Linux Docker Registry' },
  );
  assert.equal(bearerChallenge('Basic realm="x"'), null);
  assert.equal(bearerChallenge(''), null);
});

/** A registry with one tag that is there, behind an anonymous token. */
function registry({ tags = ['v2.16.0-9456b5a-head'], manifestStatus } = {}) {
  const calls = [];
  const fetchImpl = async(url, init = {}) => {
    calls.push({ url, init });
    const u = new URL(url);
    const reply = (status, body = {}, headers = {}) => ({
      status, ok: status < 300, headers: new Headers(headers), json: async() => body,
    });

    if (u.pathname === '/v2/') {
      return reply(401, {}, { 'www-authenticate': 'Bearer realm="https://auth.example/token",service="Reg"' });
    }
    if (u.host === 'auth.example') {
      return reply(200, { token: `T:${ u.searchParams.get('service') }:${ u.searchParams.get('scope') }` });
    }
    if (u.pathname.includes('/manifests/')) {
      const tag = decodeURIComponent(u.pathname.split('/manifests/')[1]);

      return reply(manifestStatus || (tags.includes(tag) ? 200 : 404));
    }
    if (u.pathname.endsWith('/tags/list')) {
      return u.searchParams.get('last')
        ? reply(200, { tags: ['v2.15.3'] })
        : reply(200, { tags }, { link: '</v2/rancher/rancher/tags/list?n=10000&last=x>; rel="next"' });
    }

    return reply(500);
  };

  return { fetchImpl, calls };
}

test('a tag is there or it is not, asked with an anonymous pull token', async() => {
  const { fetchImpl, calls } = registry();

  assert.equal(await imageExists('stgregistry.suse.com', 'rancher/rancher', 'v2.16.0-9456b5a-head', fetchImpl), true);
  assert.equal(await imageExists('stgregistry.suse.com', 'rancher/rancher', 'head', fetchImpl), false);

  const head = calls.find((c) => c.init.method === 'HEAD');

  assert.equal(head.init.headers.authorization, 'Bearer T:Reg:repository:rancher/rancher:pull');
  assert.match(head.init.headers.accept, /oci\.image\.index/);
});

test('a registry that will not say is not a "no"', async() => {
  const { fetchImpl } = registry({ manifestStatus: 503 });

  await assert.rejects(imageExists('stgregistry.suse.com', 'rancher/rancher', 'v2.16.0-9456b5a-head', fetchImpl), /503/);
});

test('a tag that is not a tag is not asked about', async() => {
  const { fetchImpl, calls } = registry();

  assert.equal(await imageExists('h', 'rancher/rancher', '../x', fetchImpl), false);
  assert.equal(calls.length, 0);
});

test('tags follow the registry\'s pages', async() => {
  const { fetchImpl } = registry({ tags: ['v2.16.0'] });

  assert.deepEqual(await registryTags('registry.rancher.com', 'rancher/rancher', fetchImpl), ['v2.16.0', 'v2.15.3']);
});
