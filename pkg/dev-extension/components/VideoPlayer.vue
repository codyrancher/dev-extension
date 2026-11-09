<script setup lang="ts">
/**
 * The one video player. Every recording the extension plays is played in this, whichever viewer
 * opened it - ArtifactViewer, MediaViewer, PodFileViewer - so it can be scrubbed the same way
 * everywhere, and a fix to playing one is a fix to playing all of them.
 *
 * It is the browser's own player, which already scrubs, plays at speed and goes full screen. What
 * it adds is the two things that stopped the scrub bar working:
 *
 *   - **A server that will not send part of a file.** A player seeks by asking for a range; a
 *     server that answers every request with the whole file (no `Accept-Ranges`) leaves the
 *     browser treating the video as a stream it cannot seek in, and the bar does nothing. dev-api
 *     answers ranges now, but a recording can come from anywhere, so when what the player can seek
 *     does not cover the recording (`covered`) the file is read once into the page and played
 *     from there, where every byte is at hand.
 *   - **A recording that does not know its own length.** WebM made by a browser's recorder carries
 *     no duration until it has been read to the end, and a player with a length of Infinity draws
 *     no scrub bar. Asking for a time far past the end makes it find the length; it is then put
 *     back at the start.
 */
import { onBeforeUnmount, ref, watch } from 'vue';

const props = withDefaults(defineProps<{ src: string; autoplay?: boolean; loop?: boolean }>(), { autoplay: false, loop: false });

const el = ref<HTMLVideoElement | null>(null);
/** What the element plays: the source, or a copy of it in the page (see above). */
const playing = ref(props.src);
/** An object URL this made, to give back. */
let held = '';
/** Whether the copy has been tried for this source, so a failure is not retried in a loop. */
let copied = false;

function release(): void {
  if (held) {
    URL.revokeObjectURL(held);
    held = '';
  }
}

watch(() => props.src, (src) => {
  release();
  copied = false;
  playing.value = src;
});

onBeforeUnmount(release);

const seeked = (video: HTMLVideoElement) => new Promise((done) => {
  video.addEventListener('seeked', done, { once: true });
  setTimeout(done, 3000); // A seek that never lands must not hold the player.
});

/** The length, found by asking for a time past the end and coming back. Only when it is unknown. */
async function findLength(video: HTMLVideoElement): Promise<void> {
  if (Number.isFinite(video.duration)) {
    return;
  }
  const back = () => {
    video.removeEventListener('timeupdate', back);
    video.currentTime = 0;
  };

  video.addEventListener('timeupdate', back);
  video.currentTime = 1e101;
  await seeked(video); // to the end
  if (video.currentTime !== 0) {
    await seeked(video); // and back
  }
}

/*
 * Whether the scrub bar can reach every part of it.
 *
 * Judged once the length is known, and by whether the seekable range covers it - not by whether
 * there is a range at all. Measured in Chrome on a recording served whole: at first the player
 * calls it seekable from 0 to Infinity, and once the length is in, seekable from 0 to 0.
 */
function covered(video: HTMLVideoElement): boolean {
  const { seekable, duration } = video;

  return !Number.isFinite(duration) || (seekable.length > 0 && seekable.end(seekable.length - 1) >= duration - 0.25);
}

/** A source the browser cannot seek in, read into the page and played from there instead. */
async function copyIfUnseekable(video: HTMLVideoElement): Promise<void> {
  if (copied || covered(video) || !/^https?:/.test(playing.value)) {
    return;
  }
  copied = true;
  try {
    const answer = await fetch(playing.value);

    if (!answer.ok) {
      return;
    }
    const blob = await answer.blob();

    if (playing.value !== props.src) {
      return; // Another recording was asked for meanwhile.
    }
    held = URL.createObjectURL(blob);
    playing.value = held;
  } catch {
    // It still plays from the start; only the bar is lost, as it was.
  }
}

async function onMetadata(): Promise<void> {
  const video = el.value;

  if (!video) {
    return;
  }
  await findLength(video);
  await copyIfUnseekable(video);
}
</script>

<template>
  <video
    ref="el"
    class="video-player"
    :src="playing"
    controls
    preload="metadata"
    playsinline
    :autoplay="autoplay"
    :loop="loop"
    @loadedmetadata="onMetadata"
  />
</template>

<style scoped>
.video-player {
  display: block;
  max-width: 100%;
  background: #000;
}
</style>
