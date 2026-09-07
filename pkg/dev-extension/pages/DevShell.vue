<script>
// The Dev product's own page template: a bar of its own, the sidebar, and whatever page is open.
//
// Nothing of Rancher's chrome is in here. The product this extension puts in front of somebody
// is a workspace, a conversation and a pull request; Rancher's header, its app bar, its cluster
// switcher and its product rail are all about the other thing Rancher is for, and on a phone
// they are most of the screen before this product has drawn anything. So the only way back to
// Rancher is one entry in the menu at the top right, and everything else in the bar belongs to
// this product.
//
// What it keeps of the shell is the layout grid (`dashboard-root`, `dashboard-content`): the
// header area, the nav area and the window manager's row are Rancher's, so the terminal drawer
// resizes the page the way it does everywhere else. Under 760px the nav column collapses to
// nothing and the sidebar becomes a drawer over the page, which is the one shape that fits a
// phone: a list of workspaces and a pane are not two columns at 390px.
import WindowManager from '@shell/components/nav/WindowManager';
import ActionMenu from '@shell/components/ActionMenu';
import PromptRemove from '@shell/components/PromptRemove';
import ModalManager from '@shell/components/ModalManager';
import GrowlManager from '@shell/components/GrowlManager';
import DevSidebar from '../components/DevSidebar.vue';
import ClaudeLogo from '../components/ClaudeLogo.vue';
import { DEV_PRODUCT, BLANK_CLUSTER, WORKSPACES_ROUTE } from '../config/constants';

export default {
  name: 'DevShell',

  components: {
    WindowManager, ActionMenu, PromptRemove, ModalManager, GrowlManager, DevSidebar, ClaudeLogo
  },

  data() {
    return { drawer: false, menu: false };
  },

  computed: {
    /** Who is signed in, the way the shell's own header reads it. */
    principal() {
      return this.$store.getters['rancher/byId']('principal', this.$store.getters['auth/principalId']) || {};
    },

    /** This product's own home, for the wordmark to lead back to. */
    homeTo() {
      return { name: WORKSPACES_ROUTE, params: { product: DEV_PRODUCT, cluster: BLANK_CLUSTER } };
    },

    /** Where the page is, in a word, for the bar on a phone - the sidebar is shut there. */
    where() {
      return this.$route.params.workspace || this.$route.name?.split('-').pop() || '';
    },
  },

  watch: {
    // A drawer that stayed open over the page it just opened would have to be closed by hand
    // every time, which is the whole of what makes a phone nav annoying.
    $route() {
      this.drawer = false;
      this.menu = false;
    },
  },

  mounted() {
    document.addEventListener('keydown', this.onKey);
  },

  beforeUnmount() {
    document.removeEventListener('keydown', this.onKey);
  },

  methods: {
    onKey(event) {
      if (event.key === 'Escape') {
        this.drawer = false;
        this.menu = false;
      }
    },

    /** Back to Rancher: its home page, which is where its own nav starts. */
    toRancher() {
      window.location.href = '/dashboard/home';
    },
  },
};
</script>

<template>
  <div class="dashboard-root dev-root">
    <div class="dashboard-content">
      <header class="dev-top">
        <button
          type="button"
          class="dev-top__burger"
          :aria-expanded="drawer ? 'true' : 'false'"
          aria-label="Workspaces and settings"
          data-testid="dev-drawer-toggle"
          @click="drawer = !drawer"
        >
          <i :class="drawer ? 'icon icon-close' : 'icon icon-menu'" />
        </button>
        <router-link
          :to="homeTo"
          class="dev-top__brand"
        >
          <ClaudeLogo class="dev-top__logo" />
          <span class="dev-top__name">Dev</span>
        </router-link>
        <span
          v-if="where"
          class="dev-top__where"
        >{{ where }}</span>
        <div class="dev-top__spacer" />
        <div class="dev-top__menu-wrap">
          <button
            type="button"
            class="dev-top__menu-btn"
            :aria-expanded="menu ? 'true' : 'false'"
            aria-label="Menu"
            data-testid="dev-menu-toggle"
            @click="menu = !menu"
          >
            <i class="icon icon-dots-vertical" />
          </button>
          <div
            v-if="menu"
            class="dev-top__menu"
            data-testid="dev-menu"
          >
            <span
              v-if="principal && principal.loginName"
              class="dev-top__who"
            >{{ principal.loginName }}</span>
            <button
              type="button"
              class="dev-top__item"
              data-testid="dev-back-to-rancher"
              @click="toRancher"
            >
              <i class="icon icon-chevron-left" /> Back to Rancher
            </button>
          </div>
        </div>
      </header>

      <DevSidebar
        class="default-side-nav dev-nav"
        :class="{ 'dev-nav--open': drawer }"
      />
      <div
        v-if="drawer"
        class="dev-scrim"
        data-testid="dev-scrim"
        @click="drawer = false"
      />
      <main class="main-layout">
        <router-view />
      </main>
      <!--
        The terminal drawer. `default` rather than a layout of this template's own, because a
        tab declares which layouts it may appear in and every tab this product opens claims all
        of them (see terminals.ts).
      -->
      <WindowManager layout="default" />
      <ActionMenu />
      <PromptRemove />
      <ModalManager />
      <!--
        The growls: the shell's layout mounts this and this shell replaced that layout, so
        every "copied", "creating" and "sent" the pages dispatched went onto a stack nothing
        drew.
      -->
      <GrowlManager />
    </div>
  </div>
