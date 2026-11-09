import { h } from './ui/dom.js';

/** A stable hue (0-359) for a nick, so people keep their colour. */
export function nickHue(nick) {
  let hash = 0;
  for (const char of nick.toLowerCase()) hash = (hash * 31 + char.codePointAt(0)) >>> 0;
  return (hash * 47) % 360;
}

const pad = (n) => String(n).padStart(2, '0');
export const formatTime = (ts) => {
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
export const dayKey = (ts) => new Date(ts).toDateString();
export function formatDay(ts) {
  const d = new Date(ts);
  const today = new Date();
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return d.toLocaleDateString(undefined, {
    weekday: 'long', day: 'numeric', month: 'long',
    year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric',
  });
}
export function formatWhen(ts) {
  return `${formatDay(ts).toLowerCase()} at ${formatTime(ts)}`;
}
export function formatAgo(ms) {
  const minutes = Math.round(ms / 60000);
  if (minutes < 1) return 'less than a minute';
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h`;
  return `${Math.round(hours / 24)} days`;
}

export function mentions(text, nick) {
  const escaped = nick.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^\\w-])@?${escaped}($|[^\\w-])`, 'i').test(text);
}

// One pass over a line of text. Order matters: code first, so nothing inside
// it is formatted; the last alternative catches every word and is kept only
// when it turns out to be somebody's nick.
const TOKEN = new RegExp(
  [
    '(`[^`\\n]+`)',
    '(https?:\\/\\/[^\\s<>"]+)',
    '(\\*\\*[^*\\n]+\\*\\*)',
    '(~~[^~\\n]+~~)',
    '((?<![\\w*])\\*[^*\\s][^*\\n]*\\*(?![\\w*]))',
    '((?<![\\w#&/])#[a-z0-9][a-z0-9_.-]{0,31})',
    '((?<![\\w@.-])@?[A-Za-z_][A-Za-z0-9_-]{1,19}(?![\\w-]))',
  ].join('|'),
  'gi',
);

/** Punctuation that ends a sentence, or closes a bracket opened before the address, is not part of it. */
function trimUrl(url) {
  let href = url;
  for (;;) {
    const trimmed = href.replace(/[.,;:!?'"]+$/, '');
    const closer = trimmed.at(-1);
    const opener = closer === ')' ? '(' : closer === ']' ? '[' : null;
    const next = opener && !trimmed.includes(opener) ? trimmed.slice(0, -1) : trimmed;
    if (next === href) return href;
    href = next;
  }
}

function inline(text, ctx, out) {
  let last = 0;
  const plain = (end) => {
    if (end > last) out.push(text.slice(last, end));
  };
  for (const match of text.matchAll(TOKEN)) {
    const [raw, code, url, bold, strike, italic, channel, word] = match;
    let node;
    if (code) node = h('code', null, code.slice(1, -1));
    else if (url) {
      const href = trimUrl(url);
      plain(match.index);
      out.push(h('a', { href, target: '_blank', rel: 'noopener noreferrer' }, href));
      last = match.index + href.length;
      continue;
    } else if (bold) node = h('strong', null, bold.slice(2, -2));
    else if (strike) node = h('s', null, strike.slice(2, -2));
    else if (italic) node = h('em', null, italic.slice(1, -1));
    else if (channel) node = h('button.link.channel-link', { type: 'button', dataset: { channel: channel.toLowerCase() } }, channel);
    else if (word) {
      const nick = word.replace(/^@/, '');
      if (!ctx.isNick(nick)) continue;
      node = h(`span.mention${ctx.isSelf(nick) ? '.me' : ''}`, { dataset: { nick } }, word);
    }
    plain(match.index);
    out.push(node);
    last = match.index + raw.length;
  }
  plain(text.length);
}

/**
 * Message text as DOM nodes. Only ever creates text nodes and a fixed set
 * of elements, so nothing a user types can become markup.
 * @param {{isNick: (nick: string) => boolean, isSelf: (nick: string) => boolean}} ctx
 */
export function renderText(text, ctx) {
  const out = [];
  const parts = text.split('```');
  parts.forEach((part, i) => {
    const fenced = i % 2 === 1;
    if (fenced && i < parts.length - 1) {
      // Drop an optional language tag on the opening fence.
      out.push(h('pre', null, h('code', null, part.replace(/^[\w+-]*\n/, '').replace(/\n$/, ''))));
    } else if (fenced) {
      inline(`\`\`\`${part}`, ctx, out); // a fence that never closes is just text
    } else {
      inline(i > 0 ? part.replace(/^\n/, '') : part, ctx, out);
    }
  });
  return out;
}
