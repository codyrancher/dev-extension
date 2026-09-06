// `v-grow`: a comment box that can be made tall in one click.
//
// Every composer in the PR and Review tabs is a few rows high, which is right for a sentence
// and wrong for a paragraph with a code block in it. The directive puts a small "expand"
// control after the textarea that toggles it to most of the viewport and back; the box also
// grows with what is typed (field-sizing) where the browser can, so the control is for the
// cases where you want the room before you have typed it.
import type { Directive } from 'vue';

const TALL = 'edit-textarea--tall';

export const vGrow: Directive<HTMLTextAreaElement> = {
  mounted(el) {
    if (el.parentElement?.querySelector(':scope > .edit-grow')) {
      return;
    }
    const button = document.createElement('button');

    button.type = 'button';
    button.className = 'edit-grow';
    // The panel's stylesheet is scoped to its component: a control made here rather than in
    // the template has no scope attribute, so without these it is styled as Rancher styles a
    // bare button (40px, grey) instead of as the small corner control .edit-grow describes.
    for (const attr of Array.from(el.attributes)) {
      if (attr.name.startsWith('data-v-')) {
        button.setAttribute(attr.name, attr.value);
      }
    }
    button.title = 'Expand the box';
    button.textContent = '⤢';
    button.addEventListener('click', () => {
      const tall = el.classList.toggle(TALL);

      button.textContent = tall ? '⤡' : '⤢';
      button.title = tall ? 'Shrink the box' : 'Expand the box';
      el.focus();
    });
    el.insertAdjacentElement('afterend', button);
  },
};

export default vGrow;
