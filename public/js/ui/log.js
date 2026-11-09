import { app } from '../app.js';
import { dayKey, formatDay, formatTime, mentions, nickHue, renderText } from '../format.js';
import { $, fill, h, icon } from './dom.js';
import { userMenu } from './members.js';
import { emojiPicker } from './overlay.js';

const el = $('#log');
const jump = $('#jump-latest');
const GROUP_WITHIN_MS = 5 * 60 * 1000;
const NEAR_BOTTOM_PX = 80;
const GLYPH = { join: '→', part: '←', info: '·', error: '!' };

/** The buffer whose items are in the DOM right now. */
let shown = null;
let stuck = true;

const isMessage = (item) => !item.local;
const atBottom = () => el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
const toBottom = () => {
  el.scrollTop = el.scrollHeight;
  stuck = true;
  jump.hidden = true;
};

function textContext(buffer) {
  return {
    isNick: (nick) => buffer.members.has(nick.toLowerCase()) || app.isSelf(nick),
    isSelf: (nick) => app.isSelf(nick),
  };
}

function follows(item, prev) {
  return (
    prev && isMessage(prev) && isMessage(item) &&
    prev.nick === item.nick && prev.kind === 'msg' && item.kind === 'msg' &&
    !item.replyTo && !prev.deleted &&
    item.ts - prev.ts < GROUP_WITHIN_MS && dayKey(item.ts) === dayKey(prev.ts)
  );
}

function reactions(msg) {
  if (!msg.reactions.length) return null;
  return h(
    'div.reactions',
    null,
    msg.reactions.map(({ emoji, nicks }) =>
      h(
        `button.chip${nicks.some((nick) => app.isSelf(nick)) ? '.mine' : ''}`,
        { type: 'button', title: nicks.join(', '), dataset: { emoji }, 'aria-label': `${emoji} ${nicks.length}, react` },
        h('span.chip-emoji', null, emoji),
        h('span.chip-count', null, String(nicks.length)),
      ),
    ),
  );
}

function toolbar(buffer, msg) {
  if (msg.deleted || msg.ephemeral) return null;
  const own = app.isSelf(msg.nick);
  const op = buffer.members.get(app.self.nick.toLowerCase())?.role === 'op';
  const button = (act, label, name) => h('button', { type: 'button', title: label, 'aria-label': label, dataset: { act } }, icon(name));
  return h(
    'div.row-actions',
    null,
    button('react', 'React', 'smile'),
    button('reply', 'Reply', 'reply'),
    own && button('edit', 'Edit', 'edit'),
    (own || op) && button('delete', 'Delete', 'trash'),
  );
}

function messageRow(buffer, msg, prev) {
  const own = app.isSelf(msg.nick);
  const classes = ['row', 'msg', `kind-${msg.kind}`];
  if (follows(msg, prev)) classes.push('grouped');
  if (own) classes.push('own');
  if (msg.deleted) classes.push('deleted');
  if (!own && buffer.type === 'channel' && mentions(msg.text, app.self.nick)) classes.push('pinged');

  const body = h('div.body');
  if (msg.replyTo) {
    body.append(
      h(
        'button.reply-ref',
        { type: 'button', dataset: { ref: msg.replyTo.id } },
        h('span.reply-nick', null, msg.replyTo.nick),
        h('span.reply-text', null, msg.replyTo.deleted ? 'message deleted' : msg.replyTo.text),
      ),
    );
  }
  body.append(
    msg.deleted
      ? h('p.text', null, 'message deleted')
      : h('p.text', null, renderText(msg.text, textContext(buffer)), msg.editedAt && h('span.edited', { title: new Date(msg.editedAt).toLocaleString() }, 'edited')),
  );
  const chips = reactions(msg);
  if (chips) body.append(chips);

  return h(
    'div',
    { class: classes.join(' '), dataset: { id: msg.id } },
    h('time.ts', { dateTime: new Date(msg.ts).toISOString(), title: new Date(msg.ts).toLocaleString() }, formatTime(msg.ts)),
    h(
      'span.who',
      null,
      h('span.dot', { style: { '--hue': nickHue(msg.nick) } }),
      h('button.nick', { type: 'button', dataset: { nick: msg.nick }, style: { '--hue': nickHue(msg.nick) } }, msg.nick),
    ),
    body,
    toolbar(buffer, msg),
  );
}

function noteRow(buffer, item) {
  return h(
    `div.row.note.note-${item.kind}`,
    { dataset: { id: item.id } },
    h('time.ts', null, formatTime(item.ts)),
    h('span.who', { 'aria-hidden': 'true' }, GLYPH[item.kind] ?? '·'),
    h(
      'div.body',
      null,
      h(
        'p.text',
        null,
        item.nick && h('button.nick', { type: 'button', dataset: { nick: item.nick } }, item.nick),
        item.nick && ' ',
        renderText(item.text, textContext(buffer)),
      ),
    ),
  );
}

const rowFor = (buffer, item, prev) => (isMessage(item) ? messageRow(buffer, item, prev) : noteRow(buffer, item));

