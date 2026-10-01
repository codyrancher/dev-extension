// The behaviour behind HoverCard: when a row's card appears, where, and when it goes.
//
// A mixin rather than a composable because the lists that use it are options-API components,
// and because what it provides is three handlers and one piece of state - the shape a mixin is
// actually good at. See HoverCard.vue for the card itself.
//
// The two delays are the whole feel of the thing. Long enough on the way in that running the
// pointer down a list does not flash a card per row; long enough on the way out that you can
// cross the gap between the row and the card without it closing under you.
const SHOW_MS = 350;
const HIDE_MS = 250;

/** Keeps the card on screen: tall enough cards would otherwise open off the bottom. */
const CARD_ROOM = 220;

export default {
  data() {
    return {
      /** The row the pointer is resting on, and where its card goes, or null. */
      card:      null,
      cardTimer: 0,
    };
  },

  beforeUnmount() {
    clearTimeout(this.cardTimer);
  },

  methods: {
    /**
     * Open a card for one row, anchored to the right of it.
     *
     * `content` is what the card says - { title, lines, links } - and anything else the row
     * wants to put in the card's slots rides along on `item`.
     *
     * Named `openCard` rather than `showCard` because a list that mixes this in usually has its
     * own `showCard`, which decides whether a row has a card at all and then calls this.
     */
    openCard(item, event, content = {}) {
      const rect = event.currentTarget?.getBoundingClientRect?.();

      if (!rect) {
        return;
      }

      clearTimeout(this.cardTimer);
      this.cardTimer = setTimeout(() => {
        this.card = {
          item,
          ...content,
          top:  Math.min(rect.top, window.innerHeight - CARD_ROOM),
          left: rect.right + 6,
        };
      }, SHOW_MS);
    },

    /** The pointer reached the card itself, so it stays. */
    keepCard() {
      clearTimeout(this.cardTimer);
    },

    hideCard() {
      clearTimeout(this.cardTimer);
      this.cardTimer = setTimeout(() => {
        this.card = null;
      }, HIDE_MS);
    },

    /** Shut it at once, for when what it was about has just been acted on. */
    dropCard() {
      clearTimeout(this.cardTimer);
      this.card = null;
    },
  },
};
