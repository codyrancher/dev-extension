/**
 * The Chromium extension the workspace's browser sidecar runs with.
 *
 * The same one the harness loads into its own browser: a Quick Login bar on Rancher's login page,
 * and a command menu for the things that are several clicks otherwise. It is here rather than in
 * an image because it has to be built per workspace - the accounts it offers are that workspace's
 * own Rancher's, and the pages it runs on are that workspace's two addresses.
 *
 * The files are the harness's, copied verbatim, with two substitutions:
 *
 *   {{matches}}  the pages the content scripts run on
 *   {{creds}}    the accounts the Quick Login bar offers, as a JSON array
 *
 * The passwords are in there in plain text, which is what a content script needs and what the
 * harness's own copy does. They travel in a Secret rather than a ConfigMap and they are the
 * generated passwords of a Rancher that answers inside one namespace, so the exposure is the same
 * as the Secret they come from - but it is worth knowing that they are readable by anything that
 * can read that Secret, which includes the workspace's own conversations.
 */
export const BROWSER_EXTENSION_FILES: Record<string, string> = {
  "manifest.json": `{
  "manifest_version": 3,
  "name": "Dev workspace helper",
  "version": "1.0",
  "content_scripts": [
    {
      "matches": [
        "{{matches}}"
      ],
      "js": [
        "autofill.js",
        "command-menu.js"
      ],
      "css": [
        "styles.css",
        "command-menu.css"
      ],
      "run_at": "document_idle"
    }
  ]
}
`,

  "autofill.js": `// Add user/password pairs here
const CREDS = {{creds}};

let bar = null;

function createBar() {
  if (bar) return bar;

  bar = document.createElement('div');
  bar.id = 'autofill-bar';

  const label = document.createElement('span');
  label.textContent = 'Quick Login:';
  bar.appendChild(label);

  const select = document.createElement('select');
  select.id = 'autofill-select';

  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = 'Select account\\u2026';
  select.appendChild(placeholder);

  CREDS.forEach((cred, i) => {
    const opt = document.createElement('option');
    opt.value = i;
    opt.textContent = cred.label + ' (' + cred.username + ')';
    select.appendChild(opt);
  });

  select.addEventListener('change', () => {
    if (select.value === '') return;
    const cred = CREDS[select.value];
    fillForm(cred.username, cred.password);
    bar.classList.remove('visible');
    select.value = '';
  });

  bar.appendChild(select);

  const closeBtn = document.createElement('button');
  closeBtn.className = 'close-btn';
  closeBtn.textContent = '\\u00d7';
  closeBtn.addEventListener('click', () => bar.classList.remove('visible'));
  bar.appendChild(closeBtn);

  document.body.appendChild(bar);
  return bar;
}

function fillForm(username, password) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  const u = document.querySelector('input[name="username"], input[type="text"]');
  const p = document.querySelector('input[type="password"]');

  if (u) {
    setter.call(u, username);
    u.dispatchEvent(new Event('input', { bubbles: true }));
  }
  if (p) {
    setter.call(p, password);
    p.dispatchEvent(new Event('input', { bubbles: true }));
  }
}

function isLoginPage() {
  return location.pathname === '/auth/login' ||
    location.pathname.startsWith('/dashboard/auth/login') ||
    !!document.querySelector('form.login');
}

function attachListeners() {
  if (!isLoginPage()) return;
  const inputs = document.querySelectorAll(
    'input[name="username"], input[type="text"], input[type="password"]'
  );
  inputs.forEach(el => {
    if (el.dataset.autofillBound) return;
    el.dataset.autofillBound = '1';
    el.addEventListener('focus', () => {
      createBar();
      bar.classList.add('visible');
    });
  });
}

attachListeners();
new MutationObserver(attachListeners).observe(document.body, {
  childList: true,
  subtree: true,
});
`,

  "styles.css": `#autofill-bar {
  position: fixed;
  bottom: 0;
  left: 0;
  right: 0;
  background: #1b1c21;
  border-top: 1px solid #4a4b52;
  padding: 8px 16px;
  display: flex;
  align-items: center;
  z-index: 999999;
  font-size: 13px;
  color: #ccc;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  transform: translateY(100%);
  transition: transform 0.2s ease;
}

#autofill-bar.visible {
  transform: translateY(0);
}

#autofill-bar span {
  margin-right: 8px;
  white-space: nowrap;
}

#autofill-select {
  background: #2b2c31;
  color: #eee;
  border: 1px solid #4a4b52;
  border-radius: 4px;
  padding: 4px 8px;
  font-size: 13px;
  cursor: pointer;
  min-width: 180px;
}

#autofill-select:hover {
  border-color: #6a6b72;
}

#autofill-bar .close-btn {
  margin-left: auto;
  background: none;
  border: none;
  color: #888;
  font-size: 16px;
  cursor: pointer;
  padding: 0 4px;
}

#autofill-bar .close-btn:hover {
  color: #eee;
}
`,

  "command-menu.js": `// Command registry — add new commands here
const COMMANDS = [
  {
    id: 'create-ec2-cluster',
    icon: '\\u2601\\uFE0F',
    label: 'Create EC2 Cluster',
    description: 'Single-node RKE2 cluster on EC2 (c5d.xlarge, us-west-2, Canal)',
    execute: createEc2Cluster,
  },
  {
    id: 'create-appco-repo',
    icon: '\\ud83d\\udce6',
    label: 'Create AppCo Chart Repository',
    description: 'Add OCI chart repository for oci://dp.apps.rancher.io/charts',
    execute: createAppCoRepo,
    show: function() { return window.location.pathname.includes('/explorer'); },
  },
];

// --- API helper ---

const API_BASE = window.location.origin;

function getCsrfToken() {
  var match = document.cookie.match(/(?:^|;\\s*)CSRF=([^;]*)/);
  return match ? decodeURIComponent(match[1]) : 'CSRF';
}

async function rancherApi(method, path, body) {
  const opts = {
    method,
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'X-Api-Csrf': getCsrfToken(),
    },
    credentials: 'include',
  };
  if (body) opts.body = JSON.stringify(body);

  const resp = await fetch(API_BASE + path, opts);
  if (!resp.ok) {
    let message;
    try {
      const json = await resp.json();
      message = json.message || json.error || resp.statusText;
    } catch {
      message = resp.statusText;
    }
    throw new Error(method + ' ' + path + ' failed (' + resp.status + '): ' + message);
  }
  return resp.json();
}

// --- EC2 cluster creation ---

async function createEc2Cluster(setStatus) {
  var suffix = Math.random().toString(36).substring(2, 6);
  var clusterName = 'cjackson-' + suffix;
  var ns = 'fleet-default';

  // 1. Find AWS cloud credential
  setStatus('pending', 'Finding AWS credential...');
  var credsResp = await rancherApi('GET', '/v3/cloudcredentials');
  var awsCred = credsResp.data.find(function (c) {
    return c.amazonec2credentialConfig || c.name === 'aws-credential';
  });
  if (!awsCred) throw new Error('No AWS cloud credential found. Create one in Cluster Management > Cloud Credentials first.');

  // 2. Create machine config
  setStatus('pending', 'Creating machine config...');
  var machineConfigName = clusterName + '-machine';
  await rancherApi('POST', '/v1/rke-machine-config.cattle.io.amazonec2configs', {
    metadata: {
      namespace: ns,
      name: machineConfigName,
    },
    region: 'us-west-2',
    zone: 'a',
    instanceType: 'c5d.xlarge',
    rootSize: '50',
    securityGroup: ['default', 'rancher-nodes'],
    securityGroupReadonly: true,
    subnetId: 'subnet-0c97a9f441ca3c895',
    vpcId: 'vpc-0c618e3a2ec9df47b',
  });

  // 3. Create RKE2 cluster with machine pool
  setStatus('pending', 'Creating cluster "' + clusterName + '"...');
  await rancherApi('POST', '/v1/provisioning.cattle.io.clusters', {
    type: 'provisioning.cattle.io.cluster',
    metadata: {
      namespace: ns,
      name: clusterName,
    },
    spec: {
      cloudCredentialSecretName: awsCred.id,
      kubernetesVersion: 'v1.34.4+rke2r1',
      defaultPodSecurityAdmissionConfigurationTemplateName: '',
      rkeConfig: {
        chartValues: {},
        machineGlobalConfig: {
          cni: 'canal',
        },
        machinePools: [
          {
            name: 'pool1',
            controlPlaneRole: true,
            etcdRole: true,
            workerRole: true,
            quantity: 1,
            machineConfigRef: {
              kind: 'Amazonec2Config',
              name: machineConfigName,
            },
          },
        ],
      },
    },
  });

  setStatus('success', 'Cluster "' + clusterName + '" creation initiated!');
}

// --- Cluster helpers ---

function getClusterFromUrl() {
  var match = window.location.pathname.match(/\\/c\\/([^/]+)\\//);
  return match ? match[1] : 'local';
}

function clusterApiPrefix(clusterId) {
  return clusterId === 'local' ? '' : '/k8s/clusters/' + clusterId;
}

// --- AppCo chart repository creation ---

async function createAppCoRepo(setStatus) {
  var email = 'cjackson@suse.com';
  var token = 'aXducXNvb3R1am9hZmpmYXZnYmppdXppY2ZkcW5yc2R3d21rdmlraXdoaXN5c2hqY2RjY25ib3Nsb3Vyc3NhdA==';

  if (!email || !token) {
    throw new Error('AppCo email and token not configured. Set them in portal settings.');
  }

  var clusterId = getClusterFromUrl();
  var apiPrefix = clusterApiPrefix(clusterId);
  var secretName = 'appco-auth';
  var repoName = 'appco';
  var secretNs = 'cattle-system';

  // 1. Create auth secret
  setStatus('pending', 'Creating AppCo auth secret...');
  await rancherApi('POST', apiPrefix + '/v1/secrets', {
    type: 'kubernetes.io/basic-auth',
    metadata: {
      name: secretName,
      namespace: secretNs,
    },
    data: {
      username: btoa(email),
      password: btoa(token),
    },
  });

  // 2. Create OCI chart repository
  setStatus('pending', 'Creating AppCo chart repository...');
  await rancherApi('POST', apiPrefix + '/v1/catalog.cattle.io.clusterrepos', {
    type: 'catalog.cattle.io.clusterrepo',
    metadata: {
      name: repoName,
    },
    spec: {
      url: 'oci://dp.apps.rancher.io/charts',
      clientSecret: {
        name: secretName,
        namespace: secretNs,
      },
    },
  });

  setStatus('success', 'AppCo chart repository created!');
}

// --- Menu UI ---

var menu = null;
var executing = false;

function createMenu() {
  if (menu) return menu;

  menu = document.createElement('div');
  menu.id = 'command-menu';

  // Header
  var header = document.createElement('div');
  header.className = 'cm-header';

  var title = document.createElement('span');
  title.className = 'cm-title';
  title.textContent = 'Commands';
  header.appendChild(title);

  var hint = document.createElement('span');
  hint.className = 'cm-hint';
  hint.textContent = 'Ctrl+M to toggle \\u00b7 Esc to close';
  header.appendChild(hint);

  var closeBtn = document.createElement('button');
  closeBtn.className = 'cm-close';
  closeBtn.textContent = '\\u00d7';
  closeBtn.addEventListener('click', function () { hideMenu(); });
  header.appendChild(closeBtn);

  menu.appendChild(header);

  // Command items
  var items = document.createElement('div');
  items.className = 'cm-items';

  COMMANDS.forEach(function (cmd) {
    var item = document.createElement('div');
    item.className = 'cm-item';

    var icon = document.createElement('span');
    icon.className = 'cm-icon';
    icon.textContent = cmd.icon;
    item.appendChild(icon);

    var textCol = document.createElement('div');
    textCol.className = 'cm-text';

    var label = document.createElement('span');
    label.className = 'cm-label';
    label.textContent = cmd.label;
    textCol.appendChild(label);

    var desc = document.createElement('span');
    desc.className = 'cm-desc';
    desc.textContent = cmd.description;
    textCol.appendChild(desc);

    item.setAttribute('data-cmd-id', cmd.id);
    item.appendChild(textCol);
    item.addEventListener('click', function () { executeCommand(cmd); });
    items.appendChild(item);
  });

  menu.appendChild(items);

  // Status area
  var status = document.createElement('div');
  status.className = 'cm-status';
  status.id = 'cm-status';
  status.style.display = 'none';
  menu.appendChild(status);

  document.body.appendChild(menu);
  return menu;
}

function updateCommandVisibility() {
  if (!menu) return;
  COMMANDS.forEach(function (cmd) {
    var item = menu.querySelector('[data-cmd-id="' + cmd.id + '"]');
    if (!item) return;
    item.style.display = (cmd.show ? cmd.show() : true) ? '' : 'none';
  });
}

function showMenu() {
  createMenu();
  updateCommandVisibility();
  menu.classList.add('visible');
}

function hideMenu() {
  if (menu) menu.classList.remove('visible');
}

function toggleMenu() {
  createMenu();
  menu.classList.contains('visible') ? hideMenu() : showMenu();
}

async function executeCommand(cmd) {
  if (executing) return;
  executing = true;

  var statusEl = document.getElementById('cm-status');
  statusEl.style.display = 'block';
  statusEl.className = 'cm-status';

  function setStatus(state, message) {
    statusEl.textContent = message;
    statusEl.className = 'cm-status ' + state;
  }

  try {
    await cmd.execute(setStatus);
  } catch (err) {
    setStatus('error', 'Error: ' + err.message);
  } finally {
    executing = false;
  }
}

// --- Keyboard listener ---

document.addEventListener('keydown', function (e) {
  if (e.ctrlKey && e.key === 'm') {
    e.preventDefault();
    toggleMenu();
  }
  if (e.key === 'Escape' && menu && menu.classList.contains('visible')) {
    e.preventDefault();
    hideMenu();
  }
});
`,

  "command-menu.css": `#command-menu {
  position: fixed;
  bottom: 0;
  left: 0;
  right: 0;
  background: #1b1c21;
  border-top: 1px solid #4a4b52;
  z-index: 999999;
  font-size: 13px;
  color: #ccc;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  transform: translateY(100%);
  transition: transform 0.2s ease;
  max-height: 350px;
  display: flex;
  flex-direction: column;
}

#command-menu.visible {
  transform: translateY(0);
}

#command-menu .cm-header {
  display: flex;
  align-items: center;
  padding: 8px 16px;
  border-bottom: 1px solid #333;
}

#command-menu .cm-title {
  font-weight: 600;
  color: #eee;
  margin-right: 12px;
}

#command-menu .cm-hint {
  color: #666;
  font-size: 11px;
}

#command-menu .cm-close {
  margin-left: auto;
  background: none;
  border: none;
  color: #888;
  font-size: 16px;
  cursor: pointer;
  padding: 0 4px;
}

#command-menu .cm-close:hover {
  color: #eee;
}

#command-menu .cm-items {
  overflow-y: auto;
  flex: 1;
}

#command-menu .cm-item {
  display: flex;
  align-items: center;
  padding: 10px 16px;
  cursor: pointer;
  transition: background 0.1s;
}

#command-menu .cm-item:hover {
  background: #2b2c31;
}

#command-menu .cm-icon {
  font-size: 18px;
  margin-right: 12px;
  width: 24px;
  text-align: center;
}

#command-menu .cm-text {
  display: flex;
  flex-direction: column;
}

#command-menu .cm-label {
  color: #eee;
  font-weight: 500;
}

#command-menu .cm-desc {
  color: #888;
  font-size: 11px;
  margin-top: 2px;
}

#command-menu .cm-status {
  padding: 8px 16px;
  border-top: 1px solid #333;
  font-size: 12px;
}

#command-menu .cm-status.pending {
  color: #f0c674;
}

#command-menu .cm-status.success {
  color: #6abf69;
}

#command-menu .cm-status.error {
  color: #e06c75;
}
`,

};
