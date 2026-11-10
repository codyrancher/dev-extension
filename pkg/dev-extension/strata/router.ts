/**
 * The dashboard's router and route, for Strata's `<script setup>` components.
 *
 * Not vue-router's `useRouter()` / `useRoute()`. An extension is loaded as a UMD bundle with its
 * own copy of vue-router, whose composables look for a router in that copy's injection context,
 * find none, and return undefined - so New note did nothing and the note and label pages drew
 * nothing in the installed plugin, while all of it worked on the dev server, where there is one
 * vue-router. `$router` and `$route` on the instance are the host's, always (pages/Focus.vue).
 */
import { computed, getCurrentInstance } from 'vue';
import type { ComputedRef } from 'vue';

type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any

export interface HostRouter {
  push(to: Json): Promise<Json> | undefined;
  resolve(to: Json): Json;
}

export function useHostRouter(): HostRouter {
  const self = getCurrentInstance();
  const host = () => (self?.proxy as Json)?.$router;

  return {
    push:    (to) => host()?.push(to),
    resolve: (to) => host()?.resolve(to) || { href: '#' },
  };
}

/** The current route, reactive: `route.value.params`, `route.value.query`. */
export function useHostRoute(): ComputedRef<Json> {
  const self = getCurrentInstance();

  return computed(() => (self?.proxy as Json)?.$route || { params: {}, query: {} });
}
