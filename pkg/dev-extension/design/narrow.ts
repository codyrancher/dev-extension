// Whether the window is phone-width, as a property a component can render from.
//
// The breakpoint is 760px, the one design/mobile.css and every component's media query use;
// it lives here as well because some of what has to change on a phone is not a style. A table
// with nine columns does not become readable by being narrower - the columns worth a phone are
// fewer, and which they are is a decision in JavaScript. One matchMedia, shared, rather than a
// resize listener per component.
const QUERY = '(max-width: 760px)';

const media = typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(QUERY) : null;

export function isNarrow(): boolean {
  return !!media?.matches;
}

/** `this.narrow`, kept current while the component is mounted. */
export const NarrowMixin = {
  data() {
    return { narrow: isNarrow() };
  },

  mounted(this: { onNarrow?: (event: MediaQueryListEvent) => void; narrow: boolean }) {
    if (!media) {
      return;
    }
    this.onNarrow = (event: MediaQueryListEvent) => {
      this.narrow = event.matches;
    };
    media.addEventListener('change', this.onNarrow);
  },

  beforeUnmount(this: { onNarrow?: (event: MediaQueryListEvent) => void }) {
    if (media && this.onNarrow) {
      media.removeEventListener('change', this.onNarrow);
    }
  },
};

export default NarrowMixin;
