/**
 * Sharing a workspace's port with someone who has no Rancher session.
 *
 * Nothing here imports api.ts, deliberately: api.ts is what calls this, and a module pair that
 * imports each other is a pair whose evaluation order depends on the bundler. What this needs
 * from a caller - the namespace, the ServiceAccount - is passed in.
 *
 * The two addresses a workspace already has are both wrong for this. The service proxy is on
 * Rancher's origin and behind Rancher's session, so sending it to a colleague means giving them
 * an account and a role binding in this cluster. A node port is the opposite: open to anyone who
 * can reach the node, with nothing in front of it at all, which is fine for a dev server you are
 * looking at yourself and not fine for a link you paste into a chat.
 *
 * So sharing puts something in front: nginx, in the workspace's own namespace, with HTTP basic
 * auth and one listener per shared port, published on a node port of its own. What is shared is
 * a URL, a username and a password, and none of the three is a Rancher credential.
 *
 * The nginx config and the password file are generated here and live in a ConfigMap and a Secret
 * beside the Deployment, so what is shared is data rather than code: adding a port rewrites the
 * config and rolls the pod, and nothing about the workspace itself changes.
 */

/** One port, shared. */
export interface DevShare {
  /** The workspace port being served. */
  port: number;
  /** The port nginx listens on for it, which is what the Service publishes. */
  listen: number;
  /**
   * What the workspace speaks on that port, which is not always http.
   *
   * A workspace served at its own origin serves https on the shell's own development
   * certificate, and an nginx told to proxy_pass http:// to it answers 502 with `SSL alert` in
   * its log. nginx does not verify an upstream certificate unless it is told to, so the
   * self-signed one needs nothing else.
   */
  scheme: string;
  username: string;
  password: string;
}

/**
 * Where nginx starts numbering its listeners.
 *
 * Not the workspace's own port numbers: two shared ports could be 80 and 8080 in the workspace
 * and nginx needs a listener for each, so the two numbering schemes have to be independent or
 * they collide the first time somebody shares a port this proxy is already using.
 */
const FIRST_LISTEN = 9000;

/** nginx's own alpine image, which is what the closet and half of Kubernetes already pull. */
const IMAGE = 'nginx:alpine';

const NAME_SUFFIX = 'share';

export function shareName(namespace: string): string {
  return `${ namespace }-${ NAME_SUFFIX }`;
}

/**
 * The password file nginx reads.
 *
 * `{PLAIN}` rather than a hash, and that is a considered choice rather than laziness: the file
 * lives in a Kubernetes Secret, so anything that can read the hash can read the Secret, and a
 * hash would only stop the person sharing the port from being able to tell somebody what the
 * password is. It is a share link's password, generated per port, not an account.
 */
export function htpasswd(shares: DevShare[]): string {
  return shares.map((share) => `${ share.username }:{PLAIN}${ share.password }`).join('\n');
}

/**
 * The nginx config for the shared ports.
 *
 * One server block per share, each on its own listener, each proxying to the workspace's own
 * Service by name. `proxy_set_header Host` carries the address the browser used, because a dev
 * server that builds absolute URLs would otherwise hand back the in-cluster name and send the
 * person somewhere they cannot reach.
 */
export function nginxConf(namespace: string, realm: string, shares: DevShare[]): string {
  const servers = shares.map((share) => `
  server {
    listen ${ share.listen };

    auth_basic           "${ realm }";
    auth_basic_user_file /etc/nginx/share/htpasswd;

    location / {
      proxy_pass ${ share.scheme || 'http' }://${ namespace }.${ namespace }.svc:${ share.port };

      proxy_set_header Host              $http_host;
      proxy_set_header X-Real-IP         $remote_addr;
      proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
      proxy_set_header X-Forwarded-Proto $scheme;

      # A dev server's hot reload is a websocket, and a proxy that does not say so turns it into
      # a page that loads once and never updates again.
      proxy_http_version 1.1;
      proxy_set_header   Upgrade    $http_upgrade;
      proxy_set_header   Connection "upgrade";

      # Long enough for a websocket that is idle between edits, rather than nginx's minute.
      proxy_read_timeout 3600s;
    }
  }`).join('\n');

  return `# Written by the Dev extension. See pkg/dev-extension/share.ts.
worker_processes 1;
events { worker_connections 1024; }

http {
  include       /etc/nginx/mime.types;
  default_type  application/octet-stream;
  sendfile      on;
${ servers }
}
`;
}

/** The next free listener, so an added share does not take one an existing share is using. */
export function nextListen(shares: DevShare[]): number {
  const taken = new Set(shares.map((share) => share.listen));
  let listen = FIRST_LISTEN;

  while (taken.has(listen)) {
    listen += 1;
  }

  return listen;
}

/**
 * A password nobody chose, made where it is used.
 *
 * The alphabet leaves out the characters that a person reading one out loud gets wrong, which
 * matters for a value whose whole purpose is being passed to somebody else.
 */
const ALPHABET = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function generatedPassword(length = 16): string {
  const bytes = new Uint8Array(length);

  window.crypto.getRandomValues(bytes);

  return [...bytes].map((byte) => ALPHABET[byte % ALPHABET.length]).join('');
}

/** The pod that serves the shares. Rewritten whenever the shares change. */
export function sharePodSpec(namespace: string, serviceAccount: string): Record<string, unknown> {
  const name = shareName(namespace);

  return {
    serviceAccountName: serviceAccount,
    containers:         [{
      name:  NAME_SUFFIX,
      image: IMAGE,
      // The image's own entrypoint, with the generated config in place of the shipped one.
      volumeMounts: [
        {
          name: 'conf', mountPath: '/etc/nginx/nginx.conf', subPath: 'nginx.conf', readOnly: true
        },
        { name: 'auth', mountPath: '/etc/nginx/share', readOnly: true },
      ],
    }],
    volumes: [
      { name: 'conf', configMap: { name } },
      // A Secret rather than the same ConfigMap: the config is a thing to read when something is
      // wrong, and the passwords are not.
      { name: 'auth', secret: { secretName: name } },
    ],
  };
}
