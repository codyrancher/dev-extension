<script>
// Claude's mark, as an inline SVG: the eight-rayed spark. Rancher's icon font has no glyph for
// it, and the footer wants something the size of one, so this draws it at whatever font size
// the row sets, in currentColor, the way an icon would.
export default {
  name: 'ClaudeLogo',
};
</script>

<template>
  <svg
    class="claude-logo"
    viewBox="0 0 24 24"
    aria-hidden="true"
    focusable="false"
  >
    <path
      fill="currentColor"
      d="M13.2 2.2 12 9.1 10.8 2.2Zm-2.4 19.6L12 14.9l1.2 6.9ZM2.2 10.8l6.9 1.2-6.9 1.2Zm19.6 2.4L14.9 12l6.9-1.2ZM4.7 4.2l5.7 4.1-3.1-6.5Zm14.6 15.6-5.7-4.1 3.1 6.5Zm.5-15.1-4.1 5.7 6.5-3.1ZM4.2 19.3l4.1-5.7-6.5 3.1Z"
    />
    <circle
      cx="12"
      cy="12"
      r="2.2"
      fill="currentColor"
    />
  </svg>
</template>

<style scoped>
  .claude-logo {
    width:  1em;
    height: 1em;
    display: inline-block;
    vertical-align: -0.125em;
  }
</style>
