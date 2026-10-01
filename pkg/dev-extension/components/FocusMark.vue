<script>
// The Focus shortcut's mark: the sparkle the view wears in its own header.
//
// An inline SVG rather than a glyph from Rancher's icon font, because the font has no sparkle
// and this one is the same drawing the deck uses for itself (components/focus/icons.ts) - the
// shortcut and the thing it leads to should be the same mark. `currentColor`, so it takes the
// nav's colour like every icon beside it.
export default { name: 'FocusMark' };
</script>

<template>
  <svg
    viewBox="0 0 20 20"
    width="1em"
    height="1em"
    fill="currentColor"
    aria-hidden="true"
    focusable="false"
  >
    <path d="M10 2.4 11.7 7 16.3 8.7 11.7 10.4 10 15 8.3 10.4 3.7 8.7 8.3 7ZM15.6 13.2l.7 1.9 1.9.7-1.9.7-.7 1.9-.7-1.9-1.9-.7 1.9-.7Z" />
  </svg>
</template>
