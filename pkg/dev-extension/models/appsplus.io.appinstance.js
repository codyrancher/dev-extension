import jsyaml from 'js-yaml';
import SteveModel from '@shell/plugins/steve/steve-class';
import {
  APP, FLEET_BUNDLE, FLEET_BUNDLE_DEPLOYMENT, FLEET_CLUSTER, BUNDLE_PREFIX, DEFAULT_WORKSPACE,
  DEFAULT_TARGET_NAMESPACE,
  PROVISIONING_CLUSTER, PROVISION_WORKSPACE, PRODUCT_NAME, BLANK_CLUSTER, LIST_ROUTE, steveType,
  ADD_TO_APP_ACTION
} from '../config/types';
import { NORMAN } from '@shell/config/types';
import {
  DEFAULT_CLUSTER_TEMPLATE, DEFAULT_CLUSTER_VALUES, DEFAULT_CLUSTER_DRIVER
} from '../config/cluster-template';
import {
  renderTemplates, mergeValues, substitute, missingValues, isSet
} from '../render';

/**
 * What keeps a deleted installation in the list until its things are gone.
 *
 * Its own domain, as Kubernetes requires of anything that is not a core finalizer, so it is
 * obvious in `kubectl get -o yaml` whose it is and what to remove by hand if this extension is
 * ever uninstalled while something is mid-delete.
 */
const FINALIZER = 'appsplus.io/cleanup';

/**
 * An AppInstance is one deployment of an App, and it owns everything it creates.
 *
 * There is no controller behind these CRDs. Saving an instance is what writes the Fleet
 * Bundle - and, if the instance provisions its own cluster, the provisioning.cattle.io Cluster
 * too. Fleet's controllers and Rancher's provisioner do everything after that.
 *
 * Both of those carry an ownerReference back to the instance, so deleting an instance removes
 * what it deployed *and the cluster it brought with it*. That is deliberate and it is
 * destructive, which is why `confirmRemove` below makes Rancher demand the name be typed.
 * (A namespaced dependent may name a cluster-scoped owner; the reverse is what is disallowed.)
 *
 * One instance owns at most one cluster.
 */
export default class AppInstance extends SteveModel {
  /** No detail-page cards - same reasoning as on the App model: showing any invites the
   * shell's stock "Extras" card in beside them. */
  get cards() {
    return [];
  }

  get app() {
    const name = this.spec?.app;

    if (!name) {
      return null;
    }

    try {
      return this.$rootGetters['management/all'](APP)
        .find((app) => app.metadata?.name === name) || null;
    } catch {
      return null;
    }
  }

  get appDisplay() {
    return this.app?.nameDisplay || this.spec?.app || '—';
  }

  /**
   * Where saving, cancelling or going back from one of these lands.
   *
   * Apps and Installations, not this type's own list. `configureType` makes AppInstance a real
   * type so it can be created, edited and shown as YAML, and the shell gives every real type a
   * generic list route whether or not anything links to it - a flat, ungrouped Installations
   * page that is a second description of the rows already grouped under their apps. Nothing
   * points at it deliberately; saving did, which is how anybody found it.
   *
   * Four hooks because the shell asks the question four different ways, and each one is reached
   * by a different button:
   *
   *   doneRoute / doneParams  Save, through the create-edit-view mixin's `done()`. A route
   *                           *name* and its params, not a location.
   *   doneOverride            Cancel. CruResource routes itself unless it is given
   *                           `cancel-event`, and `@cancel="done"` on the form is never
   *                           reached - see emitOrRoute in components/CruResource.vue.
   *   listLocation            The breadcrumb and the resource header.
   *
   * Setting one of them sends the other three somewhere else, which is how Save could be fixed
   * and Cancel go on landing on a page nothing links to.
   */
  get doneRoute() {
    return LIST_ROUTE;
  }

  get doneParams() {
    return {
      product: PRODUCT_NAME, cluster: BLANK_CLUSTER, resource: APP
    };
  }

  get listLocation() {
    return { name: LIST_ROUTE, params: this.doneParams };
  }

  get doneOverride() {
    return this.listLocation;
  }

  /** The group this row sits under in the Apps and Installations list. */
  get groupById() {
    return this.spec?.app || '';
  }

