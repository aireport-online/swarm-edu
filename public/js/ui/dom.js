/**
 * `h('div.card.wide', { title: 'x', on: { click } }, child, 'text')`.
 * Strings always become text nodes.
 */
export function h(spec, props, ...children) {
  const [tag, ...classes] = spec.split('.');
  const el = document.createElement(tag || 'div');
  if (classes.length) el.className = classes.join(' ');
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value == null || value === false) continue;
    if (key === 'on') for (const [name, fn] of Object.entries(value)) el.addEventListener(name, fn);
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key === 'class') el.classList.add(...String(value).split(/\s+/).filter(Boolean));
    else if (key === 'style') for (const [name, v] of Object.entries(value)) el.style.setProperty(name, v);
    else if (key in el && key !== 'list') el[key] = value;
    else el.setAttribute(key, value === true ? '' : value);
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const child of children) {
    if (child == null || child === false) continue;
    if (Array.isArray(child)) append(el, child);
    else el.append(child);
  }
}

export const $ = (selector, root = document) => root.querySelector(selector);

const ICONS = {
  plus: 'M12 5v14M5 12h14',
  x: 'M6 6l12 12M18 6L6 18',
  menu: 'M4 7h16M4 12h16M4 17h16',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20 20l-4-4',
  people: 'M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM2.5 20c.6-3.4 3.2-5.5 6.5-5.5s5.900 2.100 6.500 5.500M16 4.300a3.500 3.500 0 0 1 0 6.400M18.500 14.800c1.700.800 2.800 2.600 3 5.200',
  reply: 'M10 8L5 13l5 5M5 13h8a6 6 0 0 1 6 6',
  smile: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM8.500 14.500a4.500 4.500 0 0 0 7 0M9 9.500v.500M15 9.500v.500',
  edit: 'M4 20h4L19 9l-4-4L4 16v4zM13.500 6.500l4 4',
  trash: 'M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13',
  send: 'M5 12h13M12 6l6 6-6 6',
  more: 'M6 12h.010M12 12h.010M18 12h.010',
  back: 'M15 6l-6 6 6 6',
};

export function icon(name, size = 16) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', name === 'more' ? '2.6' : '1.6');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', ICONS[name]);
  svg.append(path);
  return svg;
}

/** Empties `el` and fills it with the given children. */
export function fill(el, ...children) {
  el.replaceChildren();
  append(el, children);
  return el;
}
