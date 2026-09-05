/**
 * An API for making a workspace without a browser.
 *
 * Everything else in this product is done from the page, against Rancher, carrying the session of
 * the person looking at it. That is the right shape for a person and the wrong one for anything
 * automatic: a webhook, a cron, an agent that has just been asked to fix something cannot drive a
 * browser, so none of them could make a workspace to do it in.
 *
 * So this: a small HTTP service in dev-system, with a ServiceAccount of its own, that creates the
 * same objects the page creates.
 *
 *   POST /workspaces   { "name": "issue-18536", "template": "rancher" }
 *   GET  /workspaces   what exists
 *   GET  /templates    what can be asked for
 *
 * It is plain `node:24` from a ConfigMap, the same as the Insights server, for the same reason:
 * nothing to build and nothing that can be older than this file.
 *
 * What it does not duplicate is the templates. The extension publishes them (see ensureApi), so
 * what a workspace runs is still decided in templates.ts and this renders what it is given. The
 * one thing it renders itself is the shape - a namespace, an account, two ConfigMaps, a
 * Deployment and a Service - which is small enough to read in one screen and is checked against
 * the page's own version by the fact that both make workspaces the other one can open.
 */
export const WORKSPACE_API_SERVER = `// Written by the Dev extension. See pkg/dev-extension/workspace-api.ts.
import http from 'node:http';
import fs from 'node:fs';

const PORT = Number(process.env.PORT || 8080);
const ROOT = 'https://kubernetes.default.svc';
const SA = '/var/run/secrets/kubernetes.io/serviceaccount';
const TOKEN = fs.readFileSync(\`\${ SA }/token\`, 'utf8').trim();

/** Where the extension leaves the templates, so this does not carry a second copy of them. */
// Templates are Apps Plus apps, read from the cluster when asked; there is no file of them.
const APPS = '/apis/appsplus.io/v1alpha1/apps';
const INSTANCES = '/apis/appsplus.io/v1alpha1/appinstances';
const LABEL_WORKSPACE = 'dev.rancher.io/workspace';
const LABEL_APP = 'dev.rancher.io/app';
const LABEL_CLUSTER = 'dev.rancher.io/cluster';

async function apps() {
  const list = await k8s(APPS);

  return (list.items || []).map((app) => ({
    id:          app.metadata.name,
    label:       app.metadata.name,
    description: app.spec?.description || '',
    values:      app.spec?.values || {},
  }));
}

async function k8s(path, init = {}) {
  const response = await fetch(\`\${ ROOT }\${ path }\`, {
    ...init,
    headers: {
      authorization:  \`Bearer \${ TOKEN }\`,
      'content-type': 'application/json',
      ...(init.headers || {}),
    },
  });

  const text = await response.text();
  const body = text ? JSON.parse(text) : {};

  if (!response.ok) {
    const error = new Error(body.message || \`\${ response.status } from \${ path }\`);

    error.status = response.status;
    throw error;
  }

  return body;
}

/**
 * Create it, and treat "it is already there" as success.
 *
 * Every caller of this is making something that either exists or does not, and an action that
 * asks twice for the same workspace should get the same answer both times rather than a 409 it
 * has to know to ignore.
 */
async function create(path, body) {
  try {
    return await k8s(path, { method: 'POST', body: JSON.stringify(body) });
  } catch (e) {
    if (e.status === 409) {
      return null;
    }

    throw e;
  }
}

/** The same rules the page applies, because a name it refuses here is a namespace Kubernetes would. */
function nameError(name) {
  if (!name) {
    return 'A name is required.';
  }

  if (name.length > 40) {
    return 'A name has to be 40 characters or fewer.';
  }

  return /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(name)
    ? '' : 'A name can hold lowercase letters, numbers and dashes, and has to start and end with one of the first two.';
}

/** Substituted into a template's environment, the same three the extension substitutes. */
/**
 * Make a workspace: one Installation of one App.
 *
 * Only the Installation. Apps Plus renders an App's templates into a Fleet Bundle in the
 * browser, when its model is saved, and this service has no browser - so what it makes is the
 * record, labelled as a workspace, and the Dev extension renders it on its next poll of the
 * workspace list (see apps.ts, reconcileUnrendered). Until somebody has the dashboard open the
 * workspace exists and has no pod, which the list says.
 */
async function makeWorkspace(name, appId, cluster = 'local') {
  const known = await apps();

  if (!known.some((app) => app.id === appId)) {
    const error = new Error(\`No Apps Plus app called \${ appId }. There is \${ known.map((app) => app.id).join(', ') || 'none' }.\`);

    error.status = 400;
    throw error;
  }

  const namespace = \`dev-\${ name }\`;
  const created = await create(INSTANCES, {
    apiVersion: 'appsplus.io/v1alpha1',
    kind:       'AppInstance',
    metadata:   {
      name,
      labels: { [LABEL_WORKSPACE]: name, [LABEL_APP]: appId, [LABEL_CLUSTER]: cluster },
    },
    spec: {
      app:              appId,
      namespace,
      targets:          [{ clusterName: cluster }],
      values:           {},
      provisionCluster: { enabled: false },
    },
  });

  if (!created) {
    const error = new Error(\`A workspace called \${ name } already exists.\`);

    error.status = 409;
    throw error;
  }

  return {
    name, namespace, app: appId, rendered: false,
  };
}

function send(res, status, body) {
  const text = JSON.stringify(body);

  res.writeHead(status, {
    'content-type':                'application/json',
    'content-length':              Buffer.byteLength(text),
    'access-control-allow-origin': '*',
  });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';

    req.on('data', (chunk) => {
      body += chunk;

      if (body.length > 100_000) {
        reject(new Error('That is too big to be a request.'));
      }
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error('The body is not JSON.'));
      }
    });
    req.on('error', reject);
  });
}

http.createServer(async(req, res) => {
  const url = new URL(req.url, 'http://dev-api');

  try {
    if (req.method === 'GET' && url.pathname === '/templates') {
      return send(res, 200, { templates: await apps() });
    }

    if (req.method === 'GET' && url.pathname === '/workspaces') {
      const list = await k8s(\`\${ INSTANCES }?labelSelector=\${ LABEL_WORKSPACE }\`);

      return send(res, 200, {
        workspaces: (list.items || []).map((instance) => ({
          name:      instance.metadata.labels[LABEL_WORKSPACE],
          namespace: instance.spec?.namespace || \`dev-\${ instance.metadata.labels[LABEL_WORKSPACE] }\`,
          app:       instance.spec?.app || '',
          cluster:   instance.metadata.labels[LABEL_CLUSTER] || 'local',
          createdAt: instance.metadata.creationTimestamp,
        })),
      });
    }

    if (req.method === 'POST' && url.pathname === '/workspaces') {
      const body = await readBody(req);
      const problem = nameError(body.name);

      if (problem) {
        return send(res, 400, { error: problem });
      }

      return send(res, 200, await makeWorkspace(body.name, body.app || body.template || 'rancher-workspace', body.cluster || 'local'));
    }

    if (req.method === 'GET' && url.pathname === '/') {
      return send(res, 200, { api: 'ok', templates: (await apps()).map((app) => app.id) });
    }

    return send(res, 404, { error: 'No such path.' });
  } catch (e) {
    return send(res, e.status || 500, { error: e.message });
  }
}).listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(\`[dev-api] listening on :\${ PORT }\`);
});
`;
