// A way into a lab this cluster cannot route to: OpenVPN in a pod, and a proxy in front of it.
//
// Harvester is tested against shared machines in the SUSE ECM lab - 10.115.252.105 and its
// neighbours - and nothing here can reach them. The VPN that can is an OpenVPN profile on
// somebody's desktop, which is the wrong place for it: the things that need the lab are a
// dashboard build, a dev server and an agent's curl, and every one of those runs in a pod.
//
// WHY A PROXY AND NOT A ROUTE. OpenVPN puts its routes in the network namespace it runs in, and
// a pod's namespace is its own - so a VPN pod's routes are no use to the pod next door. Giving
// every pod the lab would mean routing 10.115.0.0/16 on each node through this one, which is a
// node-level change on a cluster that also runs Rancher, and a mistake there takes the cluster
// with it. A proxy needs none of that: the proxy process sits INSIDE the VPN pod, so it has the
// routes, and everything else reaches it as an ordinary Service.
//
// HTTP CONNECT rather than SOCKS, because the clients are already arranged for it: curl, kubectl,
// node and the dashboard's dev server all read `HTTPS_PROXY` from the environment, so a workspace
// that has the variable set reaches the lab with nothing else changed and no code that knows about
// a VPN. For the few things that cannot be told about a proxy there are four fixed forwards,
// which are plain TCP and need nothing of the client at all.
//
// WHAT IS NOT HERE. The profile and its credentials. They are a Secret the person makes once
// (see VPN_SECRET and the Settings page's instructions); this App names it and mounts it, and the
// values carry only what is not secret - the server's address, the cipher, the routes. A
// credential in an App's values is a credential in every Fleet bundle rendered from it.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

/** The App, and the Secret it expects beside it. */
export const VPN_APP = 'lab-vpn';

/**
 * The Secret holding the profile: `ca.pem`, `ta.pem`, and `auth.txt` (username then password,
 * one per line, which is what OpenVPN's --auth-user-pass file is).
 *
 * In the workspace's own namespace rather than dev-system, so a lab connection belongs to the
 * workspace that asked for it and goes when it does. One per connection, named for the App's
 * installation, so two labs can be reached at once.
 */
export const VPN_SECRET = 'lab-vpn-profile';

/**
 * What a person has to put in that Secret, said once, here, so the Settings page and the agents'
 * notes cannot drift from what the pod actually mounts.
 */
export const VPN_SECRET_HELP = [
  `kubectl create secret generic ${ VPN_SECRET } -n <the workspace's namespace> \\`,
  '  --from-file=ca.pem=$HOME/.cert/nm-openvpn/ecm-ca.pem \\',
  '  --from-file=ta.pem=$HOME/.cert/nm-openvpn/ecm-tls-auth.pem \\',
  '  --from-file=auth.txt=<a file holding your username on one line and your password on the next>',
].join('\n');

/**
 * The script the pod runs: bring the tunnel up, then serve a proxy through it.
 *
 * openvpn and tinyproxy are installed at start rather than baked into an image, which is what
 * every other pod in this product does - there is no registry of ours to push to, and an
 * `apk add` of two small packages costs a few seconds once per pod.
 *
 * `--auth-nocache` because the credentials are read from the mounted file and there is no reason
 * for them to be in the process's memory after that; `--pull-filter ignore redirect-gateway`
 * because the lab's server pushes a default route and this pod still has to answer its own
 * Service traffic - taking the default route would strand the proxy the moment it came up, which
 * is the classic way a VPN sidecar appears to work and then does not.
 */
