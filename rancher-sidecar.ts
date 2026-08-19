/**
 * A real Rancher for a workspace, as `deploy/closet/templates/rancher.yaml` already does it.
 *
 * The obvious approach does not work and it is worth writing down why, because it is the reason
 * everything below is shaped the way it is. `rancher/rancher` is the docker-style image with an
 * embedded k3s in it, and a pod running it fights the host cluster over cgroups: here a
 * privileged pod gets the node's own cgroup root rather than a namespace of its own, so its
 * kubelet is killed within seconds. That is what a previous pass investigated and concluded was
 * impossible, and it is not what this does.
 *
 * What this does instead is the topology Rancher actually supports. A manager pod helm-installs a
 * **vcluster** (a k3s control plane of its own, whose workloads are synced back to this cluster as
 * ordinary pods), then helm-installs cert-manager and rancher-latest *inside* that vcluster, which
 * is a completely ordinary Rancher installation on a completely ordinary cluster. The vcluster
 * replicates the rancher Service back out to this namespace, and the manager relays :443 to it, so
 * the sidecar's own Service points at the manager pod and everything downstream of it is unchanged.
 *
 * Every value here is the chart's rather than a fresh opinion: the vcluster version, the k8s
 * version kept below the rancher chart's ceiling, the hostPath data volume (this cluster has no
 * StorageClass, so a PVC would never bind), the watchdog, the order of the installs, their
 * timeouts, and the `role: relay` label that keeps the manager pod distinguishable from the
 * rancher pod the vcluster syncs into the same namespace with an `app: rancher` label of its own.
 *
 * The one thing added to the chart's script is the bootstrap, and there is a note on it below.
 */

/**
 * Where the vcluster's control plane keeps its data.
 *
 * Its own base rather than the workspace's, for two reasons: the workspace's directory is mounted
 * into the workspace container as `/workspace`, so a vcluster's etcd would appear inside somebody's
 * checkout, and a hostPath outlives the namespace that used it, so having one place to clean up is
 * worth more than having it next to the thing that made it.
 */
export const SIDECAR_HOST_PATH = '/var/lib/rancher/dev-sidecars';

/**
 * The vcluster's own values, from the chart.
 *
 * `volumeClaim.enabled: false` plus a hostPath dataVolume is how the chart handles a cluster with
 * no StorageClass, which is this one: a PVC would sit Pending for ever and the control plane would
 * never start.
 *
 * `replicateServices.toHost` is what makes the rest possible. The rancher Service inside the
 * vcluster is copied out into this namespace as `rancher-vc`, and that is what the relay dials.
 *
 * `replicateServices.fromHost` is the obvious way to give Rancher an address for the auth sidecars,
 * and it is not used here. It was tried and it cannot work with this manager. The keycloak and
 * openldap sidecars are ordinary Deployments in this namespace, so a pod inside the vcluster cannot
 * resolve them: the vcluster's CoreDNS is authoritative for `*.svc.cluster.local` and has never
 * heard of them. But adding a `fromHost` entry makes the chart render a **ClusterRole** and a
 * ClusterRoleBinding (services and endpoints, get/watch/list, cluster-wide), because the chart
 * cannot know that the source namespace is the vcluster's own. Measured with `helm template`: no
 * ClusterRole without the entry, two with it. The manager's Role is deliberately namespaced, so the
 * upgrade fails at the point helm reads that object:
 *
 *   Error: UPGRADE FAILED: could not get information about the resource ClusterRole
 *   "vc-vc-v-dev-demo": clusterroles.rbac.authorization.k8s.io is forbidden
 *
 * Widening the manager to create ClusterRoles is not a smaller problem than the one being solved:
 * a namespaced account that can write cluster-scoped RBAC is a cluster-admin account with extra
 * steps. So the address Rancher is given is the host Service's ClusterIP instead, which needs no
 * DNS and no rights at all: a vcluster's pods are ordinary pods on this node, so kube-proxy routes
 * them to a host ClusterIP like anything else. Proven from the rancher pod inside the vcluster:
 * a connection to the openldap Service's ClusterIP on 389 is accepted (curl exit 52, an answer that
 * is not HTTP) while an unused port on the same address times out (exit 28). See AUTH_SCRIPT.
 */
export const VCLUSTER_VALUES = `controlPlane:
  distro:
    k8s:
      enabled: true
      # Kept below the rancher chart's kubeVersion ceiling
      version: v1.34.1
  statefulSet:
    persistence:
      volumeClaim:
        enabled: false
      dataVolume:
        - name: data
          hostPath:
            path: {{dataPath}}
            type: DirectoryOrCreate
networking:
  replicateServices:
    toHost:
      - from: cattle-system/rancher
        to: rancher-vc
`;

