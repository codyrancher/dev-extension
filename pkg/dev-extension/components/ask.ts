// Asking the person a yes/no question, in the page rather than in the browser's chrome.
//
// This exists to keep `window.confirm()` out of the extension. The browser's dialog cannot be
// styled, so it looks like nothing else in Rancher; it blocks the event loop while it is up, so
// every poll, terminal and socket stalls behind it; and in an embedded or sandboxed iframe the
// browser suppresses it entirely. That last one is the dangerous part rather than the ugly one:
// a suppressed `confirm()` returns false with nothing shown, so `if (!confirm(...)) return;`
// makes a destructive button silently do nothing, and the opposite shape would make a flow
// carry on as if the person had said yes. DevDialog is drawn by the page, so it is themed, it
// does not block, and it cannot be suppressed.
//
// DevDialog is event-driven (confirm/cancel). Rather than turning fifteen call sites into
// state machines - where the risk is firing the work at a different moment than before - this
// bridges the events back to the one shape the call sites already had:
//
//   if (!await this.askQuestion({ title: 'Delete this?', danger: true })) { return; }
//
// The work still runs only after the person has answered, and never before.
//
// A mixin and a composable of the same thing, because the components that ask are a mix of
// options-API (the rail, the pages) and `<script setup>` (WorkspacePr). Both expose `asking`,
// which the component renders as:
//
//   <DevDialog
//     v-if="asking"
//     v-bind="asking.question"
//     @confirm="asking.answer(true)"
//     @cancel="asking.answer(false)"
//   />
import { defineComponent, onBeforeUnmount, ref } from 'vue';

export interface AskQuestion {
  title: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** A destructive confirmation: the confirm button is red. */
  danger?: boolean;
  /** Ask for a line of text as well as a yes. `askText` reads it back; `askQuestion` ignores it. */
  input?: boolean;
  placeholder?: string;
  value?: string;
}

/** A question on screen: what DevDialog is given, and the way back to whoever asked it. */
export interface Asking {
  question: AskQuestion;
  /**
   * `text` is what was typed, which DevDialog already emits with its confirm. Carried through
   * so a question can ask for a word as well as a yes - the callers that want only the yes are
   * unaffected, because the boolean is still what `askQuestion` resolves to.
   */
  answer: (ok: boolean, text?: string) => void;
}

function put(q: AskQuestion, show: (asking: Asking | null) => void): Promise<string | null> {
  return new Promise((resolve) => {
    let answered = false;

    show({
      question: q,
      answer(ok: boolean, text = '') {
        // Escape and the backdrop both reach here, and so does unmounting: answering twice
        // would resolve a promise that has already moved on.
        if (answered) {
          return;
        }
        answered = true;
        show(null);
        // `null` is "no", and a string - empty or not - is "yes". That distinction is the whole
        // reason this does not resolve the text alone: an empty box and a cancelled dialog are
        // different answers, and a caller that cannot tell them apart posts on a cancel.
        resolve(ok ? text : null);
      },
    });
  });
}

/** For `<script setup>` components. */
export function useAsk() {
  const asking = ref<Asking | null>(null);
  const show = (next: Asking | null) => {
    asking.value = next;
  };

  // Navigating away while the question is up answers it no, rather than leaving the caller
  // waiting on a promise nothing will ever settle.
  onBeforeUnmount(() => asking.value?.answer(false));

  return {
    asking,
    ask:     (q: AskQuestion) => put(q, show).then((text) => text !== null),
    askText: (q: AskQuestion) => put(q, show),
  };
}

/**
 * For options-API components.
 *
 * `askQuestion` rather than `ask` because WorkspaceRail already has an `ask` of its own
 * (asking a person for a review), and a component's own method silently wins over a mixin's:
 * the collision would not fail the build, it would just call the wrong thing.
 */
export default defineComponent({
  data() {
    return { asking: null as Asking | null };
  },

  beforeUnmount() {
    this.asking?.answer(false);
  },

  methods: {
    askQuestion(q: AskQuestion): Promise<boolean> {
      return this.askText(q).then((text) => text !== null);
    },

    /** The same question with a box in it: what was typed, or null if it was not confirmed. */
    askText(q: AskQuestion): Promise<string | null> {
      return put(q, (next) => {
        this.asking = next;
      });
    },
  },
});
