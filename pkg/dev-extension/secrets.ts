// The secrets that belong to the product rather than to any workspace.
//
// This used to sit beside a list of templates, each with secrets of its own. Templates are Apps
// Plus apps now, and what an App needs is in its values - so what is left here is the one thing
// no App owns: the tokens this product uses on your behalf.
//
// They are grouped, because they are not all the same kind of thing: one group is how the
// product reaches a service as you, the other is what it needs to get a certificate for a link
// you hand to somebody else. A group is a heading inside the one card, not a card of its own -
// they are all written to the same Secret by the same Save.

export interface DevSecret {
  key: string;
  label: string;
  help: string;
  required: boolean;
  /** Made up the first time it is needed and kept, rather than typed. */
  generated?: boolean;
  /** Which group of the Tokens card it belongs to; the first group when absent. */
  group?: string;
}

export interface SecretGroup {
  id: string;
  title: string;
  help: string;
}

export const SECRET_GROUPS: SecretGroup[] = [
  {
    id:    'access',
    title: 'Access',
    help:  'How this product reaches a service as you. What a workspace needs is in its Apps Plus app\'s values.',
  },
  {
    id:    'letsencrypt',
    title: 'Let\'s Encrypt',
    help:  'A share is a link you send to somebody with no account here, so it should not open on a certificate warning. Fill this in and every share gets a real certificate for its own sslip.io name.',
  },
];

export const GLOBAL_SECRETS: DevSecret[] = [
  {
    key:      'GH_TOKEN',
    label:    'GitHub token',
    help:     'A personal access token with repo, read:user and read:project. My Work reads your issues, pull requests and board status with it.',
    required: false,
    group:    'access',
  },
  {
    key:      'RANCHER_PASSWORD',
    label:    'Rancher login password',
    help:     'The password for the local "admin" account. A workspace opens on a fresh Rancher login, and the Verify tools copy this to your clipboard so you can sign in.',
    required: false,
    group:    'access',
  },
  {
    key:      'LETSENCRYPT_EMAIL',
    label:    'Account email',
    help:     'The contact address for the ACME account; no registration needed, just an address you own. Empty means no share asks for a certificate.',
    required: false,
    group:    'letsencrypt',
  },
];
