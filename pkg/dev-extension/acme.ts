// Certificates for the links you hand to somebody else.
//
// A share is a public address on a node with a public IP, served by the host cluster's ingress
// controller - which, with nothing told to it, answers with a self-signed certificate. So the
// link a reviewer opens warns them first, on a page that is asking them to sign in. This gets
// the share a real certificate instead.
//
// One setting, and it is an email address: the contact for the ACME account (Settings > Tokens).
// There is no token and no DNS provider here, because the names shares use need neither. A
// share answers at `<name>.dev-extension.<node ip>.sslip.io`, sslip.io resolves that to the
// node, the node is public, and so Let's Encrypt can do the simplest thing there is: ask for a
// file over port 80 from the name it is certifying. HTTP-01, no credentials anywhere.
//
// Where the work happens: in the share's own pod, as a sidecar running acme.sh, writing the
// certificate into a TLS Secret of the share's namespace that the Ingress names. Nothing is
// installed in the cluster for it - no cert-manager, no CRDs, no controller - because a share
// is a pod that exists for a few days and its certificate has the same lifetime as its Ingress.
// It is cleaned up when the share is, by living in the share's namespace.

import { clusterBase, devFetch, readSecretStore } from './api';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

/** What the Tokens page was given. An empty email is the normal state, and means no certificates. */
export interface AcmeConfig {
  /** The ACME account's contact address. Nothing is asked for without it. */
  email: string;
}

export const EMPTY_ACME: AcmeConfig = { email: '' };

/**
 * The longest name a certificate can be issued for.
 *
 * Let's Encrypt still puts the first name in the certificate's Common Name, and that field is
 * 64 characters. A share's name is already 38 characters of `.dev-extension.<ip>.sslip.io`, so
 * a workspace with a very long name goes over it. Worth checking before asking rather than
 * after: a refusal arrives as a validation failure minutes later, and those are rate-limited
 * much harder than issuance is.
 */
export const ACME_MAX_HOST = 64;

/** What the Tokens page holds, read the way everything else reads it. */
export async function acmeConfig(): Promise<AcmeConfig> {
  const store = await readSecretStore().catch(() => ({} as Record<string, string>));

  return { email: String(store.LETSENCRYPT_EMAIL || '').trim() };
}

/** Whether a certificate is to be asked for at all, which is the email and nothing else. */
export function acmeWanted(config: AcmeConfig): boolean {
  return !!config.email;
}

/** Why a host cannot be certified, or '' when it can. */
export function acmeRefusal(host: string, config: AcmeConfig): string {
  if (!acmeWanted(config)) {
    return 'No Let\'s Encrypt account email is set, so this share keeps the ingress controller\'s own certificate. Settings > Tokens > Let\'s Encrypt.';
  }
  if (!host) {
    return 'This share is served through this Rancher rather than on a public name, so it uses this Rancher\'s certificate.';
  }
  if (host.length > ACME_MAX_HOST) {
    return `${ host } is ${ host.length } characters and a certificate can only name ${ ACME_MAX_HOST }, so this share keeps the ingress controller's own. A shorter workspace name is the whole of the fix.`;
  }

  return '';
}

/** The TLS Secret the Ingress names, in the share's own namespace. */
export function certSecretName(namespace: string): string {
  return `${ namespace }-tls`.slice(0, 63);
}

/** What a share's certificate is, read off the Secret the sidecar writes. */
export interface CertState {
  /** none: nothing issued yet. ok: a certificate for this name. stale: one for another name. */
  state: 'none' | 'ok' | 'stale';
  /** When it expires, as the sidecar stamped it, or ''. */
  expires: string;
  /** The name it was issued for. */
  host: string;
}

/**
 * The certificate's state, from the Secret's annotations rather than its contents.
 *
 * The sidecar stamps what it issued and when it expires at the moment it writes the Secret,
 * because reading that back out of the certificate means parsing X.509 in a browser for two
 * fields that whatever wrote it already knew.
 */
export async function certState(cluster: string, namespace: string, host: string): Promise<CertState> {
  const secret: Json = await devFetch(`${ clusterBase(cluster) }/v1/secrets/${ namespace }/${ certSecretName(namespace) }`).catch(() => null);

  if (!secret?.data?.['tls.crt']) {
    return { state: 'none', expires: '', host: '' };
  }
  const annotations = secret.metadata?.annotations || {};
  const issued = String(annotations['dev.rancher.io/acme-host'] || '');

  return {
    state:   !issued || issued === host ? 'ok' : 'stale',
    expires: String(annotations['dev.rancher.io/acme-expires'] || ''),
    host:    issued,
  };
}