</template>

<style lang="scss" scoped>
.dev-top {
  // Above the scrim: with the drawer open the bar is still the way to close it, and the menu
  // beside it still opens. A scrim that covered the bar made both unclickable.
  position:      relative;
  z-index:       100;
  display:       flex;
  align-items:   center;
  gap:           var(--dev-space-4);
  padding:       0 var(--dev-space-4);
  background:    var(--header-bg, var(--nav-bg));
  border-bottom: 1px solid var(--header-border, var(--border));
  min-width:     0;

  &__burger {
    display:     none;
    align-items: center;
    width:       34px;
    height:      34px;
    min-height:  0;
    padding:     0;
    border:      0;
    border-radius: var(--border-radius);
    background:  transparent;
    color:       var(--header-btn-text, var(--body-text));
    font-size:   18px;
    cursor:      pointer;

    &:hover { background: var(--accent-btn); }
  }

  &__brand {
    display:         flex;
    align-items:     center;
    gap:             var(--dev-space-3);
    color:           var(--header-btn-text, var(--body-text));
    text-decoration: none;
    flex:            0 0 auto;

    &:hover { color: var(--link); }
  }

  &__logo { width: 22px; height: 22px; }

  &__name {
    font-size:      15px;
    font-weight:    600;
    letter-spacing: 0.01em;
  }

  // On a phone the sidebar is shut, so the bar says where the page is instead.
  &__where {
    display:       none;
    min-width:     0;
    overflow:      hidden;
    text-overflow: ellipsis;
    white-space:   nowrap;
    font-family:   monospace;
    font-size:     12px;
    color:         var(--muted);
  }

  &__spacer { flex: 1 1 auto; }

  &__menu-wrap { position: relative; flex: 0 0 auto; }

  &__menu-btn {
    display:       flex;
    align-items:   center;
    justify-content: center;
    width:         34px;
    height:        34px;
    min-height:    0;
    padding:       0;
    border:        0;
    border-radius: var(--border-radius);
    background:    transparent;
    color:         var(--header-btn-text, var(--body-text));
    font-size:     18px;
    cursor:        pointer;

    &:hover { background: var(--accent-btn); }
  }

  &__menu {
    position:      absolute;
    top:           calc(100% + 4px);
    right:         0;
    z-index:       100;
    min-width:     200px;
    padding:       var(--dev-space-2) 0;
    background:    var(--body-bg);
    border:        1px solid var(--border);
    border-radius: var(--border-radius);
    box-shadow:    0 8px 24px rgba(0, 0, 0, 0.3);
  }

  &__who {
    display:       block;
    padding:       var(--dev-space-2) var(--dev-space-4);
    font-size:     11px;
    color:         var(--muted);
    border-bottom: 1px solid var(--border);
    margin-bottom: var(--dev-space-2);
  }

  &__item {
    display:     flex;
    align-items: center;
    gap:         var(--dev-space-3);
    width:       100%;
    padding:     var(--dev-space-3) var(--dev-space-4);
    min-height:  0;
    border:      0;
    background:  transparent;
    color:       var(--body-text);
    font-size:   13px;
    text-align:  left;
    cursor:      pointer;

    &:hover { background: var(--accent-btn); color: var(--link); }
  }
}

.dev-scrim {
  position:   fixed;
  top:        var(--header-height);
  right:      0;
  bottom:     0;
  left:       0;
  z-index:    98;
  background: rgba(0, 0, 0, 0.45);
}

/* ── Phones and narrow windows ──
   The nav column goes to nothing and the sidebar rides over the page instead, so a workspace's
   own pane gets the whole width. Everything here is inside the query: the desktop layout is
   the one above, unchanged. */
@media (max-width: 760px) {
  .dev-root .dashboard-content { --nav-width: 0px; }

  .dev-top {
    padding: 0 var(--dev-space-3);
    gap:     var(--dev-space-3);

    &__burger { display: flex; }
    &__where { display: block; }
  }

  .dev-nav {
    position:   fixed;
    top:        var(--header-height);
    bottom:     0;
    left:       0;
    z-index:    99;
    width:      min(86vw, 320px);
    transform:  translateX(-102%);
    transition: transform 0.18s ease;
    box-shadow: 0 0 28px rgba(0, 0, 0, 0.45);

    &--open { transform: translateX(0); }
  }
}

@media (prefers-reduced-motion: reduce) {
  .dev-nav { transition: none; }
}
</style>
