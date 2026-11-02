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
    help:  'Personal access tokens for what My Work and the agents read as you. GitHub needs repo, read:user and read:project. jira.suse.com and confluence.suse.com are Server, so a token from your profile\'s Personal Access Tokens page is a bearer token, and dev-api makes those calls itself so neither token reaches a workspace. Figma needs file content read, for an agent reviewing a design.',
  },
  {
    id:    'rancher',
    title: 'Rancher',
    help:  'What a Rancher instance signs in and pulls with: the local admin password a workspace\'s fresh login and the Verify tools use, and your SUSE Customer Center login, which Prime images need from stgregistry.suse.com or registry.rancher.com. The registry login becomes the instance\'s pull Secret at create time.',
  },
  {
    id:    'letsencrypt',
    title: 'Let\'s Encrypt',
    help:  'A share is a link you send to somebody with no account here, so it should not open on a certificate warning. An address you own gets every share a real certificate for its own sslip.io name; empty means no share asks for one.',
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