  get targetNamespace() {
    return this.spec?.namespace || DEFAULT_TARGET_NAMESPACE;
  }

  // ---------------------------------------------------------------- provisioning

  get provisionsCluster() {
    return !!this.spec?.provisionCluster?.enabled;
  }

  /** The cluster this instance owns. Named after the instance unless it says otherwise. */
  get clusterName() {
    return this.spec?.provisionCluster?.name || this.metadata?.name;
  }

  /**
   * Where this instance deploys, as everything else should read it.
   *
   * An instance that provisions a cluster deploys to that one cluster and nothing else - the
   * target picker is not offered in that case - so the two ways of choosing a target collapse
   * into one list here rather than at every call site.
   */
  get effectiveTargets() {
    if (this.provisionsCluster) {
      return [{ clusterName: this.clusterName }];
    }

    return (this.spec?.targets || [])
      .filter((target) => target?.clusterName)
      .map((target) => ({ clusterName: target.clusterName }));
  }

  get targetClusterNames() {
    return this.effectiveTargets.map((target) => target.clusterName);
  }

  get targetDisplay() {
    return this.targetClusterNames.join(', ') || '—';
  }

  get provisionedCluster() {
    if (!this.provisionsCluster) {
      return null;
    }

    try {
      return this.$rootGetters['management/all'](PROVISIONING_CLUSTER)
        .find((cluster) => cluster.metadata?.name === this.clusterName &&
          cluster.metadata?.namespace === PROVISION_WORKSPACE) || null;
    } catch {
      return null;
    }
  }

  get clusterReady() {
    return !!this.provisionedCluster?.status?.ready;
  }

  /** The namespace Rancher gives the management side of a provisioned cluster. */
  get managementClusterNamespace() {
    return this.provisionedCluster?.status?.clusterName || null;
  }

  /**
   * Whether this installation's cluster is one somebody has to bring nodes to.
   *
   * A cluster with no machine pools is a *custom* cluster: Rancher publishes a registration
   * command and waits, and nothing else will ever make it Ready. One with pools is driven by a
   * cloud credential and registers its own nodes, and the registration command Rancher still
   * publishes for it is noise - showing it there reads as an instruction, which is how a
   * cluster that is provisioning normally looks like a cluster that is stuck.
   */
  get needsNodesRegistered() {
    if (!this.provisionsCluster) {
      return false;
    }

    return !(this.provisionedCluster?.spec?.rkeConfig?.machinePools || []).length;
  }

  // ---------------------------------------------------------------- rendering

  /**
   * What this instance still owes its app: values the templates refer to, that the app has no
   * default for, and that this instance has not supplied.
   *
   * Non-empty means the instance cannot be rendered at all - substitution would leave `${name}`
   * sitting in the YAML - so it is held back rather than deployed broken.
   */
  get missingValues() {
    return missingValues(this.app, this);
  }

  get needsAttention() {
    return this.missingValues.length > 0;
  }

  get renderedResources() {
    return renderTemplates(this.app, this);
  }

  /** The cluster manifest this instance would create, with values substituted. */
  get renderedClusterTemplate() {
    if (!this.provisionsCluster) {
      return '';
    }

    const source = this.app?.spec?.clusterTemplate?.trim() || DEFAULT_CLUSTER_TEMPLATE;

    return substitute(source, { ...DEFAULT_CLUSTER_VALUES, ...mergeValues(this.app, this) });
  }

  // ---------------------------------------------------------------- state

  get bundleName() {
    return `${ BUNDLE_PREFIX }${ this.metadata?.name }`;
  }

  /**
   * Every Bundle this instance owns. There is one per Fleet workspace the targets fall in,
   * because a Bundle can only reach clusters in its own workspace.
   */
  get bundles() {
    try {
      return this.$rootGetters['management/all'](FLEET_BUNDLE)
        .filter((bundle) => bundle.metadata?.name === this.bundleName);
    } catch {
      return [];
    }
  }

  get bundle() {
    return this.bundles[0] || null;
  }

