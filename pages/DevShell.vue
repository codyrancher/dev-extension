<script>
// The Dev product's own page template: the sidebar, and whatever page is open beside it.
//
// A template of this product's own rather than one of the shell's, because none of the shell's
// fits. `default` renders Rancher's own side nav, which is the thing being replaced, and that
// nav cannot draw a workspace row (see components/DevSidebar.vue). `plain` has no side nav but
// wraps its page in an IndentedPanel, which is 90% wide and centred, and the two panes this
// product is mostly used through are a terminal and an iframe that want the window.
//
// What it is not is a new layout. It is the shell's own: the same `dashboard-root` and
// `dashboard-content` grid every Rancher page is laid out by, with the sidebar in the grid's
// `nav` area, the page in `main`, and the terminal drawer in `wm`. So the header height, the
// nav width, the drawer's resizing and the offset for the app bar are Rancher's numbers rather
// than numbers picked here, and they follow it when it changes.
//
// What it costs against `default`, since it is a trade rather than a detail: Rancher's side nav
// is gone, which is the point, and Header runs in `simple` mode, which drops the product title
// block at the top left. The product switcher, the notifications, the user menu and this
// extension's own Dev button are all in the part of the header that stays.
import { mapGetters } from 'vuex';
import Header from '@shell/components/nav/Header';
import WindowManager from '@shell/components/nav/WindowManager';
import ActionMenu from '@shell/components/ActionMenu';
import PromptRemove from '@shell/components/PromptRemove';
import ModalManager from '@shell/components/ModalManager';
import DevSidebar from '../components/DevSidebar.vue';

export default {
  name: 'DevShell',

  components: {
    Header, WindowManager, ActionMenu, PromptRemove, ModalManager, DevSidebar
  },

  computed: {
    // The shell's own app bar is fixed to the left edge and is not part of the grid, so the
    // grid is padded out of its way. Same getter, same class, same width as every other page.
    ...mapGetters(['showTopLevelMenu']),
  },
};
</script>

<template>
  <div class="dashboard-root">
    <div
      class="dashboard-content"
      :class="{ 'dashboard-padding-left': showTopLevelMenu }"
    >
      <Header :simple="true" />
      <DevSidebar class="default-side-nav" />
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
    </div>
  </div>
</template>
