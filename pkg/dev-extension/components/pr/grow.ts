// `v-grow`: a comment box that can be made tall in one click.
//
// Every composer in the PR and Review tabs is a few rows high, which is right for a sentence
// and wrong for a paragraph with a code block in it. The directive puts a small "expand"
// control in the box's bottom corner, shown while the pointer or the focus is on the box, that
// toggles it to most of the viewport and back; the box also grows with what is typed
// (field-sizing) where the browser can, so the control is for the cases where you want the
// room before you have typed it.
import type { Directive } from 'vue';

const TALL = 'edit-textarea--tall';
const CONTROL = Symbol('grow');

interface Grown extends HTMLTextAreaElement {
  [CONTROL]?: { button: HTMLButtonElement; observer: ResizeObserver | null };
}

export const vGrow: Directive<Grown> = {
  mounted(el) {
    const parent = el.parentElement;

    if (!parent || el[CONTROL]) {
      return;
    }
    // The control is laid over the box's own corner, so the box's parent is what it is
    // positioned in; a parent that is not positioned is made so, which changes nothing else.
    if (getComputedStyle(parent).position === 'static') {
      parent.style.position = 'relative';
    }
    const button = document.createElement('button');

    button.type = 'button';
    button.className = 'edit-grow';
    button.title = 'Expand the box';
    button.textContent = '⤢';
    button.tabIndex = -1;
    // The panel's stylesheet is scoped to its component: a control made here rather than in
    // the template has no scope attribute, so without these it is styled as Rancher styles a
    // bare button (40px, grey) instead of as the small corner control .edit-grow describes.
    for (const attr of Array.from(el.attributes)) {
      if (attr.name.startsWith('data-v-')) {
        button.setAttribute(attr.name, attr.value);
      }
    }
    // Bottom right of the box, clear of the resize grip in the corner and of a scrollbar down
    // the side; followed as the box grows with typing, is dragged, or is toggled.
    const place = () => {
      button.style.left = `${ el.offsetLeft + el.offsetWidth - button.offsetWidth - 18 }px`;
      button.style.top = `${ el.offsetTop + el.offsetHeight - button.offsetHeight - 6 }px`;
    };

    button.addEventListener('mousedown', (event) => event.preventDefault()); // keep the focus in the box
    button.addEventListener('click', () => {
      const tall = el.classList.toggle(TALL);

      button.textContent = tall ? '⤡' : '⤢';
      button.title = tall ? 'Shrink the box' : 'Expand the box';
      el.focus();
      requestAnimationFrame(place);
    });
    el.insertAdjacentElement('afterend', button);
    place();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(place);

    observer?.observe(el);
    el[CONTROL] = { button, observer };
  },

  updated(el) {
    const control = el[CONTROL];

    if (control && control.button.parentElement !== el.parentElement) {
      // The template moved the box (a re-render with a different key): put the control back
      // beside it.
      el.insertAdjacentElement('afterend', control.button);
    }
  },

  unmounted(el) {
    const control = el[CONTROL];

    if (control) {
      control.observer?.disconnect();
      control.button.remove();
      delete el[CONTROL];
    }
  },
};

export default vGrow;