  /**
   * What actually landed, per cluster.
   *
   * The resources an instance deploys live on the *downstream* clusters, so nothing in the
   * local cluster lists them and the shell's own Related Resources tab - which only ever looks
   * where the instance itself is - cannot show them. Fleet's BundleDeployment is the one
   * record that crosses the gap: there is one per cluster the Bundle reaches, in that
   * cluster's Fleet namespace, and it names every resource applied there.
   */
  /**
   * The glance line under the title: what this is an installation of, where it went, and the
   * Bundle carrying it. The same four facts the page used to repeat in a row of its own - the
   * masthead already has a place for them, and it lines them up with Age and the labels.
   */
  get details() {
    const t = this.$rootGetters['i18n/t'];
    const link = (to, content) => (to ? {
      formatter:     'Link',
      formatterOpts: { to, row: {}, options: { internal: true } },
      content,
    } : { content });

    return [
      { label: t('appsPlus.instance.app'), ...link(this.app?.detailLocation, this.appDisplay) },
      {
        label: t(this.provisionsCluster ? 'appsPlus.instance.ownedCluster' : 'appsPlus.instance.targets'),
        ...link(this.provisionedCluster?.detailLocation, this.targetDisplay),
      },
      { label: t('appsPlus.instance.namespace'), content: this.targetNamespace },
      {
        label: t('appsPlus.instance.bundle'),
        ...link(
          this.bundle?.detailLocation,
          this.bundleSummary ? `${ this.bundleName } (${ this.readyDisplay } ready)` : this.bundleName,
        ),
      },
    ];
  }

  get bundleDeployments() {
    try {
      return this.$rootGetters['management/all'](FLEET_BUNDLE_DEPLOYMENT)
        .filter((deployment) => deployment.metadata?.name === this.bundleName);
    } catch {
      return [];
    }
  }

  /**
   * One row per deployed resource, carrying the cluster it is on.
   *
   * A resource Fleet is unhappy about is listed in `nonReadyStatus` with a message; everything
   * else it applied is ready, so the two lists together are the state of the deployment.
   */
  get deployedResources() {
    return this.bundleDeployments.flatMap((deployment) => {
      const labels = deployment.metadata?.labels || {};
      const clusterName = labels['fleet.cattle.io/cluster'] || '';
      const clusterNamespace = labels['fleet.cattle.io/cluster-namespace'] || '';
      const notReady = {};

      (deployment.status?.nonReadyStatus || []).forEach((entry) => {
        const key = `${ entry.kind }/${ entry.namespace || '' }/${ entry.name }`;

        notReady[key] = (entry.summary?.message || []).join(', ') || entry.summary?.state || '';
      });

      return (deployment.status?.resources || []).map((resource) => {
        const key = `${ resource.kind }/${ resource.namespace || '' }/${ resource.name }`;
        const message = notReady[key];

        return {
          key:      `${ clusterName }/${ key }`,
          kind:     resource.kind,
          name:     resource.name,
          namespace: resource.namespace || '',
          apiVersion: resource.apiVersion || '',
          clusterName,
          clusterNamespace,
          message:  message || '',
          ready:    !message,
        };
      });
    });
  }

  /** The Bundle summaries added up, so an instance spanning two workspaces reads as one. */
  get bundleSummary() {
    const summaries = this.bundles
      .map((bundle) => bundle.status?.summary)
      .filter((summary) => !!summary);

    if (!summaries.length) {
      return null;
    }

    return summaries.reduce((acc, summary) => ({
      desiredReady: (acc.desiredReady || 0) + (summary.desiredReady || 0),
      ready:        (acc.ready || 0) + (summary.ready || 0),
      errApplied:   (acc.errApplied || 0) + (summary.errApplied || 0),
    }), {});
  }

  get readyDisplay() {
    const summary = this.bundleSummary;

    if (!summary) {
      return '—';
    }

    return `${ summary.ready || 0 }/${ summary.desiredReady || 0 }`;
  }

  /**
   * Overridden because these CRDs have no controller and so never get a status Steve could
   * derive a state from. What the row should say is what Rancher and Fleet say about the two
   * things this instance owns - and the cluster comes first, because until it is up there is
   * nothing for the Bundle's answer to mean.
   */
  get state() {
    if (this.metadata?.deletionTimestamp) {
      return 'removing';
    }

    // Ahead of everything else, because it is the only state a person has to act on: whatever
    // Fleet is doing, this instance is running an older render until its values are answered.
    if (this.needsAttention) {
      return 'warning';
    }

    if (this.provisionsCluster && !this.clusterReady) {
      return 'provisioning';
    }

    const summary = this.bundleSummary;

    if (!summary) {
      return this.targetClusterNames.length ? 'pending' : 'notapplied';
    }

    if (summary.errApplied > 0) {
      return 'error';
    }

    if (summary.desiredReady > 0 && summary.ready === summary.desiredReady) {
      return 'active';
    }

    return 'pending';
  }

