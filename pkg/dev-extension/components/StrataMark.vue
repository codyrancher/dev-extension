<script>
// The Strata mark: three layers, one over another, which is what the name means and what the
// page is - notes, the labels over them, the lines labelled within them. Drawn here for the same
// reason as ToolMark: Rancher's icon font has nothing for it. Solid, at the weight of the glyphs
// beside it, `currentColor` and 1em so the nav row sizes and colours it.
export default { name: 'StrataMark' };
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
    <path d="M10 1.6 18.4 6 10 10.4 1.6 6Z" />
    <path d="M3.9 8.9 10 12.1l6.1-3.2 2.3 1.2L10 14.5l-8.4-4.4Z" />
    <path d="M3.9 13 10 16.2l6.1-3.2 2.3 1.2L10 18.6l-8.4-4.4Z" />
  </svg>
</template>
