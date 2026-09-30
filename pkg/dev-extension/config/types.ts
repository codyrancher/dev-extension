// Every name this extension shares between its product, its routes and its models.
//
// Two of them are Steve type ids rather than Kubernetes ones: Steve names a type
// `<group>.<kind lowercased>`, so the CRD `apps.appsplus.io` is `appsplus.io.app` here.

export const PRODUCT_NAME = 'apps-plus';

// A product with no cluster of its own still needs a `:cluster` param. `_` is the shell's
// placeholder for "none", exported as BLANK_CLUSTER from @shell/store/store-types.
export const BLANK_CLUSTER = '_';

export const APP = 'appsplus.io.app';
export const APP_INSTANCE = 'appsplus.io.appinstance';

export const CRD = 'apiextensions.k8s.io.customresourcedefinition';

/**
 * The Steve type id for a Kubernetes manifest, by the same rule as the ids above.
 *
 * Steve names a type `<group>.<kind lowercased>`, so `rke-machine-config.cattle.io/v1` +
 * `Amazonec2Config` is `rke-machine-config.cattle.io.amazonec2config`. A core-group manifest
 * (`apiVersion: v1`) has no group and is just its kind.
 */
export function steveType(manifest: { apiVersion?: string; kind?: string }): string {
  const kind = (manifest?.kind || '').toLowerCase();
  const group = (manifest?.apiVersion || '').split('/')[0];

  return group && group !== 'v1' ? `${ group }.${ kind }` : kind;
}

// Fleet is what actually deploys an instance. An App Instance renders its App's templates
// into a Bundle, and Fleet's agent on each target cluster applies it and reports back.
export const FLEET_BUNDLE = 'fleet.cattle.io.bundle';
export const FLEET_CLUSTER = 'fleet.cattle.io.cluster';

// One BundleDeployment per cluster a Bundle reaches, living in that cluster's own Fleet
// namespace. It is the only place that says what actually landed on a downstream cluster and
// how it is doing - the Bundle above it only aggregates counts.
export const FLEET_BUNDLE_DEPLOYMENT = 'fleet.cattle.io.bundledeployment';

// The Bundle an instance owns is named after it, so the pair can be found from either side
// without a label selector.
export const BUNDLE_PREFIX = 'apps-plus-';

// The Fleet workspace to fall back to when the target cluster cannot be resolved to one.
// fleet-local is the workspace holding the Rancher-local cluster.
export const DEFAULT_WORKSPACE = 'fleet-local';

// Rancher's own cluster API, and the workspace a cluster this extension provisions is created
// in. A provisioning.cattle.io Cluster's namespace *is* its Fleet workspace, which is what lets
// an instance write its Bundle before the cluster exists: the workspace is known up front
// rather than looked up from a Fleet Cluster object that has not been created yet.
export const PROVISIONING_CLUSTER = 'provisioning.cattle.io.cluster';
export const PROVISION_WORKSPACE = 'fleet-default';

// Where the registration command for a custom cluster lives. Rancher puts one of these in the
// management cluster's own namespace, which is the provisioning cluster's status.clusterName.
export const REGISTRATION_TOKEN = 'management.cattle.io.clusterregistrationtoken';

export const DEFAULT_TARGET_NAMESPACE = 'default';

// The shell's generic resource routes. A product page reaches them with its own product name
// in the params, so none of these are registered by this extension.
export const LIST_ROUTE = 'c-cluster-product-resource';
export const CREATE_ROUTE = 'c-cluster-product-resource-create';
export const DETAIL_ROUTE = 'c-cluster-product-resource-id';

// Which App a "Create Instance" button was pressed on, carried to the create form.
export const APP_QUERY = 'app';

// The identifier the builder's table action registers under, so this product's own models can
// recognise it and leave it off their rows - staging an App into an App is meaningless, and
// action registration has no way to say "every type but ours".
export const ADD_TO_APP_ACTION = 'apps-plus-add-to-app';