  get stateDescription() {
    if (this.isTerminating) {
      return this.provisionsCluster ?
        `Waiting for the cluster ${ this.clusterName } and everything it deployed to be removed.` :
        'Waiting for what it deployed to be removed.';
    }

    const missing = this.missingValues;

    if (missing.length) {
      return `The app's templates need ${ missing.join(', ') }. Edit this instance to supply ` +
        `${ missing.length > 1 ? 'them' : 'it' }; until then it keeps running its last deploy.`;
    }

    if (this.provisionsCluster && !this.clusterReady) {
      const cluster = this.provisionedCluster;

      if (!cluster) {
        return `Waiting for the cluster ${ this.clusterName } to be created.`;
      }

      const waiting = (cluster.status?.conditions || [])
        .find((condition) => condition.type === 'Ready' && condition.status !== 'True');

      return waiting?.message || `Cluster ${ this.clusterName } is still coming up.`;
    }

    const messages = this.bundles
      .flatMap((bundle) => bundle.status?.conditions || [])
      .filter((condition) => condition.status === 'False' && condition.message)
      .map((condition) => condition.message);

    if (messages.length) {
      return messages.join('; ');
    }

    if (!this.targetClusterNames.length) {
      return 'No target clusters selected.';
    }

    return this.bundles.length ? '' : 'Waiting for the Fleet bundle to be created.';
  }

  // ---------------------------------------------------------------- reconciliation

  /**
   * Save the instance, then make what it owns match it.
   *
   * The order matters on create: an ownerReference needs the instance's uid, which only
   * exists once the instance has been written. The cluster goes first because the Bundle
   * targets it - though the Bundle does not wait for it, see syncBundle.
   */
  async save(opt) {
    this.ensureFinalizer();

    const saved = await super.save(opt);

    await this.reconcile();

    return saved;
  }

  /**
   * Keep this object alive until what it owns has actually gone.
   *
   * Without it, deleting an installation removes the row the instant the request is accepted,
   * while Kubernetes is still garbage-collecting the Bundle and - if it brought one - a cluster
   * that takes minutes to tear down. The list said the installation was gone and the EC2
   * instance was still running, which is the wrong way round: what somebody deleted is the
   * installation, and it is not finished until its things are.
   *
   * With the finalizer, a delete sets `deletionTimestamp` and the object stays, so `state`
   * reads `removing` and the row says Terminating - see releaseWhenEmpty for what takes it off
   * again.
   */
  ensureFinalizer() {
    const existing = this.metadata?.finalizers || [];

    if (!existing.includes(FINALIZER)) {
      this.metadata.finalizers = [...existing, FINALIZER];
    }
  }

  /** Whether this is on its way out and waiting for its own things to go. */
  get isTerminating() {
    return !!this.metadata?.deletionTimestamp;
  }

  /**
   * Let go, once there is nothing left to wait for.
   *
   * This is the half a controller would normally do, and it is done here for the same reason
   * everything else in this extension is: there is no controller behind these CRDs. The cost is
   * that a finalizer nobody removes is an object that never goes, so this has to be reached
   * from somewhere that runs whether or not the person who pressed Delete is still watching -
   * the list calls it for every terminating row on every refresh, so any open Apps and
   * Installations page finishes the job, for anybody's delete.
   *
   * Kubernetes has already deleted the dependents by ownerReference by the time they disappear;
   * this only decides when the row may go, and never deletes anything itself.
   */
  async releaseWhenEmpty() {
    if (!this.isTerminating || !(this.metadata?.finalizers || []).includes(FINALIZER)) {
      return false;
    }

    if (await this.hasRemainingResources()) {
      return false;
    }

    // A JSON patch, so `merge` stays false - `patch(data, opt, merge)` picks the content type
    // from it, and a merge patch cannot take one entry out of a list anyway.
    try {
      await this.patch([{
        op:    'replace',
        path:  '/metadata/finalizers',
        value: (this.metadata.finalizers || []).filter((f) => f !== FINALIZER),
      }]);
    } catch (e) {
      // Losing a race with another tab doing the same thing is not a failure - the finalizer is
      // off either way, which is all this was for - but anything else is worth saying out loud.
      // Swallowing it silently is why a patch sent with the wrong content type looked like a
      // row that simply never went away.
      console.warn(`apps-plus: could not release ${ this.metadata?.name }`, e); // eslint-disable-line no-console

      return false;
    }

    return true;
  }