/**
 * What the manager pod runs, start to finish. The chart's `manage.sh`, plus a bootstrap.
 *
 * The ordering and the waits are the chart's and are not rearranged. They exist because someone
 * hit the race they prevent:
 *
 *   - the watchdog goes first, before any install. A rollout's old pod runs the preStop pause at
 *     any moment, and it would otherwise scale the vcluster to nothing in the middle of this pod's
 *     install. It keeps the vcluster up for as long as this manager lives, so a real stop (which
 *     removes the manager) still pauses it.
 *   - `--wait` on the vcluster install, then a wait for the `vc-vc` Secret, then a wait for the
 *     API inside it to answer. The Secret carries the kubeconfig and appears after the install
 *     reports success; the API answers some time after that.
 *   - cert-manager before rancher, with its CRDs, because the rancher chart's issuer needs them.
 *
 * The kubeconfig rewrite is the chart's too: the config in the Secret points at localhost:8443,
 * which is right inside the control plane's pod and wrong everywhere else, and its CA is for a
 * name this pod does not dial.
 */
export const MANAGE_SCRIPT = `#!/bin/sh
set -x
# openldap-clients is for auth.sh: seeding a directory needs an LDAP client, and this pod is the
# only one that can reach OpenLDAP and hold the admin password at the same time.
apk add --no-cache socat curl openldap-clients || true

# Nothing is installed without a password to install it with.
#
# The reference to it is optional, so an absent or cleared key arrives as an empty variable rather
# than a failure to start. Rancher would then be installed with an empty bootstrapPassword, which
# makes it generate one of its own, and everything downstream would be trying to log in with a
# password that Rancher has never heard of. Refusing here is the difference between a sidecar that
# says what is wrong and a Rancher nobody can get into.
if [ -z "$CATTLE_BOOTSTRAP_PASSWORD" ]; then
  echo "refusing to install: RANCHER_BOOTSTRAP_PASSWORD is not set in the secret store"
  echo "set it in Settings, then start this sidecar again"
  exit 1
fi

# Watchdog (started first): a rollout's old pod runs the preStop pause and can race this pod's
# install at any phase. Keep the vcluster scaled up while this manager lives; a real stop removes
# the manager, so the pause sticks.
( while true; do kubectl -n "$NS" scale deploy vc --replicas=1 >/dev/null 2>&1 || true; sleep 30; done ) &

helm repo add loft https://charts.loft.sh
helm repo add jetstack https://charts.jetstack.io
helm repo add rancher-latest https://releases.rancher.com/server-charts/latest
helm repo update

helm upgrade --install vc loft/vcluster -n "$NS" \\
  --version "$VCLUSTER_VERSION" -f /scripts/vcluster-values.yaml \\
  --wait --timeout 10m

until kubectl -n "$NS" get secret vc-vc; do sleep 5; done
kubectl -n "$NS" get secret vc-vc -o jsonpath='{.data.config}' | base64 -d \\
  | sed -e "s|server: https://localhost:8443|server: https://vc.$NS.svc:443|" \\
        -e "s|certificate-authority-data:.*|insecure-skip-tls-verify: true|" > /tmp/kc
export KUBECONFIG=/tmp/kc
until kubectl get ns default; do sleep 5; done

helm upgrade --install cert-manager jetstack/cert-manager \\
  -n cert-manager --create-namespace \\
  --set crds.enabled=true --wait --timeout 10m

# The password goes in through a file rather than on the command line, and the file is written
# with tracing off. set -x is what makes this script readable while it runs, and it also prints
# every argument of every command, so the chart's --set bootstrapPassword=... puts the generated
# password into kubectl logs, readable by anything with pod/log in this namespace, and onto the
# sidecar card, which shows the last line while a sidecar is starting. The secretKeyRef keeps it
# out of the pod spec; this is the other half of the same promise.
set +x
printf 'bootstrapPassword: %s\\n' "$CATTLE_BOOTSTRAP_PASSWORD" > /tmp/rancher-values.yaml
chmod 600 /tmp/rancher-values.yaml
set -x

# The two things the card's gear sets, and the only reason this is built up rather than written
# out: an empty RANCHER_TAG has to mean "whatever the chart installs" rather than an image tag of
# the empty string, which is a pod that cannot pull.
EXTRA=""

if [ -n "$RANCHER_TAG" ]; then
  EXTRA="$EXTRA --set rancherImageTag=$RANCHER_TAG"
fi

# Prime is a UI brand, set as an environment variable on the Rancher container. The chart's own
# way to pass one through is extraEnv, which is a list, so it is indexed.
if [ -n "$RANCHER_PRIME" ]; then
  EXTRA="$EXTRA --set extraEnv[0].name=CATTLE_BASE_UI_BRAND --set extraEnv[0].value=suse"
fi

helm upgrade --install rancher rancher-latest/rancher \\
  -n cattle-system --create-namespace \\
  --set hostname="$RANCHER_HOSTNAME" --set replicas=1 \\
  $EXTRA \\
  -f /tmp/rancher-values.yaml \\
  --wait --timeout 20m

unset KUBECONFIG

# The relay, before the bootstrap rather than after it. The bootstrap talks to Rancher through
# this pod's own network either way, but starting the listener first is what lets the readiness
# probe pass and the card say Running while the bootstrap finishes, instead of holding the whole
# sidecar in Starting for the sake of three settings.
socat TCP-LISTEN:443,fork,reuseaddr "TCP:rancher-vc.$NS.svc:443" &

# ---- bootstrap: a Rancher you log into, not a setup wizard ----
#
# The steps are the closet api's (see the closet project's CLAUDE.md): wait for the API, log in with the
# generated bootstrap password, turn off the first-login wizard, set the server URL and put the
# agent TLS mode on the system store. It runs here rather than anywhere else because this is the
# only place that already holds the password, by secretKeyRef, and never renders it; and because
# it is idempotent, so the manager restarting re-applies it exactly as the closet's "once per
# container" does.
RURL="https://rancher-vc.$NS.svc"

until curl -sk -o /dev/null --max-time 10 "$RURL/ping"; do sleep 5; done

# Tracing off for the rest of it. Every command from here carries either the password or the
# session token it returns, and neither belongs in a log.
set +x

# Writes the body to /tmp/login.json and prints the status, because the two failures need
# different answers and the body alone cannot tell them apart.
login() {
  curl -sk --max-time 20 -o /tmp/login.json -w '%{http_code}' \\
    -X POST "$RURL/v3-public/localProviders/local?action=login" \\
    -H 'content-type: application/json' \\
    -d "{\\"username\\":\\"admin\\",\\"password\\":\\"$1\\"}"
}

token_from_login() {
  tr ',' '\\n' < /tmp/login.json | sed -n 's/.*"token":"\\([^"]*\\)".*/\\1/p' | head -1
}

TOKEN=""
i=0
while [ $i -lt 60 ]; do
  CODE=$(login "$CATTLE_BOOTSTRAP_PASSWORD")

  if [ "$CODE" = "200" ] || [ "$CODE" = "201" ]; then
    TOKEN=$(token_from_login)
    break
  fi

  # 401 is Rancher answering, and answering that this password is not its password. Waiting does
  # not change that, so the loop stops and the reset below runs. Retrying it to the end of the
  # count is how a rotated password turned into twenty-five minutes of a sidecar that looked fine
  # and was not: the retries are for a Rancher that is still starting, which is a refused
  # connection or a 5xx, not a considered no.
  if [ "$CODE" = "401" ]; then
    break
  fi

  sleep 5
  i=$((i + 1))
done

# The password in the store is only the password Rancher has if this Rancher was installed with
# it. The bootstrapPassword value applies at install and never again, so a Rancher that exists
# keeps whatever it was given the first time: rotate the key in the store and every login here
# fails, silently, and the value Settings shows is one nothing accepts.
#
# So when the login fails against a Rancher that is answering, the password is reset to the store's
# rather than left disagreeing with it. reset-password is Rancher's own recovery path and prints
# a working password; that is used once, to set ours, and never stored anywhere.
# Only on a considered 401, and only when there is a password to put back.
#
# reset-password changes the admin password to a fresh random string as a side effect of being
# run. If that string is then not set to anything, it exists in one shell variable in one
# container and nowhere else: not echoed, not written back, kept out of the trace by set +x. The
# version gated on an empty token reached that from three directions - a cleared key, a 200 with
# an unexpected body, and the loop simply running out - and each of them ended with a Rancher
# whose password nobody had.
if [ -z "$TOKEN" ] && [ "$CODE" = "401" ]; then
  echo "admin login failed; resetting the password to the one in the store"
  RESET=$(kubectl --kubeconfig /tmp/kc -n cattle-system exec deploy/rancher -- reset-password 2>/dev/null | tail -1 | tr -d '[:space:]')

  if [ -n "$RESET" ]; then
    login "$RESET" > /dev/null
    TEMP=$(token_from_login)
    USERID=$(curl -sk --max-time 20 -H "Authorization: Bearer $TEMP" "$RURL/v3/users?me=true" \\
      | tr ',' '\\n' | sed -n 's/.*"id":"\\(user-[^"]*\\)".*/\\1/p' | head -1)

    if [ -n "$TEMP" ] && [ -n "$USERID" ]; then
      # setpassword on the user, not changepassword. changepassword exists here only as a
      # collection action and answers 422 InvalidAction on a user id; setpassword is the one that
      # takes a user, and it also clears the mustChangePassword flag reset-password sets, which
      # would otherwise stop the next login at a change-your-password screen.
      SET=$(curl -sk --max-time 20 -X POST "$RURL/v3/users/$USERID?action=setpassword" \\
        -H "Authorization: Bearer $TEMP" -H 'content-type: application/json' \\
        -d "{\\"newPassword\\":\\"$CATTLE_BOOTSTRAP_PASSWORD\\"}" \\
        -o /dev/null -w '%{http_code}')
      echo "password reset $SET"

      # Read, not merely printed. A status that only ever went into curl's -w was a status nothing
      # acted on, so a rejected setpassword looked exactly like a successful one and the admin
      # password stayed at the value reset-password had just invented.
      case "$SET" in
        2*)
          CODE=$(login "$CATTLE_BOOTSTRAP_PASSWORD")

          if [ "$CODE" = "200" ] || [ "$CODE" = "201" ]; then
            TOKEN=$(token_from_login)
          fi
          ;;
        *)
          echo "SETTING THE ADMIN PASSWORD FAILED ($SET)."
          echo "This Rancher's admin password was changed by reset-password and is not the one in"
          echo "the secret store. To get back in, run reset-password again and use what it prints:"
          echo "  kubectl -n cattle-system exec deploy/rancher -- reset-password"
          ;;
      esac
    fi
  fi
fi

if [ -n "$TOKEN" ]; then
  for pair in "first-login=false" "server-url=$RURL" "agent-tls-mode=system-store"; do
    name=\${pair%%=*}
    value=\${pair#*=}
    curl -sk --max-time 20 -X PUT "$RURL/v3/settings/$name" \\
      -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \\
      -d "{\\"name\\":\\"$name\\",\\"value\\":\\"$value\\"}" \\
      -o /dev/null -w "bootstrap $name %{http_code}\\n"
  done
  # The cloud credentials this person has set, put into this Rancher so a cluster can be
  # provisioned without typing them in again. The closet does the same at start, and for the same
  # reason: they are the workspace's own copy of a credential that already exists, not a new one.
  #
  # Only where both halves of a credential are set. A cloud credential with one of its two keys
  # is one Rancher accepts and every provisioning attempt then fails on, which is worse than not
  # having it: the failure arrives minutes later and names something else.
  if [ -n "$AWS_ACCESS_KEY" ] && [ -n "$AWS_SECRET_KEY" ]; then
    # The name is fixed, so this is the same credential on every restart rather than a new one
    # each time. Rancher generates the id, so an existing one is found by name and left alone.
    if curl -sk --max-time 20 -H "Authorization: Bearer $TOKEN" "$RURL/v3/cloudcredentials" \
      | grep -q '"name":"aws"'; then
      echo "bootstrap aws credential already there"
    else
      set +x
      cat > /tmp/aws-cred.json <<JSON
{"type":"provisioning.cattle.io/cloud-credential","name":"aws",
 "description":"From the workspace's own settings",
 "amazonec2credentialConfig":{"accessKey":"$AWS_ACCESS_KEY","secretKey":"$AWS_SECRET_KEY","defaultRegion":"\${AWS_DEFAULT_REGION:-us-west-2}"}}
JSON
      chmod 600 /tmp/aws-cred.json
      set -x

      curl -sk --max-time 20 -X POST "$RURL/v3/cloudcredentials" \
        -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
        -d @/tmp/aws-cred.json -o /dev/null -w "bootstrap aws credential %{http_code}\n"

      rm -f /tmp/aws-cred.json
    fi
  fi

  echo "bootstrap done"
else
  echo "bootstrap skipped: could not log in as admin"
fi

# The auth provider the workspace asked for, applied and then kept applied. Separate script and a
# loop of its own, because it answers to a ConfigMap somebody edits while this pod runs, where
# everything above happens once and is finished.
sh /scripts/auth.sh &

wait
`;

