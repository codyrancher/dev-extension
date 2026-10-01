<script>
// The card a row shows when the pointer rests on it.
//
// One component, because there were two: the workspace rows had a card teleported to the body,
// and the Rancher rows had a panel positioned inside the section - which, in a section that
// scrolls, made the section scroll, and could only be opened by hovering the one dot it hung
// from. They are the same thing, so they are one thing now, and anything else that wants a
// card on a row gets the same card.
//
// Two decisions are the whole of why this is a component rather than a div in each list:
//
//   - it is teleported to the body and positioned `fixed`. A card inside a scrolling column is
//     either clipped by it or makes it scroll; neither is something a person wants from resting
//     the pointer on a row.
//   - it stays while the pointer is on the card itself. That is what makes what is in it usable
//     rather than just readable - the links, and now the row's actions, which is where they
//     belong: a control that is only there while the pointer is on the row is a control you
//     have to chase.
//
// The timing and the anchoring are in hover-card.js, which the lists mix in.
export default {
  name: 'HoverCard',

  props: {
    /** Where it goes and what it says: { top, left, title, lines, links }. See hover-card.js. */
    card: {
      type:     Object,
      required: true,
    },
  },

  emits: ['keep', 'hide'],
};
</script>

<template>
  <Teleport to="body">
    <div
      class="dev-card"
      :style="{ top: `${ card.top }px`, left: `${ card.left }px` }"
      @mouseenter="$emit('keep')"
      @mouseleave="$emit('hide')"
    >
      <div
        v-if="card.title"
        class="dev-card__title"
      >
        {{ card.title }}
      </div>
      <!-- Whatever this row has that is not a line of text: the meters on a Rancher's card. -->
      <slot name="body" />
      <div
        v-for="(line, i) in card.lines || []"
        :key="i"
        class="dev-card__line"
      >
        {{ line }}
      </div>
      <div
        v-if="(card.links || []).length"
        class="dev-card__links"
      >
        <a
          v-for="link in card.links"
          :key="link.url"
          :href="link.url"
          target="_blank"
          rel="noopener noreferrer"
        ><i class="icon icon-external-link" /><span>{{ link.label }}</span></a>
      </div>
      <div
        v-if="$slots.actions"
        class="dev-card__actions"
      >
        <slot name="actions" />
      </div>
    </div>
  </Teleport>
</template>

<style lang="scss" scoped>
  .dev-card {
    position:      fixed;
    z-index:       1000;
    max-width:     340px;
    padding:       10px 12px;
    border:        1px solid var(--border);
    border-radius: var(--border-radius);
    background:    var(--body-bg);
    box-shadow:    0 4px 16px rgba(0, 0, 0, 0.25);
    font-size:     12px;
    line-height:   1.4;
    color:         var(--body-text);

    &__title {
      font-weight:   600;
      margin-bottom: 4px;
      word-break:    break-word;
    }

    &__line { color: var(--muted); }

    &__links {
      display:    flex;
      gap:        12px;
      margin-top: 8px;

      // The underline is on the words, not on the anchor: an inline-flex anchor underlines its
      // icon and the gap beside it too, which draws a rule with a notch in it.
      a {
        display:         inline-flex;
        align-items:     center;
        gap:             4px;
        text-decoration: none;

        span { text-decoration: underline; }
      }
    }

    // The row's own controls, under a rule: they are part of the card rather than floating in
    // it, and they are the last thing in it because they are the one part that does something.
    &__actions {
      display:     flex;
      align-items: center;
      gap:         var(--dev-space-2);
      margin-top:  8px;
      padding-top: 8px;
      border-top:  1px solid var(--border);
    }
  }
</style>
