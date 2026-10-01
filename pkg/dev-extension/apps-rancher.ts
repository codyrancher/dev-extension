// The two Apps this product did not define, now that it does.
//
// `rancher-single` is a Rancher server: one node, GitHub login, an address of its own.
// `rancher-share` is a public link in front of one of them, serving a build somebody made in a
// workspace. Both were authored straight into the cluster - one by hand, one by the agents'
// share skill - which meant they existed on the Rancher that happened to have them and nowhere
// else, and an edit to either was an edit to a live object with no copy anywhere.
//
// They are definitions here now, like every other App this extension needs, so installing the
// extension is what puts them on a cluster and a change to one arrives with a version rather
// than with somebody remembering to apply it. See ensureDefaultApp: the App carries the
// fingerprint of the definition that wrote it, so this takes ownership of the copies already
// out there on the first load and leaves existing Installations rendering what they rendered.
//
// The text below is those Apps as they were, to the character, with one change: `rancher-single`
// grew a second Ingress rule carrying a name of its own (`${host}`, filled in by ranchers.ts
// once the node has an address), because a rule with no host is a rule with nothing for the
// certificate controller to certify. See certs.ts.
/* eslint-disable */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

/** A Rancher server of its own: one node, GitHub login, an sslip address. */
export function rancherSingleApp(): Json {
  return {
    apiVersion: 'appsplus.io/v1alpha1',
    kind:       'App',
    metadata:   { name: 'rancher-single' },
    spec:       {
      description: "A Rancher server on one EC2 node, provisioned for it: the quickest Rancher of your own. GitHub login is wired to the same GitHub app the parent uses; reach it at <name>.<node ip>.sslip.io and add that /verify-auth URL to the app's callback list. Not HA: one node, one replica.",
      values:      {
        adminPassword: "rancher-ha-changeme",
        cloudCredentials: "# no cloud credentials selected",
        githubClientId: "Ov23liZrckyC1PFKoW6b",
        githubClientSecret: "81bfeb9378237e4c39b856a975365fca9be3aef6",
        githubUserId: "55104481",
        host: "none",
        image: "rancher/rancher:v2.15.1",
      },
      valueLabels: {
        adminPassword: "Admin password",
        host: "Public name this Rancher answers on, so it can be given a certificate; none for the address alone",
        image: "Rancher image",
      },
      clusterTemplate: `apiVersion: rke-machine-config.cattle.io/v1
kind: Amazonec2Config
metadata:
  name: \${cluster}-machine
region: \${region}
zone: \${zone}
instanceType: \${instanceType}
rootSize: "\${rootSize}"
securityGroup:
  - rancher-nodes
securityGroupReadonly: true
vpcId: \${vpcId}
subnetId: \${subnetId}
---
apiVersion: provisioning.cattle.io/v1
kind: Cluster
metadata:
  name: \${cluster}
spec:
  cloudCredentialSecretName: \${cloudCredential}
  kubernetesVersion: \${kubernetesVersion}
  rkeConfig:
    machineGlobalConfig:
      cni: \${cni}
    machinePools:
      # One node: this is the single-instance Rancher, for a person or a team that wants a
      # Rancher of their own quickly and does not need it to survive losing a node.
      - name: pool1
        controlPlaneRole: true
        etcdRole: true
        workerRole: true
        quantity: 1
        machineConfigRef:
          kind: Amazonec2Config
          name: \${cluster}-machine
`,
      templates: [
        {
          name:    "10-rbac.yaml",
          content: `# Every resource in this app is pinned to cattle-system rather than taking the installation's namespace.
#
# Rancher only works there. Released anywhere else it comes up, serves pages, and answers
# "API Aggregation not ready" on all of them, because the APIService for v1.ext.cattle.io is
# registered against cattle-system/imperative-api-extension by name. The chart of this app
# refuses to render at all in another namespace; this is the same rule, applied by not
# offering the choice. The installation's target namespace still decides where anything
# unqualified would go - it just no longer decides where Rancher goes.
# Rancher is a controller of the cluster it runs in, and the upstream chart binds it to
# cluster-admin for exactly that reason. Copied rather than narrowed: a Rancher on a smaller
# role fails in ways that look like bugs in Rancher.
# The account is named \`rancher\`, not \`\${install}-rancher\`, and the name is load-bearing.
#
# Rancher's own admission webhook, which Rancher installs into cattle-system once its
# controllers are running, marks the \`cacerts\` setting read-only for everybody except one
# identity, spelled out in its source as system:serviceaccount:cattle-system:rancher. Rancher
# started with --no-cacerts clears that setting on every boot. So a Rancher running under any
# other account starts fine exactly once - before its webhook exists - and every pod after
# that dies on the way up with "failed to setup TLS listener: setting is read only". The first
# rollout is where it shows, as one replica crash-looping while the other two, which predate
# the webhook, carry on. This app is pinned to cattle-system and a cluster holds one Rancher,
# so a per-install name here was buying nothing anyway.
apiVersion: v1
kind: ServiceAccount
metadata:
  name: rancher
  namespace: cattle-system
  labels:
    app: \${install}-rancher
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  # Cluster-scoped, so the name carries the installation's - two installations of this app in
  # one cluster must not land on one binding.
  name: \${install}-rancher
  labels:
    app: \${install}-rancher
subjects:
  - kind: ServiceAccount
    name: rancher
    namespace: cattle-system
roleRef:
  kind: ClusterRole
  name: cluster-admin
  apiGroup: rbac.authorization.k8s.io
`,
        },
        {
          name:    "20-bootstrap-secret.yaml",
          content: `# The password the first login uses.
#
# Rancher reads it once, on the first start of a cluster that has no admin yet, and stores a
# hash - so changing this afterwards changes nothing, and the secret is kept only because
# Rancher re-reads it while bootstrapping is still in progress.
apiVersion: v1
kind: Secret
metadata:
  name: \${install}-rancher-bootstrap
  namespace: cattle-system
  labels:
    app: \${install}-rancher
type: Opaque
stringData:
  bootstrapPassword: \${adminPassword}
`,
        },
        {
          name:    "30-service.yaml",
          content: `# Two services, and the second one is not optional.
#
# The first is what the ingress sends traffic to. The second is how the three replicas find
# each other: CATTLE_PEER_SERVICE names a service, and Rancher reads its endpoints to learn
# the pods it is sharing leadership with. Without it three replicas are three Ranchers.
apiVersion: v1
kind: Service
metadata:
  name: \${install}-rancher
  namespace: cattle-system
  labels:
    app: \${install}-rancher
spec:
  type: ClusterIP
  ports:
    - port: 80
      targetPort: 80
      protocol: TCP
      name: http
    - port: 443
      targetPort: 443
      protocol: TCP
      name: https
  selector:
    app: \${install}-rancher
---
apiVersion: v1
kind: Service
metadata:
  name: \${install}-rancher-internal
  namespace: cattle-system
  labels:
    app: \${install}-rancher
spec:
  type: ClusterIP
  ports:
    - port: 443
      targetPort: 444
      protocol: TCP
      name: https-internal
  selector:
    app: \${install}-rancher
`,
        },
        {
          name:    "40-deployment.yaml",
          content: `# Rancher itself: one replica, on the one node.
#
# The anti-affinity is \`required\`, not \`preferred\`, and that is the whole of what makes this an
# HA install rather than three pods that might all be on one machine. It is also what makes the
# app refuse a cluster smaller than three nodes: with fewer, the spare replicas have nowhere to
# go and stay Pending.
#
# The chart of this app checks the node count up front and says so in a sentence. There is no
# equivalent here on purpose. Fleet owns every resource in a bundle and watches it for drift,
# so a check Job is a resource that has to exist for ever: leave it and its pod template is
# immutable, so changing the image is an update Fleet cannot apply; give it a TTL and Fleet
# reports the installation as modified the moment it cleans itself up. A Helm hook is outside
# the release, which is why the chart can have one and this cannot.
apiVersion: apps/v1
kind: Deployment
metadata:
  name: \${install}-rancher
  namespace: cattle-system
  labels:
    app: \${install}-rancher
spec:
  replicas: 1
  selector:
    matchLabels:
      app: \${install}-rancher
  # No surge, because there is nowhere for a surge pod to go.
  #
  # The anti-affinity below is \`required\` on hostname and there are as many replicas as nodes,
  # so during a rollout a fourth pod has no node it is allowed on and sits Pending for ever -
  # and with it the rollout, which is what "ReplicaSet has timed out progressing" on an
  # otherwise healthy install turns out to mean. Taking one down and then bringing one up is
  # the only order that fits, and it costs nothing here: two replicas stay up throughout.
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxSurge: 0
      maxUnavailable: 1
  template:
    metadata:
      labels:
        app: \${install}-rancher
    spec:
      serviceAccountName: rancher
      affinity:
        podAntiAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
            - labelSelector:
                matchExpressions:
                  - key: app
                    operator: In
                    values:
                      - \${install}-rancher
              topologyKey: kubernetes.io/hostname
      containers:
        - name: rancher
          image: \${image}
          imagePullPolicy: IfNotPresent
          ports:
            - containerPort: 80
              protocol: TCP
            - containerPort: 443
              protocol: TCP
            - containerPort: 444
              protocol: TCP
            - containerPort: 6666
              protocol: TCP
          args:
            # TLS is terminated by the ingress controller in front of this, so Rancher does not
            # serve a CA of its own and does not need its certificates cleared for one.
            - --no-cacerts
            - --http-listen-port=80
            - --https-listen-port=443
            # Not a choice: the flag has been deprecated since Rancher 2.5 and the server
            # refuses to start with it off. So this Rancher adopts the cluster it runs on as
            # its \`local\` cluster, and installs its own webhook, Fleet and provisioning
            # controllers into cattle-system there.
            #
            # Which is why this app wants a cluster of its own. Install it onto a cluster some
            # other Rancher already manages and the two of them reconcile one cattle-system,
            # where fleet-agent in particular has exactly one owner - the second Rancher takes
            # it over and the first one loses the cluster.
            - --add-local=true
          env:
            - name: CATTLE_FEATURES
              value: multi-cluster-management=true,fleet=true,rke2=true,provisioningv2=true
            - name: CATTLE_NAMESPACE
              value: cattle-system
            - name: CATTLE_PEER_SERVICE
              value: \${install}-rancher
            - name: CATTLE_BOOTSTRAP_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: \${install}-rancher-bootstrap
                  key: bootstrapPassword
            - name: IMPERATIVE_API_DIRECT
              value: "true"
            - name: IMPERATIVE_API_APP_SELECTOR
              value: \${install}-rancher
            # Skip the first-run wizard, and do it through the environment rather than by
            # writing the Setting object.
            #
            # Rancher ships with first-login=true, and while it is true every successful login -
            # GitHub included - is sent to the setup page, which wants the local admin's bootstrap
            # password and a new one to replace it. A GitHub user has neither, so the page hands
            # them back to the login screen, which greets them as a first-time visitor, and
            # round it goes.
            #
            # Any setting can be given as CATTLE_<NAME>, and one given that way is marked
            # \`source: env\`: Rancher treats it as authoritative and its own webhook refuses to
            # let anything else change it. That is exactly the shape wanted here. The
            # alternative - declaring the Setting object in this bundle - does not land: Rancher
            # creates and manages that object itself, Helm records the release as deployed, and
            # the live object comes out the other side unchanged and un-owned, with Fleet
            # reporting it "not owned by us" indefinitely. The environment is the channel Rancher
            # actually listens on for this.
            #
            # eula-agreed is left alone: the Rancher these apps are managed from has it empty and
            # logs in fine. server-url is not set: its value is the hostname the instance is
            # reached on, which carries a node IP nobody knows at template time, and this
            # instance manages no downstream clusters, which is what server-url is for.
            - name: CATTLE_FIRST_LOGIN
              value: "false"
          startupProbe:
            httpGet:
              path: /healthz
              port: 80
            timeoutSeconds: 5
            periodSeconds: 10
            failureThreshold: 30
          livenessProbe:
            httpGet:
              path: /healthz
              port: 80
            timeoutSeconds: 5
            periodSeconds: 30
            failureThreshold: 5
          readinessProbe:
            httpGet:
              path: /healthz
              port: 80
            timeoutSeconds: 5
            periodSeconds: 30
            failureThreshold: 5
        # GitHub login and the admins, applied once this Rancher has installed its CRDs: see
        # 70-admins.yaml for why they cannot be resources of the bundle.
        - name: bootstrap-auth
          image: \${image}
          imagePullPolicy: IfNotPresent
          command:
            - /bin/sh
            - -c
            - |
              # The Rancher these apps are managed from installed system-upgrade-controller
              # on this cluster while provisioning it, as Helm release
              # mcc-\${install}-managed-system-upgrade-controller, and then let go of it. This
              # Rancher installs the same chart into its local cluster as release
              # system-upgrade-controller; Helm refuses to adopt objects another release name
              # owns, so without this it fails and retries every half minute, a helm-operation
              # pod each time, until the node is full. Handing the objects over is what lets
              # the first install here succeed.
              handover() { for kind in deployment serviceaccount configmap clusterrolebinding; do for n in $(kubectl get $kind -n cattle-system -o jsonpath='{range .items[?(@.metadata.annotations.meta\\.helm\\.sh/release-name=="mcc-\${install}-managed-system-upgrade-controller")]}{.metadata.name}{" "}{end}' 2>/dev/null); do kubectl annotate $kind -n cattle-system $n meta.helm.sh/release-name=system-upgrade-controller --overwrite; done; done; }
              handover || true
              echo "waiting for Rancher's CRDs"
              until kubectl get crd authconfigs.management.cattle.io users.management.cattle.io globalrolebindings.management.cattle.io >/dev/null 2>&1; do sleep 15; done
              echo "waiting for Rancher to create the github AuthConfig"
              until kubectl get authconfig github >/dev/null 2>&1; do sleep 10; done
              until kubectl apply -f /bootstrap/authconfig.yaml -f /bootstrap/admins.yaml; do echo "not yet, retrying"; sleep 15; done
              echo "github login and admins configured"
              while true; do sleep 3600; handover >/dev/null 2>&1 || true; kubectl apply -f /bootstrap/authconfig.yaml -f /bootstrap/admins.yaml >/dev/null 2>&1 || true; done
          volumeMounts:
            - name: bootstrap-auth
              mountPath: /bootstrap
              readOnly: true
      volumes:
        - name: bootstrap-auth
          configMap:
            name: \${install}-rancher-bootstrap-auth
`,
        },
        {
          name:    "50-ingress.yaml",
          content: `# How the browser gets in: by address, and by a name of its own once there is one.
#
# The second rule carries no host, so it matches every request that reaches the ingress controller -
# which means the public IP of any of the three nodes is a working address for this Rancher,
# with no DNS to arrange first. The controller answers 443 with its own self-signed
# certificate, so the browser warns once and the session is still TLS: Rancher sets secure
# cookies, and over plain HTTP the login would not stick.
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: \${install}-rancher
  namespace: cattle-system
  labels:
    app: \${install}-rancher
  annotations:
    # Rancher's own numbers. The long read timeout is what keeps its websockets - the shell,
    # log tailing, every live-updating page - from being cut at the proxy after a minute.
    nginx.ingress.kubernetes.io/proxy-connect-timeout: "30"
    nginx.ingress.kubernetes.io/proxy-read-timeout: "1800"
    nginx.ingress.kubernetes.io/proxy-send-timeout: "1800"
    nginx.ingress.kubernetes.io/proxy-body-size: "0"
spec:
  ingressClassName: traefik
  rules:
    # The same service under a name of its own, so there is something to put on a certificate.
    # \`none\` until the browser knows the node's address (see ranchers.ts, ensureRancherHosts);
    # a rule for the literal host "none" matches nothing, which is the state this starts in.
    # TLS is not declared here: the cluster's certificate controller adds it when it has a
    # certificate for this name, and an Ingress naming a Secret that does not exist yet is an
    # error in that controller's log every few seconds.
    - host: \${host}
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: \${install}-rancher
                port:
                  number: 80
    - http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: \${install}-rancher
                port:
                  number: 80
`,
        },
        {
          name:    "60-github-auth.yaml",
          content: `# GitHub login on this instance, against the same GitHub app the parent Rancher uses.
#
# Sharing one app across instances turns on a detail of how Rancher asks for the redirect.
# The server publishes only \`https://github.com/login/oauth/authorize?client_id=...\`; it is the
# dashboard that appends \`redirect_uri\`, and it builds that from \`window.location.origin\` -
# the host in the address bar - not from server-url. So each instance sends GitHub its own
# hostname, and GitHub checks that against the callback URLs registered on the app.
#
# A classic OAuth app has exactly one callback URL and matches on host, so it cannot serve two
# instances at once. A GitHub app takes up to ten. That is the arrangement this expects: reach
# an instance at \`<install>.dev-extension.<node ip>.sslip.io\` - sslip.io resolves any name with
# an IP embedded in it, so the prefix is free - which the host-less ingress next door already
# serves because sslip.io resolves the name straight back to the node, and add that one URL to
# the app's callback list. Ten instances can be logged into at a time; the eleventh needs a
# slot freed.
#
# All three values are defaulted from whatever the Rancher these apps are managed from already
# has configured - its client id, its client secret, and the GitHub user in its allowed
# principals - so an installation supplies nothing and the instance comes up sharing the app.
#
# The secret is a copy, not a reference, because nothing here can keep it as one. Fleet's
# \`helm.valuesFrom\` does take a secretKeyRef, but the agent resolves it against the cluster it
# is deploying to, which is the cluster that does not have the secret yet; and a bundle's
# resources are literal content by the time they leave. So it is written out - and it was
# already being written into every AppInstance, Bundle and Content on the way down, all of
# which are admin-only, which is why keeping one copy here is not a wider exposure than typing
# it in each time was.
#
# Rotating the GitHub app's secret therefore means updating this default too. Nothing detects
# that: the instances keep the secret they were installed with, and a login stops working.
apiVersion: v1
kind: Namespace
metadata:
  name: cattle-global-data
  annotations:
    # Adopted, not created - so it must survive an uninstall.
    #
    # The bundle takes ownership of objects Rancher made itself, which is what lets this app
    # configure the AuthConfig at all. The cost is that Helm would then delete them on the way
    # out, and cattle-global-data is where that Rancher keeps its global roles and settings.
    # This annotation is Helm's own opt-out and is the whole of what stops an uninstall taking
    # the instance's global data with it. The client-secret Secret below carries no such
    # annotation: that one really is ours, and removing it is right.
    helm.sh/resource-policy: keep
---
# Rancher does not keep the client secret in the AuthConfig. It writes it here and leaves the
# string \`cattle-global-data:githubconfig-clientsecret\` behind as a pointer, which is the form
# the AuthConfig in 70-admins.yaml's ConfigMap uses.
apiVersion: v1
kind: Secret
metadata:
  name: githubconfig-clientsecret
  namespace: cattle-global-data
type: Opaque
stringData:
  clientsecret: \${githubClientSecret}
`,
        },
        {
          name:    "65-cloud-credentials.yaml",
          content: `# Cloud credentials copied from the managing Rancher so this instance can provision clusters on
# the same clouds. Which credentials arrive is chosen in the Dev extension's Settings (an
# annotation on each credential), and createRancherInstance fills the cloudCredentials value at
# provision time; the default below means none were chosen. cattle-global-data is created
# (adopted, resource-policy keep) by 60-github-auth.yaml.
\${cloudCredentials}
`,
        },
        {
          name:    "70-admins.yaml",
          content: `# The GitHub accounts that are administrators of this instance.
#
# Rancher gives a user created by an auth provider the \`user\` global role, which is enough to
# log in and see nothing. Without something here, the first GitHub login lands on an empty
# dashboard or bounces straight back to the login screen, which is what it looks like when it
# happens to you.
#
# The trick that makes this declarable is that Rancher's name for an auth-provider user is not
# random. It is derived from the principal:
#
#     u- + base32(sha256("github_user://<id>"))[:10], lowercased
#
# so the User object can be written before anybody has ever logged in, and the login finds it
# instead of making a second one. The GlobalRoleBinding next to it can then name that user
# directly. Adding somebody is those two resources with their id run through that formula (and
# \`local://\` + that name as the second principal), and
# their id added to allowedPrincipalIds in 60-github-auth.yaml - that list is what decides who
# may log in at all, and an admin who is not on it cannot get far enough to use the binding.
#
# The label Rancher puts on the users it creates itself is an index and is deliberately not
# reproduced: this Rancher's own admin carries a GitHub principal without one and resolves by
# principalIds alone, so the index is an optimisation rather than the lookup.
# codyrancher - https://github.com/codyrancher - github user id 55104481
#
# Why these are a ConfigMap and a sidecar rather than resources of this bundle: they are
# Rancher's own kinds (management.cattle.io/v3), whose CRDs exist only once the Rancher in
# 40-deployment.yaml has started and installed them. A Fleet bundle is one Helm release, and
# Helm builds every object before it applies any, so a bundle carrying these on a fresh
# cluster fails at "no matches for kind GlobalRoleBinding" with nothing applied - Rancher
# included - and stays there. So the bundle carries them as text, and a second container in
# Rancher's own pod (same image; it has kubectl, and the pod's account is cluster-admin) waits
# for the CRDs and applies them, then re-applies hourly so what is declared here is what holds.
apiVersion: v1
kind: ConfigMap
metadata:
  name: \${install}-rancher-bootstrap-auth
  namespace: cattle-system
data:
  authconfig.yaml: |
    apiVersion: management.cattle.io/v3
    kind: AuthConfig
    metadata:
      name: github
      annotations:
        helm.sh/resource-policy: keep
    type: githubConfig
    enabled: true
    accessMode: restricted
    allowedPrincipalIds:
      - github_user://\${githubUserId}
      - github_org://9343010
    clientId: \${githubClientId}
    clientSecret: cattle-global-data:githubconfig-clientsecret
    hostname: github.com
    tls: true
  admins.yaml: |
    apiVersion: management.cattle.io/v3
    kind: User
    metadata:
      name: u-ukjm7tnoza
    displayName: codyrancher
    principalIds:
      - github_user://55104481
      - local://u-ukjm7tnoza
    ---
    apiVersion: management.cattle.io/v3
    kind: GlobalRoleBinding
    metadata:
      name: grb-admin-u-ukjm7tnoza
    globalRoleName: admin
    userName: u-ukjm7tnoza
    ---
    # Everyone in the rancher GitHub org (id 9343010) is an administrator here:
    # the org is in allowedPrincipalIds above so members can log in, and this binds the
    # org group principal to the admin global role.
    apiVersion: management.cattle.io/v3
    kind: GlobalRoleBinding
    metadata:
      name: grb-admin-rancher-org
    globalRoleName: admin
    groupPrincipalName: github_org://9343010
`,
        },
        {
          name:    "80-lease-policy.yaml",
          content: `# Who is allowed to be this cluster's Rancher.
#
# A Rancher server elects a leader on the lease kube-system/cattle-controllers and runs its
# management controllers - the ones that create the built-in global roles, honour role
# bindings, and reconcile auth - only on the replica that holds it. The name is a literal in
# the binary, with no way to change it.
#
# The cluster this app is installed on was provisioned by another Rancher, and that Rancher's
# cattle-cluster-agent uses the very same lease for its own downstream controllers. So the two
# contend. Whoever holds it renews every few seconds and never lets go, and the other waits;
# the agent is there first because it arrives with the cluster, and it wins again at every
# restart of this Rancher's leader - a rollout was enough. What that looks like from the
# outside is a Rancher that serves pages but has no global roles, whose first GitHub login
# bounces back to the login screen, and whose admin binding binds to nothing.
#
# Nothing in the agent can be told to stand down and nothing in the parent will stop
# redeploying it; scaling it to zero was undone within the minute. This is the one lever that
# is declarative, precise, and does not fight anybody: a native admission policy that lets
# exactly one identity write exactly one lease. The agent's next renewal is refused, the lease
# lapses, this Rancher takes it and keeps it. The agent goes on doing everything else - the
# tunnel the managing Rancher reaches this cluster through is not the lease - and only its
# downstream controllers stay idle, which is the right outcome on a cluster whose point is to
# host a Rancher of its own.
#
# failurePolicy is Ignore on purpose. The scheduler and the controller-manager keep their own
# leases in kube-system too, and a policy that failed closed on a CEL error would take the
# control plane down with it; failing open turns that same error into "the agent can contend
# again", which is where we started and no worse. The match conditions name the lease, so a
# correctly-evaluating policy touches nothing else.
apiVersion: admissionregistration.k8s.io/v1
kind: ValidatingAdmissionPolicy
metadata:
  name: rancher-owns-cattle-controllers-lease
spec:
  failurePolicy: Ignore
  matchConstraints:
    namespaceSelector:
      matchLabels:
        kubernetes.io/metadata.name: kube-system
    resourceRules:
      - apiGroups: ["coordination.k8s.io"]
        apiVersions: ["v1"]
        operations: ["CREATE", "UPDATE"]
        resources: ["leases"]
  matchConditions:
    - name: is-the-rancher-lease
      expression: "object.metadata.name == 'cattle-controllers'"
  validations:
    - expression: "request.userInfo.username == 'system:serviceaccount:cattle-system:rancher'"
      messageExpression: "'kube-system/cattle-controllers belongs to the Rancher server in this cluster; ' + request.userInfo.username + ' may not take it'"
      reason: Forbidden
---
apiVersion: admissionregistration.k8s.io/v1
kind: ValidatingAdmissionPolicyBinding
metadata:
  name: rancher-owns-cattle-controllers-lease
spec:
  policyName: rancher-owns-cattle-controllers-lease
  validationActions: ["Deny"]
`,
        },
      ],
    },
  };
}

