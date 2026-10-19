<script>
// The Tools mark: a spanner, drawn here because Rancher's icon font has no tool in it.
//
// The nav asked for `icon-wrench` and got an empty slot - the font ships 146 glyphs and not one
// of them is a wrench, a hammer or a toolbox, and a class the font does not define styles
// nothing and says nothing, so the entry sat blank between the folder and the agent mark with
// only its tooltip to go by.
//
// A jaw and a handle, both solid, at the weight of the glyphs beside it: an outlined drawing
// loses its gap at 16px, which is where this is actually seen. `currentColor` and 1em, like
// FocusMark, so it takes the row's colour and size with no case of its own.
export default { name: 'ToolMark' };
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
    <g transform="rotate(-45 10 10)">
      <path d="M6.4 2h2.4v3h2.4V2h2.4v4a1.6 1.6 0 0 1-1.6 1.6H8a1.6 1.6 0 0 1-1.6-1.6Z" />
      <rect
        x="8.6"
        y="7"
        width="2.8"
        height="9.4"
        rx="1.4"
      />
    </g>
  </svg>
</template>
