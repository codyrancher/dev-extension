<script>
// The Claude Code mascot, as an inline SVG: the squat block with two eyes and three feet that
// the CLI draws in its banner. Rancher's icon font has no glyph for it, and the footer wants
// something the size of one, so this draws it at whatever font size the row sets. The body is
// currentColor, like an icon; the eyes are cut from it, so it reads on any background.
export default {
  name: 'ClaudeLogo',
};
</script>

<template>
  <svg
    class="claude-logo"
    viewBox="0 0 64 64"
    aria-hidden="true"
    focusable="false"
  >
    <path
      fill="currentColor"
      fill-rule="evenodd"
      d="M19 14h26a8 8 0 0 1 8 8v22a8 8 0 0 1-8 8H19a8 8 0 0 1-8-8V22a8 8 0 0 1 8-8zm2 12v10h8V26zm14 0v10h8V26zM13 54h8v6h-8zm15 0h8v6h-8zm15 0h8v6h-8z"
    />
  </svg>
</template>

<style scoped>
  .claude-logo {
    width:  1.15em;
    height: 1.15em;
    display: inline-block;
    vertical-align: -0.2em;
  }
</style>
