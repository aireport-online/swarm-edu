import { $, h } from './dom.js';

const layer = () => $('#layer');
let closeCurrent = null;

/** Closes whatever popover or menu is open. */
export function closePopover() {
  closeCurrent?.();
}

/**
 * Shows `content` next to `anchor` until the user clicks elsewhere or
 * presses Escape. Returns a function that closes it.
 */
export function popover(anchor, content, { align = 'start', side = 'bottom' } = {}) {
  closePopover();
  const box = h('div.popover', { role: 'dialog' }, content);
  layer().append(box);

  const rect = anchor.getBoundingClientRect();
  const { width, height } = box.getBoundingClientRect();
  const margin = 8;
  let left = align === 'end' ? rect.right - width : rect.left;
  let top = side === 'top' ? rect.top - height - 6 : rect.bottom + 6;
  if (top + height > innerHeight - margin) top = rect.top - height - 6;
  if (top < margin) top = Math.max(margin, Math.min(rect.bottom + 6, innerHeight - height - margin));
  left = Math.max(margin, Math.min(left, innerWidth - width - margin));
  box.style.left = `${left}px`;
  box.style.top = `${top}px`;

  const onPointer = (event) => {
    if (!box.contains(event.target) && !anchor.contains(event.target)) close();
  };
  const onKey = (event) => {
    if (event.key !== 'Escape') return;
    event.stopPropagation();
    close();
    anchor.focus?.();
  };
  function close() {
    if (closeCurrent !== close) return;
    closeCurrent = null;
    box.remove();
    document.removeEventListener('pointerdown', onPointer, true);
    document.removeEventListener('keydown', onKey, true);
    removeEventListener('resize', close);
  }
  closeCurrent = close;
  document.addEventListener('pointerdown', onPointer, true);
  document.addEventListener('keydown', onKey, true);
  addEventListener('resize', close);
  box.querySelector('button, input, [tabindex]')?.focus({ preventScroll: true });
  return close;
}

/**
 * A list of actions. Items are `{ label, run, danger?, checked? }`,
 * `{ heading }` or `null` for a divider; falsy items are skipped.
 */
export function menu(anchor, items, options) {
  const list = h('div.menu', { role: 'menu' });
  for (const item of items) {
    if (item === null) list.append(h('hr'));
    else if (!item) continue;
    else if (item.heading) list.append(h('p.menu-heading', null, item.heading, item.detail && h('span', null, item.detail)));
    else {
      list.append(
        h(
          `button.menu-item${item.danger ? '.danger' : ''}`,
          {
            type: 'button', role: item.checked == null ? 'menuitem' : 'menuitemcheckbox',
            'aria-checked': item.checked == null ? null : String(item.checked),
            on: { click: () => { closePopover(); item.run(); } },
          },
          item.label,
          item.checked != null && h('span.menu-state', null, item.checked ? 'On' : 'Off'),
        ),
      );
    }
  }
  list.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const buttons = [...list.querySelectorAll('button')];
    const next = buttons.indexOf(document.activeElement) + (event.key === 'ArrowDown' ? 1 : -1);
    buttons[(next + buttons.length) % buttons.length]?.focus();
  });
  return popover(anchor, list, options);
}

const EMOJI = ['👍', '❤️', '😂', '🎉', '🙏', '👀', '🔥', '✅', '😮', '😢', '🤔', '👏', '🚀', '💯', '👎', '☕', '🙌', '😅', '🤝', '💡', '🐛', '✨', '😎', '🫡'];

export function emojiPicker(anchor, onPick) {
  const grid = h('div.emoji-grid', { role: 'menu', 'aria-label': 'React' });
  for (const emoji of EMOJI) {
    grid.append(h('button', { type: 'button', on: { click: () => { closePopover(); onPick(emoji); } } }, emoji));
  }
  return popover(anchor, grid, { align: 'end' });
}

/**
 * A modal dialog. `build(close)` returns its content.
 * @returns {HTMLDialogElement}
 */
export function dialog(title, build) {
  closePopover();
  const el = h('dialog.dialog', { 'aria-label': title });
  const close = () => el.close();
  el.append(build(close));
  el.addEventListener('close', () => el.remove());
  el.addEventListener('click', (event) => {
    if (event.target === el) close(); // a click on the backdrop
  });
  layer().append(el);
  el.showModal();
  return el;
}