const VPN_SCRIPT = [
  '#!/bin/sh',
  'set -eu',
  'apk add --no-cache openvpn tinyproxy >/dev/null 2>&1 || { echo "could not install openvpn/tinyproxy"; exit 1; }',
  '',
  '# The profile, from the Secret. A missing one is said out loud rather than left as a tunnel',
  '# that never comes up for a reason nobody can see.',
  'for f in ca.pem ta.pem auth.txt; do',
  '  [ -s "/profile/$f" ] || { echo "the VPN profile Secret has no $f - see VPN_SECRET_HELP"; exit 1; }',
  'done',
  '',
  'cat > /tmp/vpn.conf <<EOF',
  'client',
  'dev tun',
  'proto ${proto}',
  'remote ${remote} ${port}',
  'resolv-retry infinite',
  'nobind',
  'persist-key',
  'persist-tun',
  'remote-cert-tls server',
  'auth ${auth}',
  'tls-auth /profile/ta.pem ${taDir}',
  'ca /profile/ca.pem',
  'auth-user-pass /profile/auth.txt',
  'auth-nocache',
  'verb 3',
  '# The lab, and nothing else: the server pushes a default route, and a pod that takes it stops',
  '# answering the Service traffic that is the whole point of it.',
  'pull-filter ignore "redirect-gateway"',
  'pull-filter ignore "dhcp-option DNS"',
  'EOF',
  '',
  '# The proxy, through whatever the tunnel turns out to route. Bound to every interface because',
  '# the only way in is this pod\'s Service, and the Service is the only thing that can reach it.',
  'cat > /tmp/tinyproxy.conf <<EOF',
  'Port ${proxyPort}',
  'Listen 0.0.0.0',
  'Timeout 600',
  'MaxClients 100',
  'StartServers 2',
  'LogLevel Warning',
  '# CONNECT to anything in the lab, on the two ports a Harvester or a Rancher answers on.',
  'ConnectPort 443',
  'ConnectPort 6443',
  'ConnectPort 80',
  'Allow 10.0.0.0/8',
  'Allow 172.16.0.0/12',
  'Allow 192.168.0.0/16',
  'EOF',
  '',
  'openvpn --config /tmp/vpn.conf --daemon --log /tmp/openvpn.log',
  '',
  '# Up means a tun device with an address on it. Waited for, because tinyproxy started first',
  '# would answer every CONNECT with "no route" for as long as the handshake takes.',
  'n=0',
  'until ip -4 addr show dev tun0 2>/dev/null | grep -q "inet "; do',
  '  n=$((n + 1))',
  '  [ "$n" -gt 60 ] && { echo "the tunnel did not come up:"; tail -20 /tmp/openvpn.log; exit 1; }',
  '  sleep 2',
  'done',
  'echo "tunnel up: $(ip -4 -o addr show dev tun0 | awk "{print \\$4}")"',
  'ip route | grep -E "^10\\." || true',
  '',
  '# The fixed forwards, for a client that cannot be told about a proxy. Four slots rather than a',
  '# list, because Apps Plus renders a bundle by substituting value names and has no loops -',
  '# so the number of them is fixed here and a slot set to `none` simply starts nothing.',
  'forward() { [ "$2" = none ] && return 0; echo "forwarding :$1 -> $2"; socat TCP-LISTEN:$1,fork,reuseaddr TCP:$2 & }',
  'apk add --no-cache socat >/dev/null 2>&1 || true',
  'forward 9001 "${forward1}"',
  'forward 9002 "${forward2}"',
  'forward 9003 "${forward3}"',
  'forward 9004 "${forward4}"',
  '',
  '# The tunnel is the thing worth dying for: if openvpn goes, this pod should go with it so the',
  '# Deployment replaces it, rather than serving a proxy that routes to nothing.',
  'exec tinyproxy -d -c /tmp/tinyproxy.conf',
].join('\n');

/**
 * A lab reachable from this cluster, as an App.
 *
 * Installed per workspace like everything else here, so the lab belongs to the work that needs
 * it: a Harvester change gets a connection while it is being tested and gives it back with the
 * workspace. The values carry the server and the forwards; the profile is a Secret (VPN_SECRET).
 */
