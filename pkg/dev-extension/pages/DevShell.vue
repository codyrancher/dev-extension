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
import { socketsWork, rancherOwnAddress } from '../sockets';
import { DEV_PRODUCT, BLANK_CLUSTER, WORKSPACES_ROUTE } from '../config/constants';

export default {
  name: 'DevShell',

  components: {
    WindowManager, ActionMenu, PromptRemove, ModalManager, GrowlManager, DevSidebar, ClaudeLogo
  },

  data() {
    return {
      drawer: false, menu: false, socketsBlocked: false, ownAddress: '',
    };
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

    host() {
      return window.location.host;
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

  async mounted() {
    document.addEventListener('keydown', this.onKey);
    document.addEventListener('click', this.onDocClick, true);
    // One probe, so a page whose websockets cannot connect says so once instead of leaving
    // every terminal dead and the console full of the same line. See sockets.ts.
    if (await socketsWork() === 'blocked') {
      this.socketsBlocked = true;
      this.ownAddress = await rancherOwnAddress(this.$store);
    }
  },

  beforeUnmount() {
    document.removeEventListener('keydown', this.onKey);
    document.removeEventListener('click', this.onDocClick, true);
  },

  methods: {
    onKey(event) {
      if (event.key === 'Escape') {
        this.drawer = false;
        this.menu = false;
      }
    },

    /**
     * A click outside the wordmark menu closes it.
     *
     * Captured on the document rather than an overlay, because an overlay over the whole page
     * would eat the first click on whatever the person actually wanted next - opening a menu
     * should not cost a click elsewhere. `contains` lets the toggle button handle its own
     * click first, so this never fights the button that opens it.
     */
    onDocClick(event) {
      if (this.menu && !this.$refs.brandWrap?.contains(event.target)) {
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
        <!--
          The wordmark is the menu.
          
          "Dev" with a chevron opens a dropdown, and the way back to Rancher lives in it - a
          product that has replaced Rancher's own top nav with its own has to give that back
          somewhere obvious, and the product's own name is where a person looks first. The
          previous control was a bare ... at the far right, which is where a person looks last.
        -->
        <div
          ref="brandWrap"
          class="dev-top__brand-wrap"
        >
          <button
            type="button"
            class="dev-top__brand"
            :aria-expanded="menu ? 'true' : 'false'"
            aria-haspopup="true"
            data-testid="dev-menu-toggle"
            @click="menu = !menu"
          >
            <ClaudeLogo class="dev-top__logo" />
            <span class="dev-top__name">Dev</span>
            <i
              class="dev-top__brand-chevron"
              :class="menu ? 'icon icon-chevron-up' : 'icon icon-chevron-down'"
            />
          </button>
          <div
            v-if="menu"
            class="dev-top__menu"
            data-testid="dev-menu"
          >
            <router-link
              :to="homeTo"
              class="dev-top__item"
              @click="menu = false"
            >
              <i class="icon icon-home" /> Dev home
            </router-link>
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
        <span
          v-if="where"
          class="dev-top__where"
        >{{ where }}</span>
        <div class="dev-top__spacer" />
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
        <div
          v-if="socketsBlocked"
          class="dev-blocked"
          data-testid="dev-sockets-blocked"
        >
          <i class="icon icon-warning" />
          <span>
            This browser will not open a websocket to <code>{{ host }}</code>, so terminals, chat
            and the conversation list cannot connect. It is almost always the certificate: a page
            served with one the browser does not trust can be clicked through, but a websocket to
            it cannot.
            <template v-if="ownAddress">
              Open this Rancher at <a :href="ownAddress + '/dashboard/dev'">{{ ownAddress }}</a> for anything interactive.
            </template>
          </span>
          <button
            type="button"
            class="dev-blocked__close"
            aria-label="Dismiss"
            @click="socketsBlocked = false"
          >
            &times;
          </button>
        </div>
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
  // The same inset the page under it uses, so the bar and the column are one edge rather than
  // two that nearly agree. design/tokens.css.
  padding:       0 var(--dev-inset);
  background:    var(--header-bg, var(--nav-bg));
  border-bottom: 1px solid var(--header-border, var(--border));
  min-width:     0;

  &__burger {
    display:         none;
    align-items:     center;
    justify-content: center;
    width:           var(--dev-control);
    height:          var(--dev-control);
    min-height:      0;
    padding:         0;
    border:          0;
    border-radius:   var(--border-radius);
    background:      transparent;
    color:           var(--header-btn-text, var(--body-text));
    font-size:       18px;
    cursor:          pointer;
    // What lines up with the heading below is the glyph, not the box a thumb has to hit, so the
    // button hangs half its slack back into the bar's padding and the icon lands on the inset.
    margin-left:     calc((var(--dev-control) - 1em) / -2);

    &:hover { background: var(--accent-btn); }

    // A box of the bar's own, because icon-close and icon-menu are two glyphs of one font and
    // nothing promises they are the same width: this is what stops the row moving as the drawer
    // opens.
    .icon {
      display:         flex;
      align-items:     center;
      justify-content: center;
      width:           1em;
      height:          1em;
      line-height:     1;
    }
  }

  &__brand-wrap { position: relative; flex: 0 0 auto; }

  &__brand {
    display:         flex;
    align-items:     center;
    gap:             var(--dev-space-3);
    padding:         var(--dev-space-2) var(--dev-space-3);
    margin-left:     calc(var(--dev-space-3) * -1);
    border:          0;
    border-radius:   var(--border-radius);
    background:      transparent;
    color:           var(--header-btn-text, var(--body-text));
    font:            inherit;
    text-decoration: none;
    cursor:          pointer;

    &:hover { background: var(--accent-btn); color: var(--link); }
  }

  &__brand-chevron { font-size: 12px; opacity: 0.7; }

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

  &__menu {
    position:      absolute;
    top:           calc(100% + 4px);
    left:          0;
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

.dev-blocked {
  display:       flex;
  align-items:   flex-start;
  gap:           var(--dev-space-3);
  margin:        var(--dev-space-4) var(--dev-inset) 0;
  padding:       var(--dev-space-4);
  border:        1px solid var(--warning);
  border-radius: var(--border-radius);
  background:    var(--warning-banner-bg, rgba(219, 171, 0, 0.12));
  color:         var(--body-text);
  font-size:     13px;
  line-height:   1.5;

  .icon { color: var(--warning); margin-top: 2px; }
  code { word-break: break-all; }

  &__close {
    margin-left: auto;
    min-height:  0;
    padding:     0 var(--dev-space-2);
    border:      0;
    background:  transparent;
    color:       var(--muted);
    font-size:   18px;
    cursor:      pointer;
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

  .dev-blocked { margin-top: var(--dev-space-3); }

  .dev-top {
    gap: var(--dev-space-3);

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