/** A public link in front of a Rancher, serving a workspace's build over it. */
export function rancherShareApp(): Json {
  return {
    apiVersion: 'appsplus.io/v1alpha1',
    kind:       'App',
    metadata:   { name: 'rancher-share' },
    spec:       {
      description: "A public link in front of a Rancher that serves your own dashboard build and/or extension builds over it, and proxies everything else to that Rancher; or a public link to a static Storybook build. For showing a change to someone without an account here. Removed with the workspace that made it.",
      values:      {
        build: "none",
        host: "none",
        hostCluster: "local",
        ingressClass: "traefik",
        port: 8080,
        rancherUpstream: "none",
      },
      valueLabels: {
        build: "sha256 of the site tarball in the namespace's site ConfigMaps; the pod waits for it",
        host: "Public hostname the cluster's ingress serves the share on, e.g. <name>.dev-extension.<node ip>.sslip.io",
        hostCluster: "Management id of the cluster the share runs on",
        ingressClass: "Ingress class of the cluster the share runs on (traefik on the sidebar's Ranchers)",
        port: "Port nginx listens on",
        rancherUpstream: "The Rancher to front, by its in-cluster Service, e.g. http://otter-rancher.cattle-system.svc.cluster.local:80",
      },
      templates: [
        {
          name:    "namespace.yaml",
          content: `apiVersion: v1
kind: Namespace
metadata:
  name: \${namespace}
  labels:
    dev.rancher.io/app: \${app}
    dev.rancher.io/cluster: \${hostCluster}
  annotations:
    dev.rancher.io/port: "\${port}"
    dev.rancher.io/scheme: http
`,
        },
        {
          name:    "rbac.yaml",
          content: `apiVersion: v1
kind: ServiceAccount
metadata:
  namespace: \${namespace}
  name: site-reader
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  namespace: \${namespace}
  name: site-reader
rules:
  - apiGroups: [""]
    resources: [configmaps]
    verbs: [get]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  namespace: \${namespace}
  name: site-reader
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: Role
  name: site-reader
subjects:
  - kind: ServiceAccount
    name: site-reader
    namespace: \${namespace}
`,
        },
        {
          name:    "deployment.yaml",
          content: `apiVersion: apps/v1
kind: Deployment
metadata:
  namespace: \${namespace}
  name: \${namespace}
  labels:
    app: \${namespace}
    dev.rancher.io/app: \${app}
spec:
  replicas: 1
  selector:
    matchLabels:
      app: \${namespace}
  strategy:
    type: Recreate
  template:
    metadata:
      labels:
        app: \${namespace}
        dev.rancher.io/app: \${app}
      annotations:
        dev.rancher.io/build: "\${build}"
    spec:
      serviceAccountName: site-reader
      initContainers:
        # Reassembles the site from the namespace's ConfigMaps, checks it is the build
        # this pod was made for, and writes nginx's config from what is in it.
        - name: fetch
          image: nginx:1.27-alpine
          command:
            - /bin/sh
            - -c
            - |
              set -e
              SA=/var/run/secrets/kubernetes.io/serviceaccount
              T=$(cat $SA/token)
              get() { curl -fsS --cacert $SA/ca.crt -H "Authorization: Bearer $T" "https://kubernetes.default.svc/api/v1/namespaces/\${namespace}/configmaps/$1" | tr -d '\\n'; }
              until m=$(get site) && echo "$m" | grep -q '"sha256": *"\${build}"'; do
                echo "waiting for site \${build}"; sleep 5
              done
              n=$(echo "$m" | sed 's/.*"parts": *"\\([0-9]*\\)".*/\\1/')
              rm -f /tmp/s.tgz
              i=0
              while [ $i -lt $n ]; do
                get site-$(printf %02d $i) | sed 's/.*"part": *"\\([^"]*\\)".*/\\1/' | base64 -d >> /tmp/s.tgz
                i=$((i + 1))
              done
              echo "\${build}  /tmp/s.tgz" | sha256sum -c -
              W=/site/www
              rm -rf $W && mkdir -p $W /site/nginx && tar -xzf /tmp/s.tgz -C $W
              C=/site/nginx/default.conf
              echo 'map $http_upgrade $connection_upgrade { default upgrade; "" close; }' > $C
              echo 'server {' >> $C
              echo '  listen \${port};' >> $C
              echo '  client_max_body_size 0;' >> $C
              echo '  location = /.rancher-share-build { default_type text/plain; add_header Cache-Control no-store; return 200 "\${build}"; }' >> $C
              if [ -f $W/iframe.html ]; then
                echo "serving a Storybook build"
                echo '  location / { root /site/www; try_files $uri $uri/ /index.html; add_header Cache-Control no-cache; }' >> $C
                echo '}' >> $C
                cat $C
                exit 0
              fi
              if [ -f $W/uiplugins.json ]; then
                echo "serving extensions: $(ls $W/uiplugins | tr '\\n' ' ')"
                echo '  location = /v1/uiplugins { default_type application/json; add_header Cache-Control no-store; root /site/www; try_files /uiplugins.json =404; }' >> $C
                echo '  location /v1/uiplugins/ { alias /site/www/uiplugins/; add_header Cache-Control no-store; }' >> $C
              fi
              if [ -f $W/dashboard/index.html ]; then
                echo "serving a dashboard build"
                echo '  location /dashboard/ { root /site/www; try_files $uri /dashboard/index.html; add_header Cache-Control no-cache; }' >> $C
              fi
              echo '  location / { proxy_pass \${rancherUpstream}; proxy_http_version 1.1; proxy_set_header Upgrade $http_upgrade; proxy_set_header Connection $connection_upgrade; proxy_set_header Host $host; proxy_set_header X-Forwarded-Proto https; proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for; proxy_read_timeout 1h; proxy_buffering off; }' >> $C
              echo '}' >> $C
              cat $C
          volumeMounts:
            - name: site
              mountPath: /site
      containers:
        - name: nginx
          image: nginx:1.27-alpine
          ports:
            - name: http
              containerPort: \${port}
          volumeMounts:
            - name: site
              mountPath: /site
              readOnly: true
            - name: site
              subPath: nginx
              mountPath: /etc/nginx/conf.d
              readOnly: true
          readinessProbe:
            tcpSocket:
              port: \${port}
            periodSeconds: 10
      volumes:
        - name: site
          emptyDir: {}
`,
        },
        {
          name:    "service.yaml",
          content: `apiVersion: v1
kind: Service
metadata:
  namespace: \${namespace}
  name: \${namespace}
  labels:
    dev.rancher.io/app: \${app}
spec:
  selector:
    app: \${namespace}
  ports:
    - name: http
      port: \${port}
      targetPort: http
`,
        },
        {
          name:    "ingress.yaml",
          content: `apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  namespace: \${namespace}
  name: \${namespace}
  labels:
    dev.rancher.io/app: \${app}
spec:
  ingressClassName: \${ingressClass}
  rules:
    - host: \${host}
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: \${namespace}
                port:
                  number: \${port}
`,
        },
      ],
    },
  };
}