  /**
   * Whether anything this installation owns is still standing.
   *
   * Asked of the cluster by id and of the Bundles by workspace, both forced, because Steve's
   * collection cache lags a namespace by minutes - the same reason pruneBundles looks each one
   * up rather than listing. A stale "still there" only delays the row; a stale "all gone" would
   * drop it while the cluster was still up, which is the thing being fixed.
   */
  async hasRemainingResources() {
    if (this.provisionsCluster && await this.findCluster()) {
      return true;
    }

    for (const namespace of await this.candidateWorkspaces()) {
      if (await this.findBundle(namespace)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Make what this instance owns match it, unless it cannot be rendered.
   *
   * The guard is the whole point: an instance whose app asks for a value it does not have would
   * render `${name}` into the YAML and deploy that. Far better to leave the last good render in
   * place on the clusters and show a warning, so the deployed state is always something that
   * was once correct.
   *
   * Returns whether it actually reconciled, so callers can tell "up to date" from "held back".
   */
  async reconcile() {
    if (this.needsAttention) {
      return false;
    }

    await this.syncCluster();
    await this.syncBundle();

    return true;
  }

  get ownerReference() {
    return {
      apiVersion:         'appsplus.io/v1alpha1',
      kind:               'AppInstance',
      name:               this.metadata?.name,
      uid:                this.metadata?.uid,
      blockOwnerDeletion: true,
    };
  }

  async resolveApp() {
    if (this.app) {
      return this.app;
    }

    if (!this.spec?.app) {
      return null;
    }

    try {
      return await this.$dispatch('find', { type: APP, id: this.spec.app });
    } catch {
      return null;
    }
  }

  /**
   * Create or update the cluster this instance owns.
   *
   * The template supplies the spec; the metadata is this extension's, because the name, the
   * workspace and the ownerReference are what tie the cluster to the instance and are not the
   * template's to decide.
   *
   * Turning provisioning off does not delete the cluster. A save is not the place to destroy
   * one - deleting the instance is, and the ownerReference already handles that.
   */
  /**
   * The cloud credential the default template provisions with.
   *
   * Resolved rather than configured, because its id is generated by Rancher when somebody adds
   * a credential and no template can know it in advance. The first credential for the driver
   * wins; a cluster that needs a particular one says so by setting `cloudCredential` as a value
   * on the app or the installation, which overrides this.
   *
   * The id Rancher wants in `cloudCredentialSecretName` is the Norman one - `<namespace>:<name>`
   * - which is what this store hands back, and is not the `<namespace>/<name>` a Steve secret
   * would give.
   */
  async cloudCredentialId() {
    let credentials = [];

    try {
      credentials = await this.$dispatch('rancher/findAll', { type: NORMAN.CLOUD_CREDENTIAL }, { root: true });
    } catch {
      return '';
    }

    const match = (credentials || []).find((credential) => (
      !!credential?.[`${ DEFAULT_CLUSTER_DRIVER }credentialConfig`]
    ));

    return match?.id || '';
  }

  /**
   * Make the objects the cluster template describes match it.
   *
   * The template is a multi-document YAML file and every document is applied, in the order it
   * is written. That is not generality for its own sake: a cluster Rancher can build is a
   * machine config plus a Cluster whose pool references it by name, so one document was never
   * enough, and ordering matters because the reference has to resolve.
   *
   * Each document is created with an ownerReference back to this installation, so deleting the
   * installation takes the machine config with the cluster rather than leaving it behind.
   */
  async syncCluster() {
    if (!this.provisionsCluster) {
      return null;
    }

    const app = await this.resolveApp();
    const source = app?.spec?.clusterTemplate?.trim() || DEFAULT_CLUSTER_TEMPLATE;
    const values = { ...DEFAULT_CLUSTER_VALUES, ...mergeValues(app, this) };

    if (!isSet(values, 'cloudCredential')) {
      values.cloudCredential = await this.cloudCredentialId();
    }

    const rendered = substitute(source, values);
    let documents;

    try {
      documents = jsyaml.loadAll(rendered).filter((document) => !!document);
    } catch (error) {
      throw new Error(`The cluster template is not valid YAML: ${ error.message }`);
    }

    if (!documents.length) {
      throw new Error('The cluster template is empty.');
    }

    if (!documents.some((document) => document.kind === 'Cluster')) {
      throw new Error('The cluster template describes no Cluster: one document must be a provisioning.cattle.io Cluster.');
    }

    let cluster = null;

    for (const document of documents) {
      const saved = await this.applyClusterDocument(document);

      if (document.kind === 'Cluster') {
        cluster = saved;
      }
    }

    return cluster;
  }

  /**
   * One document from the cluster template, created or brought up to date.
   *
   * Everything outside `metadata` is copied across whole rather than picked field by field,
   * because these two objects do not agree on where their configuration lives: a Cluster keeps
   * it under `spec`, and a machine config keeps it at the top level with no spec at all. A
   * reader that knew about `spec` would silently write an empty machine config.
   */
  async applyClusterDocument(document) {
    const type = steveType(document);
    const name = document.metadata?.name || this.clusterName;
    const namespace = document.metadata?.namespace || PROVISION_WORKSPACE;
    const body = { ...document };

    delete body.apiVersion;
    delete body.kind;
    delete body.metadata;

    const existing = await this.findClusterObject(type, namespace, name);

    if (existing) {
      Object.assign(existing, body);

      return existing.save();
    }

    const created = await this.$dispatch('create', {
      type,
      metadata: {
        name,
        namespace,
        labels:          { ...(document.metadata?.labels || {}), 'appsplus.io/instance': this.metadata?.name },
        annotations:     document.metadata?.annotations || {},
        ownerReferences: [this.ownerReference],
      },
      ...body,
    });

    return created.save();
  }

  async findClusterObject(type, namespace, name) {
    try {
      return await this.$dispatch('find', {
        type,
        id:  `${ namespace }/${ name }`,
        opt: { force: true },
      });
    } catch {
      return null;
    }
  }

  /** The Cluster this installation owns, if it has been created. */
  findCluster() {
    return this.findClusterObject(PROVISIONING_CLUSTER, PROVISION_WORKSPACE, this.clusterName);
  }

  /**
   * Which Fleet workspace each target falls in, as workspace -> targets.
   *
   * A Bundle can only reach clusters in its own workspace, so an instance whose targets span
   * two workspaces needs one Bundle in each; putting them all in the first target's workspace
   * silently deploys to only some of them.
   *
   * A cluster this instance provisions needs no lookup at all: it is created in
   * PROVISION_WORKSPACE, and at the moment the Bundle is written its Fleet Cluster object does
   * not exist yet, so looking it up would fall back to the wrong workspace. Fleet tolerates a
   * target that is not there yet and deploys when it registers.
   */
  async targetsByWorkspace() {
    const out = new Map();

    if (this.provisionsCluster) {
      out.set(PROVISION_WORKSPACE, [{ clusterName: this.clusterName }]);

      return out;
    }

    let clusters = [];

    try {
      clusters = await this.$dispatch('findAll', { type: FLEET_CLUSTER });
    } catch {
      clusters = [];
    }

    for (const name of this.targetClusterNames) {
      const workspace = clusters.find((cluster) => cluster.metadata?.name === name)
        ?.metadata?.namespace || DEFAULT_WORKSPACE;

      out.set(workspace, [...(out.get(workspace) || []), { clusterName: name }]);
    }

    return out;
  }

  /** Create or update one Bundle per workspace the targets fall in, and remove any left over. */
  async syncBundle() {
    const app = await this.resolveApp();
    const resources = renderTemplates(app, this);
    const byWorkspace = await this.targetsByWorkspace();

    for (const [namespace, targets] of byWorkspace) {
      await this.writeBundle(namespace, {
        resources,
        targets,
        // Fleet applies this to any rendered resource that does not name a namespace itself,
        // which is what makes one app deployable to different namespaces per instance.
        defaultNamespace: this.targetNamespace,
      });
    }

    await this.pruneBundles([...byWorkspace.keys()]);
  }

  async writeBundle(namespace, spec) {
    const existing = await this.findBundle(namespace);

    if (existing) {
      existing.spec = spec;

      return existing.save();
    }

    const bundle = await this.$dispatch('create', {
      type:     FLEET_BUNDLE,
      metadata: {
        name:            this.bundleName,
        namespace,
        labels:          { 'appsplus.io/instance': this.metadata?.name },
        ownerReferences: [this.ownerReference],
      },
      spec,
    });

    return bundle.save();
  }

  /**
   * Every Fleet workspace a Bundle of this instance's could be sitting in.
   *
   * Deliberately a small fixed set plus the workspaces Fleet clusters actually live in, rather
   * than "every namespace": prune below deletes what it finds, and a wrong answer here is a
   * deleted Bundle somewhere it should not have looked.
   */
  async candidateWorkspaces() {
    const found = new Set([DEFAULT_WORKSPACE, PROVISION_WORKSPACE]);

    try {
      const clusters = await this.$dispatch('findAll', { type: FLEET_CLUSTER });

      clusters.forEach((cluster) => {
        if (cluster.metadata?.namespace) {
          found.add(cluster.metadata.namespace);
        }
      });
    } catch {
      // The fixed pair is still worth checking.
    }

    return [...found];
  }

  /**
   * Remove Bundles this instance owns in workspaces it no longer targets. Retargeting an
   * instance from a downstream cluster back to local would otherwise leave the old Bundle
   * deploying, since nothing else ever deletes it.
   *
   * This looks each candidate workspace up by id rather than listing Bundles and filtering.
   * Steve's collection cache can be minutes behind for a namespace - it will happily list a
   * Bundle that is gone and omit one that exists - while a GET by id is accurate. Listing here
   * meant the prune silently did nothing.
   */
  async pruneBundles(keep) {
    const candidates = await this.candidateWorkspaces();

    for (const namespace of candidates) {
      if (keep.includes(namespace)) {
        continue;
      }

      const bundle = await this.findBundle(namespace);

      if (!bundle) {
        continue;
      }

      try {
        await bundle.remove();
      } catch {
        // Best effort: a Bundle that cannot be removed is reported by Fleet, and failing the
        // save over it would leave the instance itself unsaved.
      }
    }
  }

  async findBundle(namespace) {
    try {
      return await this.$dispatch('find', {
        type: FLEET_BUNDLE,
        id:   `${ namespace }/${ this.bundleName }`,
        opt:  { force: true },
      });
    } catch {
      return null;
    }
  }

  // ---------------------------------------------------------------- actions

  get availableActions() {
    return [
      {
        action:  'redeploy',
        label:   'Redeploy',
        icon:    'icon icon-refresh',
        enabled: !!this.spec?.app && !this.needsAttention,
      },
      { divider: true },
      // Without the builder's own "Add to Application" - see the App model: staging this
      // product's types into an App is meaningless, and registration cannot exclude a type.
      ...super.availableActions.filter((action) => action.action !== ADD_TO_APP_ACTION),
    ];
  }

  /** Re-render and re-write what this instance owns, without changing the instance itself. */
  async redeploy() {
    try {
      const done = await this.reconcile();

      if (!done) {
        this.$dispatch('growl/error', {
          title:   'Nothing deployed',
          message: this.stateDescription,
          timeout: 8000,
        }, { root: true });
      }
    } catch (error) {
      this.$dispatch('growl/fromError', { title: 'Redeploy failed', error }, { root: true });
    }
  }

  /** Deleting this takes a cluster with it, so make Rancher ask for the name to be typed. */
  get confirmRemove() {
    return this.provisionsCluster;
  }

  get warnDeletionMessage() {
    if (!this.provisionsCluster) {
      return null;
    }

    return `This also deletes the cluster ${ this.clusterName } and everything running on it, ` +
      'including anything deployed there by someone else.';
  }
}
