/**
 * The cluster an app provisions, when the app does not describe one itself.
 *
 * Two documents rather than one, because a cluster Rancher can actually build is two objects: a
 * machine config saying what a node is, and a Cluster with a pool pointing at it. The renderer
 * applies them in order, so the config exists before the pool references it.
 *
 * It was a single custom cluster before - no machinePools, no credential, Rancher publishing a
 * registration command instead of driving a cloud API. That is a real Rancher shape and it is
 * the wrong default here, because nothing completes it: a custom cluster becomes Ready only
 * when somebody runs the registration command on a machine, and an app that provisions its own
 * cluster has no machine to run it on. What it produced was a Cluster that sat at "waiting for
 * at least one control plane, etcd, and worker node to be registered" for ever.
 *
 * The values below are the ones the dev-extension's own EC2 action uses against this Rancher,
 * copied rather than invented so that the default is a shape known to work here. Every one of
 * them is a `${...}`, so an app that wants a different instance type, region or VPC overrides a
 * value rather than rewriting the template - and an app that wants a different provider
 * entirely replaces the template, which is what `clusterTemplate` on the App is for.
 */
export const DEFAULT_CLUSTER_TEMPLATE = `apiVersion: rke-machine-config.cattle.io/v1
kind: Amazonec2Config
metadata:
  name: \${cluster}-machine
region: \${region}
zone: \${zone}
instanceType: \${instanceType}
rootSize: "\${rootSize}"
securityGroup:
  - default
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
      - name: pool1
        controlPlaneRole: true
        etcdRole: true
        workerRole: true
        quantity: 1
        machineConfigRef:
          kind: Amazonec2Config
          name: \${cluster}-machine
`;

/**
 * What the template above resolves to when nobody says otherwise.
 *
 * `vpcId` and `subnetId` are the two that belong to this Rancher's AWS account rather than to
 * this extension, and they are here for the same reason the rest is: a default that provisions
 * beats a default that is neutral and cannot. An app deploying into a different account
 * overrides them, and the form will ask for them if they are ever blanked.
 *
 * `cloudCredential` is deliberately absent. It is the id of a credential configured in Rancher,
 * which no default can know, so it is resolved at render time from the credentials that exist -
 * see cloudCredentialId in models/appsplus.io.appinstance.js.
 */
export const DEFAULT_CLUSTER_VALUES = {
  kubernetesVersion: 'v1.34.4+rke2r1',
  cni:               'canal',
  region:            'us-west-2',
  zone:              'a',
  instanceType:      'c5d.xlarge',
  rootSize:          '50',
  vpcId:             'vpc-0c618e3a2ec9df47b',
  subnetId:          'subnet-0c97a9f441ca3c895',
};

/** The driver a credential must be for, to build the default template's machine config. */
export const DEFAULT_CLUSTER_DRIVER = 'amazonec2';
