<script>
/**
 * Logging in to the shared VPN: the one-time code, and who is waiting for it.
 *
 * The username, password and the profile are in the person's secret store (Settings → VPN), so all
 * a daily login asks for is the code. Shown over every Dev page when something asked for the VPN
 * while it was down (DevShell), and from the Tools page's VPN card.
 */
import DevModal from './DevModal.vue';
import { LabeledInput } from '@components/Form/LabeledInput';
import { Banner } from '@components/Banner';
import { vpnLogin, vpnDismiss } from '../vpn';
import { stamp } from '../automations';
import { DEV_PRODUCT, BLANK_CLUSTER, SETTINGS_ROUTE } from '../config/constants';

export default {
  name: 'VpnLogin',

  components: { DevModal, LabeledInput, Banner },

  props: {
    /** dev-api's /vpn answer. */
    status: {
      type:    Object,
      default: () => ({}),
    },
  },

  emits: ['close', 'connected'],

  data() {
    return {
      otp: '', busy: false, error: '',
    };
  },

  computed: {
    asks() {
      return this.status?.asks || [];
    },

    settingsTo() {
      return { name: SETTINGS_ROUTE, params: { product: DEV_PRODUCT, cluster: BLANK_CLUSTER }, hash: '#tokens' };
    },
  },

  mounted() {
    this.$nextTick(() => this.$el?.querySelector?.('input')?.focus?.());
  },

  methods: {
    stamp,

    async submit() {
      const otp = this.otp.trim();

      if (!otp || this.busy) {
        return;
      }
      this.busy = true;
      this.error = '';
      try {
        const state = await vpnLogin(otp);

        if (state?.phase === 'connected') {
          this.$store.dispatch('growl/success', { title: 'VPN connected', message: 'Workspaces can reach the ECM lab.' }, { root: true });
          this.$emit('connected', state);
          this.$emit('close');

          return;
        }
        this.error = state?.note || `The VPN is ${ state?.phase || 'not up' }.`;
      } catch (e) {
        this.error = e?.message || String(e);
      } finally {
        this.otp = '';
        this.busy = false;
      }
    },

    async notNow() {
      if (this.asks.length) {
        await vpnDismiss().catch(() => {});
      }
      this.$emit('close');
    },
  },
};
</script>

<template>
  <DevModal
    title="Log in to the ECM VPN"
    size="medium"
    data-testid="vpn-login"
    @close="notNow"
  >
    <div class="vpn-login">
      <p
        v-if="asks.length"
        class="vpn-login__asks"
      >
        Waiting for it:
        <span
          v-for="ask in asks"
          :key="ask.who"
          class="vpn-login__ask"
        >
          <strong>{{ ask.who }}</strong> <span class="text-muted">{{ stamp(ask.at) }}</span><template v-if="ask.reason"> - {{ ask.reason }}</template>
        </span>
      </p>
      <p class="text-muted">
        The lab's VPN ends every session after a day; one login reconnects every workspace.
        <template v-if="status.note && status.phase !== 'off'">
          Last: {{ status.note }}
        </template>
      </p>
      <Banner
        v-if="!status.configured"
        color="warning"
      >
        <span>
          A login needs {{ (status.missing || []).join(', ') }} in your secret store first.
          <router-link
            :to="settingsTo"
            @click="$emit('close')"
          >Open Settings</router-link>
        </span>
      </Banner>
      <form
        v-else
        class="vpn-login__form"
        @submit.prevent="submit"
      >
        <LabeledInput
          v-model:value="otp"
          label="One-time code"
          placeholder="123456"
          :disabled="busy"
          data-testid="vpn-otp"
          autocomplete="one-time-code"
          inputmode="numeric"
        />
      </form>
      <Banner
        v-if="error"
        color="error"
        :label="error"
      />
    </div>
    <template #footer>
      <button
        type="button"
        class="btn role-primary"
        :disabled="busy || !status.configured || !otp.trim()"
        data-testid="vpn-login-submit"
        @click="submit"
      >
        <i
          v-if="busy"
          class="icon icon-spinner icon-spin"
        />
        {{ busy ? 'Connecting…' : 'Log in' }}
      </button>
      <button
        type="button"
        class="btn role-secondary"
        :disabled="busy"
        data-testid="vpn-login-later"
        @click="notNow"
      >
        Not now
      </button>
    </template>
  </DevModal>
</template>

<style lang="scss" scoped>
.vpn-login {
  display:        flex;
  flex-direction: column;
  gap:            var(--dev-space-4, 12px);

  p { margin: 0; }

  &__asks {
    display:        flex;
    flex-direction: column;
    gap:            2px;
  }
}
</style>