/**
 * The reconciler behind the Sidecars tab's auth row.
 *
 * The shape is the closet's, moved from its api container to here: one provider at a time, applying
 * one disables the others, and the switch is a stored choice rather than a call, so a Rancher that
 * is reinstalled comes back with the same provider. What has changed is where the choice lives. The
 * closet keeps it in `.env` beside a docker socket; there is no such place here, so it is a
 * ConfigMap in the workspace's namespace, which the tab can write and this can read.
 *
 * It runs in the manager and not in the browser, and that is not a preference. Every call below
 * needs an admin token for a Rancher that answers only inside this namespace. The browser reaches
 * that Rancher through the apiserver's service proxy, and its Authorization header belongs to the
 * Rancher this product is served from: there is no second one to send. The manager already holds
 * the password by secretKeyRef, already reaches Keycloak's admin API and OpenLDAP's port, and is
 * already where the first bootstrap happens.
 *
 * Status goes back into the same ConfigMap, so the card can say what happened without holding a
 * token either.
 */
export const AUTH_SCRIPT = `#!/bin/sh
# Tracing off for all of it: every call carries a password or a token.
CM=dev-auth
RURL="https://rancher-vc.$NS.svc"

# Two addresses for each provider, and they are not interchangeable.
#
#   *_SEED is how this pod reaches it: an ordinary Service name in this namespace, used to create a
#   realm or a directory entry.
#   what Rancher is given is different, because Rancher runs inside the vcluster and its DNS is not
#   this cluster's. For LDAP that is the host Service's ClusterIP, looked up below (see
#   VCLUSTER_VALUES for why it is not a replicated Service). For OIDC it is the node's address,
#   because the browser is part of that exchange and the node is the only address both can use.
KC_SEED="http://$NS-keycloak.$NS.svc:8080"
LDAP_SEED="$NS-openldap.$NS.svc"
LDAP_BASE="dc=dev,dc=local"
LDAP_ADMIN="cn=admin,dc=dev,dc=local"

now() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# Status back to the object the request came from, so the card reads the outcome from the same
# place it wrote the request. Message stays plain text: it goes through a JSON merge patch.
say() {
  kubectl -n "$NS" patch cm "$CM" --type merge \\
    -p "{\\"data\\":{\\"applied\\":\\"$1\\",\\"message\\":\\"$2\\",\\"at\\":\\"$(now)\\"}}" >/dev/null 2>&1
  echo "auth: [$1] $2"
}

admin_token() {
  curl -sk --max-time 20 -o /tmp/auth-login.json \\
    -X POST "$RURL/v3-public/localProviders/local?action=login" \\
    -H 'content-type: application/json' \\
    -d "{\\"username\\":\\"admin\\",\\"password\\":\\"$CATTLE_BOOTSTRAP_PASSWORD\\"}" >/dev/null 2>&1
  tr ',' '\\n' < /tmp/auth-login.json | sed -n 's/.*"token":"\\([^"]*\\)".*/\\1/p' | head -1
}

# Rancher enables one provider at a time, so applying one is also disabling the other. Reading
# first, because disable on an already-disabled provider is an error rather than a no-op.
disable_provider() {
  if curl -sk --max-time 20 -H "Authorization: Bearer $TOKEN" "$RURL/v3/$1/$2" | grep -q '"enabled":true'; then
    curl -sk --max-time 20 -o /dev/null -X POST -H "Authorization: Bearer $TOKEN" "$RURL/v3/$1/$2?action=disable"
    echo "auth: disabled $2"
  fi
}

# ---- openldap ----
#
# The directory is empty when it starts, so there is nobody to sign in as until this runs. The
# closet's api does exactly this with the same ldap tools. -c so that an entry that is already
# there does not stop the next one, and ldappasswd afterwards so the entry always carries the
# password that is in the store rather than the one it was created with.
seed_ldap() {
  cat > /tmp/seed.ldif <<LDIF
dn: ou=users,$LDAP_BASE
objectClass: organizationalUnit
ou: users

dn: uid=user1,ou=users,$LDAP_BASE
objectClass: inetOrgPerson
cn: user1
sn: One
uid: user1
userPassword: $AUTH_USER_PASSWORD
LDIF
  chmod 600 /tmp/seed.ldif
  ldapadd -c -x -H "ldap://$LDAP_SEED:389" -D "$LDAP_ADMIN" -w "$OPENLDAP_ADMIN_PASSWORD" \\
    -f /tmp/seed.ldif >/dev/null 2>&1
  rm -f /tmp/seed.ldif
  ldappasswd -x -H "ldap://$LDAP_SEED:389" -D "$LDAP_ADMIN" -w "$OPENLDAP_ADMIN_PASSWORD" \\
    -s "$AUTH_USER_PASSWORD" "uid=user1,ou=users,$LDAP_BASE" >/dev/null 2>&1
  # What decides is whether the entry is there, not what ldapadd returned: the usual outcome is a
  # non-zero exit because one of the two entries already existed.
  ldapsearch -x -H "ldap://$LDAP_SEED:389" -D "$LDAP_ADMIN" -w "$OPENLDAP_ADMIN_PASSWORD" \\
    -b "ou=users,$LDAP_BASE" "(uid=user1)" 2>/dev/null | grep -q '^uid: user1'
}

apply_openldap() {
  if [ -z "$OPENLDAP_ADMIN_PASSWORD" ] || [ -z "$AUTH_USER_PASSWORD" ]; then
    say "" "openldap: its passwords are not in the secret store"
    return 1
  fi

  if ! seed_ldap; then
    say "" "openldap: could not create uid=user1 in the directory"
    return 1
  fi

  # The address Rancher gets. Read now rather than held anywhere, because a Service that is deleted
  # and recreated has a different one and this is the moment it matters.
  LDAP_FOR_RANCHER=$(kubectl -n "$NS" get svc "$NS-openldap" -o jsonpath='{.spec.clusterIP}' 2>/dev/null)

  if [ -z "$LDAP_FOR_RANCHER" ]; then
    say "" "openldap: it has no Service, so Rancher has no address for it"
    return 1
  fi

  cat > /tmp/ldap.json <<JSON
{"type":"openLdapConfig","id":"openldap","enabled":true,"accessMode":"unrestricted",
"servers":["$LDAP_FOR_RANCHER"],"port":389,"tls":false,"starttls":false,
"serviceAccountDistinguishedName":"$LDAP_ADMIN","serviceAccountPassword":"$OPENLDAP_ADMIN_PASSWORD",
"userSearchBase":"ou=users,$LDAP_BASE","userObjectClass":"inetOrgPerson","userLoginAttribute":"uid",
"userNameAttribute":"cn","userMemberAttribute":"memberOf","userSearchAttribute":"uid|sn|givenName",
"groupSearchBase":"ou=users,$LDAP_BASE","groupObjectClass":"groupOfNames","groupNameAttribute":"cn",
"groupMemberMappingAttribute":"member","groupMemberUserAttribute":"entryDN","groupDNAttribute":"entryDN",
"groupSearchAttribute":"cn","disabledStatusBitmask":0,"nestedGroupMembershipEnabled":false,
"connectionTimeout":5000}
JSON
  chmod 600 /tmp/ldap.json
  CODE=$(curl -sk --max-time 60 -o /tmp/ldap-put.json -w '%{http_code}' \\
    -X PUT "$RURL/v3/openLdapConfigs/openldap" \\
    -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' -d @/tmp/ldap.json)
  rm -f /tmp/ldap.json

  case "$CODE" in
    2*) ;;
    *) say "" "openldap: this Rancher would not take the config (HTTP $CODE)"; return 1 ;;
  esac

  # The PUT succeeding only means Rancher stored it. A login as user1 is the thing that proves
  # Rancher can bind, search and authenticate, which is what the person pressing Apply is asking.
  curl -sk --max-time 30 -o /tmp/ldap-user.json \\
    -X POST "$RURL/v3-public/openLdapProviders/openldap?action=login" \\
    -H 'content-type: application/json' \\
    -d "{\\"username\\":\\"user1\\",\\"password\\":\\"$AUTH_USER_PASSWORD\\",\\"responseType\\":\\"token\\"}" >/dev/null 2>&1

  if ! grep -q '"token"' /tmp/ldap-user.json; then
    say "" "openldap: enabled, but signing in as user1 did not work"
    return 1
  fi

  say "openldap" "Rancher is using OpenLDAP. Sign in as user1."
}

# ---- keycloak (OIDC) ----
#
# The browser takes part in this one, so the issuer has to be an address the browser can reach and
# the same address Rancher fetches the discovery document from. Inside a vcluster there is exactly
# one such address, the node's, which is why the keycloak sidecar declares a node port.
apply_keycloak() {
  if [ -z "$KEYCLOAK_ADMIN_PASSWORD" ] || [ -z "$KEYCLOAK_CLIENT_SECRET" ] || [ -z "$AUTH_USER_PASSWORD" ]; then
    say "" "keycloak: its secrets are not in the secret store"
    return 1
  fi

  KCPORT=$(kubectl -n "$NS" get svc "$NS-keycloak" -o jsonpath='{.spec.ports[0].nodePort}' 2>/dev/null)
  WSPORT=$(kubectl -n "$NS" get svc "$NS" -o jsonpath='{.spec.ports[0].nodePort}' 2>/dev/null)

  if [ -z "$KCPORT" ] || [ -z "$NODE_IP" ]; then
    say "" "keycloak: it has no node port, so no address a browser and Rancher can share"
    return 1
  fi

  if [ -z "$WSPORT" ]; then
    say "" "keycloak: this workspace has no node port to be sent back to after signing in"
    return 1
  fi

  ISSUER="http://$NODE_IP:$KCPORT/realms/rancher"
  RETURN_URL="https://$NODE_IP:$WSPORT/verify-auth"

  KT=$(curl -s --max-time 20 "$KC_SEED/realms/master/protocol/openid-connect/token" \\
    -d client_id=admin-cli -d username=admin -d grant_type=password \\
    --data-urlencode "password=$KEYCLOAK_ADMIN_PASSWORD" \\
    | tr ',' '\\n' | sed -n 's/.*"access_token":"\\([^"]*\\)".*/\\1/p' | head -1)

  if [ -z "$KT" ]; then
    say "" "keycloak: could not log in to its admin API as admin"
    return 1
  fi

  # Realm, client and user, each create-if-missing and then updated, so a second Apply repairs a
  # realm somebody has edited rather than failing on the 409.
  curl -s -o /dev/null -X POST "$KC_SEED/admin/realms" -H "Authorization: Bearer $KT" \\
    -H 'content-type: application/json' \\
    -d '{"realm":"rancher","enabled":true,"sslRequired":"none"}'

  printf '{"clientId":"rancher","enabled":true,"protocol":"openid-connect","publicClient":false,"standardFlowEnabled":true,"directAccessGrantsEnabled":true,"secret":"%s","redirectUris":["%s","*"],"webOrigins":["*"]}' \\
    "$KEYCLOAK_CLIENT_SECRET" "$RETURN_URL" > /tmp/kc-client.json
  chmod 600 /tmp/kc-client.json
  CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$KC_SEED/admin/realms/rancher/clients" \\
    -H "Authorization: Bearer $KT" -H 'content-type: application/json' -d @/tmp/kc-client.json)

  if [ "$CODE" = "409" ]; then
    CID=$(curl -s -H "Authorization: Bearer $KT" "$KC_SEED/admin/realms/rancher/clients?clientId=rancher" \\
      | tr ',' '\\n' | sed -n 's/.*"id":"\\([^"]*\\)".*/\\1/p' | head -1)
    curl -s -o /dev/null -X PUT "$KC_SEED/admin/realms/rancher/clients/$CID" \\
      -H "Authorization: Bearer $KT" -H 'content-type: application/json' -d @/tmp/kc-client.json
  fi
  rm -f /tmp/kc-client.json

  printf '{"username":"user1","enabled":true,"email":"user1@dev.local","emailVerified":true,"firstName":"User","lastName":"One","credentials":[{"type":"password","value":"%s","temporary":false}]}' \\
    "$AUTH_USER_PASSWORD" > /tmp/kc-user.json
  chmod 600 /tmp/kc-user.json
  CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$KC_SEED/admin/realms/rancher/users" \\
    -H "Authorization: Bearer $KT" -H 'content-type: application/json' -d @/tmp/kc-user.json)

  if [ "$CODE" = "409" ]; then
    UID1=$(curl -s -H "Authorization: Bearer $KT" "$KC_SEED/admin/realms/rancher/users?username=user1" \\
      | tr ',' '\\n' | sed -n 's/.*"id":"\\([^"]*\\)".*/\\1/p' | head -1)
    printf '{"type":"password","value":"%s","temporary":false}' "$AUTH_USER_PASSWORD" > /tmp/kc-pw.json
    chmod 600 /tmp/kc-pw.json
    curl -s -o /dev/null -X PUT "$KC_SEED/admin/realms/rancher/users/$UID1/reset-password" \\
      -H "Authorization: Bearer $KT" -H 'content-type: application/json' -d @/tmp/kc-pw.json
    rm -f /tmp/kc-pw.json
  fi
  rm -f /tmp/kc-user.json

  # Rancher validates this one itself: it fetches the discovery document from the issuer as it
  # stores the config, so a non-2xx here is Rancher saying it could not reach Keycloak.
  printf '{"type":"keyCloakOIDCConfig","id":"keycloakoidc","enabled":true,"accessMode":"unrestricted","clientId":"rancher","clientSecret":"%s","issuer":"%s","authEndpoint":"%s/protocol/openid-connect/auth","rancherUrl":"%s","scope":"openid profile email"}' \\
    "$KEYCLOAK_CLIENT_SECRET" "$ISSUER" "$ISSUER" "$RETURN_URL" > /tmp/kc-oidc.json
  chmod 600 /tmp/kc-oidc.json
  CODE=$(curl -sk --max-time 60 -o /tmp/kc-oidc-put.json -w '%{http_code}' \\
    -X PUT "$RURL/v3/keyCloakOIDCConfigs/keycloakoidc" \\
    -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' -d @/tmp/kc-oidc.json)
  rm -f /tmp/kc-oidc.json

  case "$CODE" in
    2*) say "keycloak-oidc" "Rancher is using Keycloak OIDC at $ISSUER. Sign in as user1." ;;
    *) say "" "keycloak: this Rancher would not take the OIDC config (HTTP $CODE)"; return 1 ;;
  esac
}

# The ConfigMap is created here rather than only by the tab, so that a workspace whose auth has
# never been touched still has somewhere for this to report to.
kubectl -n "$NS" get cm "$CM" >/dev/null 2>&1 || \\
  kubectl -n "$NS" create cm "$CM" --from-literal=provider= >/dev/null 2>&1

# A sentinel that no provider can equal, so the first pass always applies whatever is asked for,
# including nothing. A failed apply leaves it alone, which is what makes this retry.
LAST=__unread__

while true; do
  WANT=$(kubectl -n "$NS" get cm "$CM" -o jsonpath='{.data.provider}' 2>/dev/null)

  if [ "$WANT" != "$LAST" ]; then
    TOKEN=$(admin_token)

    if [ -z "$TOKEN" ]; then
      say "" "cannot sign in to this workspace's Rancher as admin"
    else
      case "$WANT" in
        openldap)
          disable_provider keyCloakOIDCConfigs keycloakoidc
          apply_openldap && LAST="$WANT"
          ;;
        keycloak-oidc)
          disable_provider openLdapConfigs openldap
          apply_keycloak && LAST="$WANT"
          ;;
        '')
          disable_provider keyCloakOIDCConfigs keycloakoidc
          disable_provider openLdapConfigs openldap
          say "" "local users only"
          LAST="$WANT"
          ;;
        *)
          say "" "no idea what provider [$WANT] is"
          LAST="$WANT"
          ;;
      esac
    fi
  fi

  sleep 20
done
`;