/** The lines that go in front of an item: a date heading, the "new" marker. */
function leadIn(buffer, item, prev, hasNewMarker) {
  const out = [];
  if (!prev || dayKey(prev.ts) !== dayKey(item.ts)) out.push(h('div.divider.day', null, h('span', null, formatDay(item.ts))));
  const unread =
    buffer.newAfter != null && isMessage(item) && Number.isInteger(item.id) && item.id > buffer.newAfter && !app.isSelf(item.nick);
  if (unread && !hasNewMarker) out.push(h('div.divider.new', null, h('span', null, 'new')));
  return out;
}

function head(buffer) {
  if (buffer.type === 'status') return null;
  if (buffer.hasMore) return h('p.log-start', null, 'Loading earlier messages…');
  const what = buffer.type === 'channel' ? `This is the start of ${buffer.name}.` : `This is the start of your conversation with ${buffer.name}.`;
  const kept = buffer.type === 'dm' && !(app.self.registered && buffer.peer?.registered)
    ? ' Messages here are not kept: both of you need a registered nick for that.'
    : '';
  return h('p.log-start', null, what + kept);
}

function draw(buffer) {
  shown = buffer;
  const nodes = [head(buffer)];
  let prev = null;
  let hasNewMarker = false;
  for (const item of buffer.items) {
    const lead = leadIn(buffer, item, prev, hasNewMarker);
    hasNewMarker ||= lead.some((node) => node.classList.contains('new'));
    nodes.push(...lead, rowFor(buffer, item, prev));
    prev = item;
  }
  fill(el, nodes);
}

function append(buffer, item) {
  const prev = buffer.items[buffer.items.indexOf(item) - 1] ?? null;
  const own = isMessage(item) && app.isSelf(item.nick);
  const follow = stuck || own;
  el.append(...leadIn(buffer, item, prev, Boolean(el.querySelector('.divider.new'))), rowFor(buffer, item, prev));
  if (follow) toBottom();
  else if (isMessage(item)) jump.hidden = false;
}

function update(buffer, item) {
  const old = el.querySelector(`.row[data-id="${CSS.escape(String(item.id))}"]`);
  if (!old) return;
  const prev = buffer.items[buffer.items.indexOf(item) - 1] ?? null;
  const follow = stuck;
  old.replaceWith(rowFor(buffer, item, prev));
  if (follow) toBottom();
}

app.on('active', (buffer) => {
  el.setAttribute('aria-label', `Messages in ${buffer.name}`);
  draw(buffer);
  const marker = el.querySelector('.divider.new');
  if (marker) {
    el.scrollTop = Math.max(0, marker.offsetTop - el.clientHeight / 3);
    stuck = atBottom();
  } else {
    toBottom();
  }
});

app.on('items', ({ buffer, kind, item }) => {
  if (buffer !== app.active) return;
  if (kind === 'append' && shown === buffer) return append(buffer, item);
  if (kind === 'update') return update(buffer, item);
  if (kind === 'prepend') {
    // Keep the line the reader was on where it is while history arrives above it.
    const before = el.scrollHeight - el.scrollTop;
    draw(buffer);
    el.scrollTop = el.scrollHeight - before;
    return;
  }
  draw(buffer);
  const marker = el.querySelector('.divider.new');
  if (marker) el.scrollTop = Math.max(0, marker.offsetTop - el.clientHeight / 3);
  else toBottom();
});

el.addEventListener('scroll', () => {
  stuck = atBottom();
  if (stuck) {
    jump.hidden = true;
    app.markRead(app.active);
  }
  if (el.scrollTop < 200 && app.active.hasMore && app.active.loaded) app.loadHistory(app.active, true);
}, { passive: true });

jump.addEventListener('click', () => {
  toBottom();
  app.markRead(app.active);
});

// Keep the latest line in view when the box changes size (keyboard, resize).
new ResizeObserver(() => {
  if (stuck) el.scrollTop = el.scrollHeight;
}).observe(el);

el.addEventListener('click', (event) => {
  const target = event.target.closest('button, a');
  if (!target || !el.contains(target)) return;
  const buffer = app.active;
  const row = target.closest('.row');
  const id = row?.dataset.id;
  const msg = id && buffer.items.find((item) => String(item.id) === id);

  if (target.matches('.nick')) return userMenu(target.dataset.nick, target);
  if (target.matches('.channel-link')) return app.join(target.dataset.channel);
  if (target.matches('.chip') && msg) return app.run('react', { msgId: msg.id, emoji: target.dataset.emoji });
  if (target.matches('.reply-ref')) {
    const original = el.querySelector(`.row[data-id="${CSS.escape(target.dataset.ref)}"]`);
    if (!original) return;
    original.scrollIntoView({ block: 'center' });
    original.classList.add('flash');
    setTimeout(() => original.classList.remove('flash'), 1200);
    return;
  }
  if (!msg) return;
  switch (target.dataset.act) {
    case 'react':
      return emojiPicker(target, (emoji) => app.run('react', { msgId: msg.id, emoji }));
    case 'reply':
      return app.emit('compose', { reply: msg });
    case 'edit':
      return app.emit('compose', { edit: msg });
    case 'delete':
      if (confirm('Delete this message for everyone?')) app.run('delete', { msgId: msg.id });
  }
});

/** Scrolls to a message if it is on screen and flashes it. */
export function reveal(id) {
  const row = el.querySelector(`.row[data-id="${CSS.escape(String(id))}"]`);
  if (!row) return false;
  row.scrollIntoView({ block: 'center' });
  row.classList.add('flash');
  setTimeout(() => row.classList.remove('flash'), 1200);
  return true;
}
