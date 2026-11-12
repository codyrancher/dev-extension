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
  /** What it is for. Not drawn on the Tokens card, whose groups say it once for all of theirs. */
  help?: string;
  required: boolean;
  /** Made up the first time it is needed and kept, rather than typed. */
  generated?: boolean;
  /** Which group of the Tokens card it belongs to; the first group when absent. */
  group?: string;
  /** A file's worth, pasted whole: a PEM certificate or key. */
  multiline?: boolean;
}

export interface SecretGroup {
  id: string;
  title: string;
  help: string;
}

export const SECRET_GROUPS: SecretGroup[] = [
  {
    id:    'services',
    title: 'Services',
    help:  'Tokens used as you. GitHub needs repo, read:user and read:project.',
  },
  {
    id:    'rancher',
    title: 'Rancher',
    help:  'The admin password new instances sign in with, and an optional SUSE registry login (stgregistry.suse.com, registry.rancher.com).',
  },
  {
    id:    'vpn',
    title: 'VPN',
    help:  'The ECM lab VPN: your login, and the profile\'s CA (ecm-ca.pem) and TLS key (ecm-tls-auth.pem) pasted whole. The one-time code is asked at login.',
  },
  {
    id:    'letsencrypt',
    title: 'Let\'s Encrypt',
    help:  'An address you own, so shares get real certificates. Empty: none.',
  },
];

export const GLOBAL_SECRETS: DevSecret[] = [
  {
    key:      'GH_TOKEN',
    label:    'GitHub token',
    required: false,
    group:    'services',
  },
  {
    key:      'JIRA_TOKEN',
    label:    'Jira personal access token',
    required: false,
    group:    'services',
  },
  {
    key:      'CONFLUENCE_TOKEN',
    label:    'Confluence personal access token',
    required: false,
    group:    'services',
  },
  {
    key:      'RANCHER_PASSWORD',
    label:    'Rancher login password',
    required: false,
    group:    'rancher',
  },
  {
    key:      'FIGMA_API_KEY',
    label:    'Figma personal access token',
    required: false,
    group:    'services',
  },
  {
    key:      'VPN_USERNAME',
    label:    'VPN username',
    required: false,
    group:    'vpn',
  },
  {
    key:      'VPN_PASSWORD',
    label:    'VPN password',
    required: false,
    group:    'vpn',
  },
  {
    key:       'VPN_CA',
    label:     'VPN CA certificate (PEM)',
    required:  false,
    group:     'vpn',
    multiline: true,
  },
  {
    key:       'VPN_TLS_AUTH',
    label:     'VPN TLS key (PEM)',
    required:  false,
    group:     'vpn',
    multiline: true,
  },
  {
    key:      'PRIME_REGISTRY_USER',
    label:    'SUSE registry username',
    required: false,
    group:    'rancher',
  },
  {
    key:      'PRIME_REGISTRY_PASSWORD',
    label:    'SUSE registry password',
    required: false,
    group:    'rancher',
  },
  {
    key:      'LETSENCRYPT_EMAIL',
    label:    'Account email',
    required: false,
    group:    'letsencrypt',
  },
];