/**
 * What a stop has to do, beyond scaling this pod to nothing.
 *
 * The vcluster is a StatefulSet and a Deployment of its own, installed by helm from inside this
 * pod, so nothing about scaling the manager touches them. Without this, Stop would leave a k3s
 * control plane and a whole Rancher running in the namespace with no card admitting to it.
 */
export const PAUSE_SCRIPT = `#!/bin/sh
kubectl -n "$NS" scale deploy vc --replicas=0 2>/dev/null
kubectl -n "$NS" scale sts vc --replicas=0 2>/dev/null
kubectl -n "$NS" delete pods -l vcluster.loft.sh/managed-by=vc --wait=false
`;

/**
 * The chart's vcluster chart version, and the rights its manager needs.
 *
 * The rules are the chart's `rancher-manager` Role verbatim: namespaced, but everything within the
 * namespace including RBAC, because a helm install of vcluster creates a ServiceAccount, a Role
 * and a RoleBinding of its own. Kubernetes' aggregated `edit` role, which is what an ordinary
 * workspace pod gets, deliberately excludes RBAC, so a manager running as that account fails
 * part-way through the install with a message about roles.
 */
export const VCLUSTER_VERSION = '0.36.0';

export const MANAGER_RULES = [{
  apiGroups: [
    '', 'apps', 'batch', 'networking.k8s.io', 'rbac.authorization.k8s.io',
    'policy', 'coordination.k8s.io', 'events.k8s.io', 'discovery.k8s.io',
  ],
  resources: ['*'],
  verbs:     ['*'],
}];
