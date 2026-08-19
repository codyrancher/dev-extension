<script>
// Nothing, that takes up the leftover room.
//
// A Row with one of these in it puts what follows at the far end without anybody reaching for
// `margin-left: auto` on a component that should not have to know where it is. It is one line
// of CSS, and the reason it is a component is that `margin-left: auto` on the third of four
// children is invisible until you go looking for why the fourth moved.
export default { name: 'Spacer' };
</script>

<template>
  <div class="spacer" />
</template>

<style lang="scss" scoped>
.spacer {
  flex: 1 1 auto;
  // Nothing to see and nothing to click through to whatever is behind it.
  min-width: 0;
  min-height: 0;
}
</style>
