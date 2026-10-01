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
    help:  'A share is a link you send to somebody without an account here, so it should not open on a certificate warning. '
      + 'Filled in, these get the dashboard and Storybook shares a real certificate: the name is made under your own domain '
      + 'instead of sslip.io, and the challenge is answered in your DNS - which is the only kind that works here, because a '
      + 'share runs on a node the internet cannot reach.',
  },
];

export const GLOBAL_SECRETS: DevSecret[] = [
  {
    key:      'GH_TOKEN',
    label:    'GitHub token',
    help:     'A personal access token with repo, read:user and read:project. My Work reads your issues, pull requests and board status with it, from the browser.',
    required: false,
    group:    'access',
  },
  {
    key:      'RANCHER_PASSWORD',
    label:    'Rancher login password',
    help:     'The password for the local "admin" account. A workspace\'s app opens on a fresh Rancher login, and the Verify tools copy this into your clipboard so you can sign in without hunting for it. Kept in your own per-user Secret on the local cluster, the same place as your GitHub token above.',
    required: false,
    group:    'access',
  },
  {
    key:      'LETSENCRYPT_EMAIL',
    label:    'Account email',
    help:     'The contact address for the ACME account. Let\'s Encrypt warns this address before a certificate expires, and will not issue without it.',
    required: false,
    group:    'letsencrypt',
  },
  {
    key:      'LETSENCRYPT_DOMAIN',
    label:    'Share domain',
    help:     'The domain a share\'s name is made under, such as dev.example.com - a share then answers at <name>.dev.example.com instead of its sslip.io name. '
      + 'Leave it empty to keep the sslip.io names, which cannot be certified: nothing here controls sslip.io\'s DNS.',
    required: false,
    group:    'letsencrypt',
  },
  {
    key:      'LETSENCRYPT_DNS_PROVIDER',
    label:    'DNS provider',
    help:     'Which DNS the challenge record is written in, as lego names them: namecheap, cloudflare, route53, digitalocean, gcloud and so on. The one that serves the share domain above.',
    required: false,
    group:    'letsencrypt',
  },
  {
    key:      'LETSENCRYPT_DNS_TOKEN',
    label:    'DNS API token',
    help:     'The token the provider was given, with permission to write TXT records in that domain. It is used to answer one challenge and is never sent anywhere but the provider.',
    required: false,
    group:    'letsencrypt',
  },
  {
    key:      'LETSENCRYPT_DNS_USER',
    label:    'DNS API user',
    help:     'Only for the providers whose API wants a name or account id beside the token - Namecheap wants its API user, Route 53 its access key id. Leave it empty for a provider that takes a token alone.',
    required: false,
    group:    'letsencrypt',
  },
];
