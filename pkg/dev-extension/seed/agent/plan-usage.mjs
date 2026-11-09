/**
 * How much of the plan's allowance is gone this week, for the sidebar's usage bar.
 *
 * Run in the agent pod by dev-api (`/system/usage`), because the login it needs is here and nowhere
 * else: the shared Claude login the panes use, in the pane home's `.claude/.credentials.json`. The
 * token is read, used for the one request the CLI's own `/usage` makes, and never printed - what
 * comes out is the numbers alone, one JSON line on stdout.
 *
 * It does not renew an expired login. That is the CLI's job and the credentials sync's (see
 * claude-credentials.mjs); a login past its time is reported as such, and dev-api keeps the last
 * numbers it had rather than drawing an empty bar.
 *
 * Google's Antigravity is not here: its quota service answers only the Antigravity app itself,
 * and refuses a request that is not, project or not. Its CLI keeps the numbers in memory and
 * writes none of them down.
 *
 * `usageFrom` has no network and no disk, and tests/plan-usage.test.mjs holds its shapes.
 */
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

/** What the CLI's own `/usage` reads. The beta header is what lets an OAuth login ask. */
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const BETA = 'oauth-2025-04-20';

/** One window: the share of it used, 0-100, and when it starts again. Null for a window not there. */
function windowOf(w) {
  return w && typeof w.utilization === 'number' && Number.isFinite(w.utilization)
    ? { percent: Math.max(0, Math.round(w.utilization)), resetsAt: String(w.resets_at || '') }
    : null;
}

/**
 * The answer, cut down to what a bar draws.
 *
 * `week` is the plan's weekly limit across models - the one `/usage` calls "Current week (all
 * models)" - and the bar is that. The five-hour session and the per-model weekly limits come along
 * for the tooltip, where a plan has them.
 *
 * @param {any} answer what Anthropic said
 * @param {string} plan the login's subscription, e.g. `max`
 */
export function usageFrom(answer, plan = '') {
  return {
    plan:     String(plan || ''),
    week:     windowOf(answer?.seven_day),
    session:  windowOf(answer?.five_hour),
    opus:     windowOf(answer?.seven_day_opus),
    sonnet:   windowOf(answer?.seven_day_sonnet),
  };
}

async function claude(home) {
  let login;

  try {
    login = JSON.parse(fs.readFileSync(`${ home }/.claude/.credentials.json`, 'utf8')).claudeAiOauth;
  } catch {
    return { error: 'not signed in' };
  }
  if (!login?.accessToken) {
    return { error: 'not signed in' };
  }
  if (login.expiresAt && login.expiresAt < Date.now()) {
    return { error: 'the login has expired; it is renewed when a conversation next runs' };
  }
  try {
    const answer = await fetch(USAGE_URL, {
      headers: { authorization: `Bearer ${ login.accessToken }`, 'anthropic-beta': BETA },
      signal:  AbortSignal.timeout(15_000),
    });

    if (!answer.ok) {
      return { error: `Anthropic answered ${ answer.status }` };
    }

    return usageFrom(await answer.json(), login.subscriptionType);
  } catch (e) {
    return { error: `Anthropic could not be reached: ${ String(e?.message || e).slice(0, 120) }` };
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const home = process.env.HOME || '/workspace/.home';

  process.stdout.write(`${ JSON.stringify({ claude: await claude(home), at: new Date().toISOString() }) }\n`);
}
