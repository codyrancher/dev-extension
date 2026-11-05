// Who every new Rancher instance makes an administrator, besides the GitHub user its App names.
//
// The list is a ConfigMap on this Rancher, dev-system/dev-instance-admins, so it is changed by
// editing that rather than by releasing this extension: one key per GitHub login, whose value is
// that account's numeric id (https://api.github.com/users/<login> says what it is). The id is
// what Rancher's principal is made of; the login is only there so a person can read the list.
//
// createRancherInstance reads it at create time, the way it reads the cloud credentials, so an
// instance keeps the list it was made with.

export const INSTANCE_ADMINS_CONFIGMAP = 'dev-instance-admins';

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32(bytes) {
  let out = '';
  let bits = 0;
  let value = 0;

  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }

  return bits > 0 ? out + BASE32[(value << (5 - bits)) & 31] : out;
}

/**
 * The name Rancher gives the user a GitHub login creates: `u-` + base32(sha256(principal))[:10],
 * lowercased. Writing the User under that name is what makes the first login find it rather than
 * make a second one.
 */
export async function rancherUserName(githubId) {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(`github_user://${ githubId }`));

  return `u-${ base32(new Uint8Array(digest)).slice(0, 10).toLowerCase() }`;
}

/**
 * The rancher-single App's `adminPrincipals` and `adminUsers` values for the accounts in the
 * ConfigMap's data, indented for where 70-admins.yaml puts them: allow-list entries, and a User
 * and an admin GlobalRoleBinding for each. `except` is ids already covered (the App's own
 * githubUserId). An entry whose login or id is not one GitHub could have is skipped. Nothing to
 * add is `{}`, which leaves the App's defaults in place.
 */
export async function instanceAdminValues(data, except = []) {
  const seen = new Set(except.map(String));
  const admins = [];

  for (const [login, value] of Object.entries(data || {})) {
    const id = String(value).trim();

    if (!/^[A-Za-z0-9-]{1,39}$/.test(login) || !/^\d+$/.test(id) || seen.has(id)) {
      continue;
    }
    seen.add(id);
    admins.push({ login, id, user: await rancherUserName(id) });
  }

  if (!admins.length) {
    return {};
  }

  return {
    adminPrincipals: admins.map(({ login, id }) => `      - github_user://${ id } # ${ login }`).join('\n'),
    adminUsers:      admins.map(({ login, id, user }) => [
      '    ---',
      '    apiVersion: management.cattle.io/v3',
      '    kind: User',
      '    metadata:',
      `      name: ${ user }`,
      `    displayName: ${ login }`,
      '    principalIds:',
      `      - github_user://${ id }`,
      `      - local://${ user }`,
      '    ---',
      '    apiVersion: management.cattle.io/v3',
      '    kind: GlobalRoleBinding',
      '    metadata:',
      `      name: grb-admin-${ user }`,
      '    globalRoleName: admin',
      `    userName: ${ user }`,
    ].join('\n')).join('\n'),
  };
}
