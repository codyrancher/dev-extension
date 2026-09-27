#!/usr/bin/env node
// Log the browser in to the Rancher this workspace talks to, without typing a password.
//
// There is no local admin account to type here: the Rancher is a shared one that people sign
// in to with GitHub, and what this workspace has is a token for the person who made it
// (RANCHER_TOKEN in /workspace/.env). Rancher's session is a cookie carrying that token, so
// setting the cookie is the login. Set for the Rancher's own origin, for the dev server on
// localhost:8005 (an all-in-one workspace serves it there and proxies the API to the Rancher),
// and for the dev-server tool's own host when this is a leased workspace, where the server is a
// pod of its own with an address of its own. That last one is not a nicety: the cookie is
// per-origin, so without it every page an agent opens on its own dev server shows the login
// form, and the agent has to work out that it must plant the cookie itself.
//
//   node /workspace/bin/rancher-login.mjs            # both origins
//   node /workspace/bin/rancher-login.mjs --check    # say who the token is
import { chromium } from 'playwright-core';

import fs from 'node:fs';
import { cdpEndpoint } from './cdp.mjs';

// The secrets live in /workspace/.env rather than in the process environment (see
// .claude/rules/environment.md); read them from there when the shell did not.
const env = { ...process.env };

try {
  for (const line of fs.readFileSync('/workspace/.env', 'utf8').split('\n')) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line);

    if (m && !env[m[1]]) {
      env[m[1]] = m[2];
    }
  }
} catch { /* no .env: the variables have to be in the environment then */ }

const token = env.RANCHER_TOKEN || '';
const rancher = env.RANCHER_URL || env.API || '';
const cdp = await cdpEndpoint(env.CLAUDE_BROWSER_CDP);

if (!token || !rancher) {
  console.error('rancher-login: RANCHER_TOKEN and RANCHER_URL are needed; source /workspace/.env first (set -a; . /workspace/.env; set +a)');
  process.exit(2);
}

if (process.argv.includes('--check')) {
  const r = await fetch(`${ rancher }/v3/users?me=true`, { headers: { Authorization: `Bearer ${ token }` } }).catch(() => null);
  const body = r && r.ok ? await r.json() : null;

  console.log(body?.data?.[0]?.username || body?.data?.[0]?.name ? `token is ${ body.data[0].username || body.data[0].name }` : `token did not answer (${ r ? r.status : 'no response' })`);
  process.exit(0);
}

/**
 * The host a leased workspace's dev server answers on, or '' when there is not one.
 *
 * Asked of the same API the `tools` command uses, so this agrees with whatever is attached right
 * now. Quiet on every failure: an all-in-one workspace has no such tool, and a leased one with
 * no dev server attached simply has nothing extra to sign in.
 */
async function devServerHost() {
  const api = env.CLAUDE_HARNESS_API || env.HARNESS_API || '';
  const workspace = env.PROJECT_NAME || env.HARNESS_PROJECT || '';

  if (!api || !workspace) {
    return '';
  }

  try {
    const tool = await fetch(`${ api }/tools/${ workspace }/dev-server`).then((r) => r.json());

    return tool?.running && tool?.url ? new URL(tool.url).hostname : '';
  } catch {
    return '';
  }
}

const browser = await chromium.connectOverCDP(cdp);
const context = browser.contexts()[0] || await browser.newContext();
const host = new URL(rancher).host;
const served = await devServerHost();
const cookies = [];

for (const [domain, secure] of [[host.split(':')[0], true], ['localhost', true], ['localhost', false], ...(served ? [[served, true], [served, false]] : [])]) {
  cookies.push({ name: 'R_SESS', value: token, domain, path: '/', httpOnly: false, secure, sameSite: 'Lax' });
}
await context.addCookies(cookies);
console.log(`R_SESS set for ${ [host, 'localhost', served].filter(Boolean).join(', ') } - the browser is signed in as the token's user`);
await browser.close();
