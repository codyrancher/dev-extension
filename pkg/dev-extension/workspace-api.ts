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
const TEMPLATES_FILE = process.env.TEMPLATES_FILE || '/templates/templates.json';

function templates() {
  try {
    return JSON.parse(fs.readFileSync(TEMPLATES_FILE, 'utf8'));
  } catch {
    return {};
  }
}

/**
 * One call to the apiserver.
 *
 * The ServiceAccount's CA reaches node through NODE_EXTRA_CA_CERTS on the pod, so there is
 * nothing to configure here and nothing is skipped: an api server this cannot verify is one it
 * refuses to talk to.
 */
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
function fill(value, name, namespace, template) {
  const own = (template.sidecars || []).find((sidecar) => sidecar.providesApi);

  return String(value)
    .replace(/{{namespace}}/g, namespace)
    .replace(/{{workspace}}/g, name)
    .replace(/{{proxyPath}}/g, template.ownOrigin ? '' : \`/k8s/clusters/local/api/v1/namespaces/\${ namespace }/services/\${ template.scheme || 'http' }:\${ namespace }:\${ template.port }/proxy/\`)
    .replace(/{{ownRancher}}/g, own ? \`\${ own.scheme || 'http' }://\${ namespace }-\${ own.id }.\${ namespace }.svc\` : '');
}

async function makeWorkspace(name, templateId) {
  const all = templates();
  const template = all[templateId];

  if (!template) {
    const error = new Error(\`No template called \${ templateId }. There is \${ Object.keys(all).join(', ') || 'none published yet' }.\`);

    error.status = 400;
    throw error;
  }

  const namespace = \`dev-\${ name }\`;
  const labels = {
    'dev.rancher.io/workspace': name,
    'dev.rancher.io/template':  templateId,
  };

  await create('/api/v1/namespaces', {
    apiVersion: 'v1', kind: 'Namespace', metadata: { name: namespace, labels },
  });

  await create(\`/api/v1/namespaces/\${ namespace }/serviceaccounts\`, {
    apiVersion: 'v1', kind: 'ServiceAccount', metadata: { namespace, name: 'dev-workspace' },
  });

  await create(\`/apis/rbac.authorization.k8s.io/v1/namespaces/\${ namespace }/rolebindings\`, {
    apiVersion: 'rbac.authorization.k8s.io/v1',
    kind:       'RoleBinding',
    metadata:   { namespace, name: 'dev-workspace' },
    roleRef:    { apiGroup: 'rbac.authorization.k8s.io', kind: 'ClusterRole', name: 'edit' },
    subjects:   [{ kind: 'ServiceAccount', name: 'dev-workspace', namespace }],
  });

  // The two ConfigMaps a workspace boots from: the dev server's config, and the scripts a
  // conversation runs. Both arrive as published data rather than being built here.
  for (const [mapName, data] of Object.entries(template.configMaps || {})) {
    await create(\`/api/v1/namespaces/\${ namespace }/configmaps\`, {
      apiVersion: 'v1', kind: 'ConfigMap', metadata: { namespace, name: mapName }, data,
    });
  }

  const podLabels = { app: namespace, ...labels };

  await create(\`/apis/apps/v1/namespaces/\${ namespace }/deployments\`, {
    apiVersion: 'apps/v1',
    kind:       'Deployment',
    metadata:   { namespace, name: namespace, labels: podLabels },
    spec:       {
      replicas: 1,
      selector: { matchLabels: { app: namespace } },
      strategy: { type: 'Recreate' },
      template: {
        metadata: { labels: podLabels },
        spec:     {
          serviceAccountName: 'dev-workspace',
          containers:         [{
            name:    'workspace',
            image:   template.image,
            ...(template.command ? { command: template.command } : {}),
            ports:   [{ name: 'http', containerPort: template.port }],
            env:     Object.entries(template.env || {}).map(([key, value]) => ({
              name: key, value: fill(value, name, namespace, template),
            })),
            envFrom:      [{ secretRef: { name: 'dev-secrets', optional: true } }],
            volumeMounts: [
              ...(template.hostPath ? [{ name: 'work', mountPath: '/workspace' }] : []),
              { name: 'dev-config', mountPath: '/dev-config', readOnly: true },
              { name: 'terminal', mountPath: '/seed', readOnly: true },
            ],
          }],
          volumes: [
            ...(template.hostPath ? [{
              name: 'work', hostPath: { path: \`\${ template.hostPath }/\${ name }\`, type: 'DirectoryOrCreate' },
            }] : []),
            { name: 'dev-config', configMap: { name: 'dev-workspace-config' } },
            {
              name: 'terminal', configMap: { name: 'dev-terminal', defaultMode: 365, optional: true },
            },
          ],
        },
      },
    },
  });

  await create(\`/api/v1/namespaces/\${ namespace }/services\`, {
    apiVersion: 'v1',
    kind:       'Service',
    metadata:   { namespace, name: namespace, labels },
    spec:       {
      ...(template.ownOrigin ? { type: 'NodePort' } : {}),
      selector: { app: namespace },
      ports:    [{
        name: template.scheme || 'http', port: template.port, targetPort: 'http', protocol: 'TCP',
      }],
    },
  });

  return { name, namespace, template: templateId };
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
      return send(res, 200, {
        templates: Object.entries(templates()).map(([id, template]) => ({
          id, label: template.label, image: template.image,
        })),
      });
    }

    if (req.method === 'GET' && url.pathname === '/workspaces') {
      const list = await k8s('/api/v1/namespaces?labelSelector=dev.rancher.io/workspace');

      return send(res, 200, {
        workspaces: (list.items || []).map((namespace) => ({
          name:      namespace.metadata.labels['dev.rancher.io/workspace'],
          namespace: namespace.metadata.name,
          template:  namespace.metadata.labels['dev.rancher.io/template'] || '',
          createdAt: namespace.metadata.creationTimestamp,
        })),
      });
    }

    if (req.method === 'POST' && url.pathname === '/workspaces') {
      const body = await readBody(req);
      const problem = nameError(body.name);

      if (problem) {
        return send(res, 400, { error: problem });
      }

      return send(res, 200, await makeWorkspace(body.name, body.template || 'rancher'));
    }

    if (req.method === 'GET' && url.pathname === '/') {
      return send(res, 200, { api: 'ok', templates: Object.keys(templates()) });
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
