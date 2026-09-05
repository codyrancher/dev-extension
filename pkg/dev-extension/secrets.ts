// The secrets that belong to the product rather than to any workspace.
//
// This used to sit beside a list of templates, each with secrets of its own. Templates are Apps
// Plus apps now, and what an App needs is in its values - so what is left here is the one thing
// no App owns: how this product talks to GitHub on your behalf.

export interface DevSecret {
  key: string;
  label: string;
  help: string;
  required: boolean;
  /** Made up the first time it is needed and kept, rather than typed. */
  generated?: boolean;
}

export const GLOBAL_SECRETS: DevSecret[] = [
  {
    key:      'GH_TOKEN',
    label:    'GitHub token',
    help:     'A personal access token with repo, read:user and read:project. My Work reads your issues, pull requests and board status with it, from the browser.',
    required: false,
  },
];
