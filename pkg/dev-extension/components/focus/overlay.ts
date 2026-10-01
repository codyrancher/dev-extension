/**
 * Whether something is open over the deck.
 *
 * The deck listens on the window, because a rolodex you can only turn while it happens to hold
 * focus is a rolodex nobody turns. That is right until something opens on top of it - a panel,
 * a dialog - and then the arrow keys and the wheel belong to that instead. One counter, rather
 * than each overlay knowing about the deck.
 */
import { computed, ref } from 'vue';

const open = ref(0);

export const overlayOpen = computed(() => open.value > 0);
export const holdOverlay = (): void => {
  open.value += 1;
};
export const releaseOverlay = (): void => {
  open.value = Math.max(0, open.value - 1);
};
