import SteveModel from '@shell/plugins/steve/steve-class';
import {
  APP_INSTANCE, PRODUCT_NAME, BLANK_CLUSTER, CREATE_ROUTE, APP_QUERY, ADD_TO_APP_ACTION
} from '../config/types';

/**
 * An App is the definition - a set of YAML templates and the values they render with. It
 * deploys nothing by itself; an AppInstance of it is what reaches a cluster.
 */
export default class App extends SteveModel {
  /**
   * What an app is called, everywhere.
   *
   * Its name, and only its name. There used to be a separate `spec.displayName` that the list
   * headings preferred, which meant an app could be called one thing in the list and another in
   * every URL, every kubectl output and every error message about it. One name is less to keep
   * in step and nothing was gained by the second.
   */
  get nameDisplay() {
    return this.metadata?.name;
  }

  /**
   * No detail-page cards. Whenever a resource shows one or two cards, the shell appends its
   * stock "Extras" card beside them - a pitch for Extensions and Cluster Tools with nothing to
   * say about an App - and the only way to decline it is to show no cards at all. Everything a
   * card would carry is already in the detail component's own header row and tabs.
   */
  get cards() {
    return [];
  }

  get templates() {
    return this.spec?.templates || [];
  }

  get templateCount() {
    return this.templates.length;
  }

  /**
   * The instances of this app. Reads what is already in the store rather than fetching:
   * every page that shows this has loaded AppInstances itself, and a getter that fetched
   * would run once per row.
   */
  get instances() {
    try {
      return this.$rootGetters['management/all'](APP_INSTANCE)
        .filter((instance) => instance.spec?.app === this.metadata?.name);
    } catch {
      return [];
    }
  }

  /** Instances that cannot be rendered against the app as it now stands. */
  /**
   * The glance line under the title. The masthead already has a place for counts like these,
   * and putting them there lines them up with the age and the labels instead of spending a row
   * of the page on two numbers.
   */
  get details() {
    const t = this.$rootGetters['i18n/t'];

    return [
      { label: t('appsPlus.headers.templates'), content: this.templates.length },
      { label: t('appsPlus.headers.instances'), content: this.instances.length },
    ];
  }

  get instancesNeedingAttention() {
    return this.instances.filter((instance) => instance.needsAttention);
  }

  /**
   * Saving an app is a deploy.
   *
   * A template is only a template until something renders it, so an edit that nobody pushed
   * would leave every instance running the previous version with no sign that they had drifted.
   * Instances that can be rendered are redeployed here; instances that cannot are left exactly
   * as they are - still running their last good render - and show a warning until someone
   * supplies what the new template asks for.
   */
  async save(opt) {
    const saved = await super.save(opt);

    await this.redeployInstances();

    return saved;
  }

  async redeployInstances() {
    let instances = [];

    try {
      instances = await this.$dispatch('findAll', { type: APP_INSTANCE, opt: { force: true } });
    } catch {
      return;
    }

    const mine = instances.filter((instance) => instance.spec?.app === this.metadata?.name);

    for (const instance of mine) {
      try {
        await instance.reconcile();
      } catch (error) {
        this.$dispatch('growl/fromError', {
          title: `Could not redeploy ${ instance.metadata?.name }`,
          error,
        }, { root: true });
      }
    }
  }

  /**
   * The edit form for this app, which is where parameters get declared. The undeclared-value
   * banners link here from every surface that is not already it: telling somebody on an
   * install form to look under Default Values points at a section that page does not have.
   */
  get editLocation() {
    return { ...this.detailLocation, query: { mode: 'edit' } };
  }

  get createInstanceLocation() {
    return {
      name:   CREATE_ROUTE,
      params: {
        product: PRODUCT_NAME, cluster: BLANK_CLUSTER, resource: APP_INSTANCE
      },
      query: { [APP_QUERY]: this.metadata?.name },
    };
  }

  /**
   * Without the builder's own "Add to Application": it is registered against every table
   * because it belongs on every *resource*, and an App is not one - staging an App into an
   * App is meaningless. Filtered here because registration cannot say "every type but ours".
   */
  get availableActions() {
    return super.availableActions.filter((action) => action.action !== ADD_TO_APP_ACTION);
  }
}