export function labVpnApp(): Json {
  return {
    apiVersion: 'appsplus.io/v1alpha1',
    kind:       'App',
    metadata:   { name: VPN_APP },
    spec:       {
      description: 'An OpenVPN connection into a lab this cluster cannot route to - the SUSE ECM lab and its Harvester machines - with an HTTP CONNECT proxy in front of it. Everything in the cluster reaches the lab through the proxy by setting HTTPS_PROXY; four plain TCP forwards are there for clients that cannot be told about a proxy. The profile and the credentials are a Secret you make once; nothing secret is in these values.',
      values:      {
        // The ecm profile's own server, which is not a secret: it is in every copy of the
        // profile and in the wiki page that hands the profile out.
        remote:    '91.193.113.211',
        port:      '1194',
        // udp4 is what the profile prefers; it also lists a tcp4 remote, which is the one to try
        // on a network that drops UDP.
        proto:     'udp4',
        auth:      'SHA256',
        taDir:     '1',
        proxyPort: '8888',
        // `<ip>:<port>`, or none. The three LAB machines reserved for UI development and the
        // ECM Rancher, which is what the wiki's table lists.
        forward1:  '10.115.252.105:443',
        forward2:  '10.115.252.118:443',
        forward3:  '10.115.252.82:443',
        forward4:  '10.115.2.2:443',
      },
      valueLabels: {
        remote:    'The VPN server\'s address, from the profile (`remote` in the .ovpn)',
        port:      'Its port',
        proto:     'udp4, or tcp4 on a network that drops UDP',
        auth:      'The profile\'s `auth` digest',
        taDir:     'The profile\'s `key-direction` / `ta` direction',
        proxyPort: 'Port the HTTP CONNECT proxy listens on',
        forward1:  'A plain TCP forward on :9001, as <ip>:<port>; none for nothing',
        forward2:  'A plain TCP forward on :9002, as <ip>:<port>; none for nothing',
        forward3:  'A plain TCP forward on :9003, as <ip>:<port>; none for nothing',
        forward4:  'A plain TCP forward on :9004, as <ip>:<port>; none for nothing',
      },
      templates: [
        {
          name:    'namespace.yaml',
          content: `apiVersion: v1
kind: Namespace
metadata:
  name: \${namespace}
  labels:
    dev.rancher.io/app: \${app}
`,
        },
        {
          name:    'script.yaml',
          content: `# The pod's script, as a ConfigMap, so a change to it rolls the pod rather than being baked
# into an image nobody can see into.
apiVersion: v1
kind: ConfigMap
metadata:
  namespace: \${namespace}
  name: \${install}-vpn
data:
  run.sh: |
${ VPN_SCRIPT.split('\n').map((line) => `    ${ line }`).join('\n') }
`,
        },
        {
          name:    'deployment.yaml',
          content: `apiVersion: apps/v1
kind: Deployment
metadata:
  namespace: \${namespace}
  name: \${install}-vpn
  labels:
    app: \${install}-vpn
spec:
  replicas: 1
  selector:
    matchLabels:
      app: \${install}-vpn
  # One tunnel at a time. A rollout that brought a second pod up first would hold two sessions
  # against a server that may well allow one, and the new one would be refused - so the old one
  # goes before the new one starts.
  strategy:
    type: Recreate
  template:
    metadata:
      labels:
        app: \${install}-vpn
    spec:
      containers:
        - name: vpn
          image: alpine:3.20
          command: ["/bin/sh", "/run/run.sh"]
          securityContext:
            capabilities:
              # The two the tunnel needs and nothing else: a tun device, and routes on it. Not
              # privileged - a pod holding somebody's VPN credentials is the last place to put
              # the whole node within reach.
              add: [NET_ADMIN]
          resources:
            requests:
              cpu: 10m
              memory: 32Mi
            limits:
              cpu: "1"
              memory: 256Mi
          ports:
            - name: proxy
              containerPort: \${proxyPort}
          readinessProbe:
            tcpSocket:
              port: \${proxyPort}
            periodSeconds: 10
            # The handshake takes a while and the proxy is not started until it is done, so this
            # is allowed to fail for two minutes before the pod is called unready.
            failureThreshold: 12
          volumeMounts:
            - name: script
              mountPath: /run
            - name: profile
              mountPath: /profile
              readOnly: true
            - name: tun
              mountPath: /dev/net/tun
      volumes:
        - name: script
          configMap:
            name: \${install}-vpn
        - name: profile
          secret:
            secretName: ${ VPN_SECRET }
            optional: true
        # The host's tun device, which is what openvpn opens. A DirectoryOrCreate on /dev/net
        # would make a directory where a device node has to be, so the node's own is mounted.
        - name: tun
          hostPath:
            path: /dev/net/tun
            type: CharDevice
`,
        },
        {
          name:    'service.yaml',
          content: `apiVersion: v1
kind: Service
metadata:
  namespace: \${namespace}
  name: \${install}-vpn
  labels:
    app: \${install}-vpn
spec:
  selector:
    app: \${install}-vpn
  ports:
    - name: proxy
      port: \${proxyPort}
      targetPort: \${proxyPort}
    # The fixed forwards. Always four, because a bundle is rendered by substituting value
    # names and a list cannot be looped over; a slot set to none listens for nothing and the
    # port simply never answers.
    - name: forward1
      port: 9001
      targetPort: 9001
    - name: forward2
      port: 9002
      targetPort: 9002
    - name: forward3
      port: 9003
      targetPort: 9003
    - name: forward4
      port: 9004
      targetPort: 9004
`,
        },
      ],
    },
  };
}

/**
 * What a workspace needs in its environment to reach the lab through a connection, given the
 * namespace that connection is installed in.
 *
 * `NO_PROXY` is most of what makes this safe to set: everything in the cluster and every address
 * this Rancher answers on has to keep going direct, or a workspace pointed at the proxy stops
 * being able to reach its own API. The lab is the only thing that goes through it.
 */
export function labProxyEnv(namespace: string, install: string, proxyPort = '8888'): Record<string, string> {
  const proxy = `http://${ install }-vpn.${ namespace }.svc.cluster.local:${ proxyPort }`;

  return {
    HTTP_PROXY:  proxy,
    HTTPS_PROXY: proxy,
    http_proxy:  proxy,
    https_proxy: proxy,
    NO_PROXY:    'localhost,127.0.0.1,.svc,.svc.cluster.local,.cluster.local,10.42.0.0/16,10.43.0.0/16,rancher.ourhome.dev',
    no_proxy:    'localhost,127.0.0.1,.svc,.svc.cluster.local,.cluster.local,10.42.0.0/16,10.43.0.0/16,rancher.ourhome.dev',
  };
}
