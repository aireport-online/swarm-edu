import { app } from '../app.js';
import { $, fill, h, icon } from './dom.js';
import { menu } from './overlay.js';
import { mark, swarmGlyph } from '../swarm.js';

const el = $('#sidebar');
const closeDrawer = () => document.body.classList.remove('nav-open');

/** A count only where it asks for an answer: mentions and private messages. */
function badge(buffer) {
  if (!buffer.mentions) return null;
  const label = buffer.mentions > 99 ? '99+' : String(buffer.mentions);
  return h('span.badge', { 'aria-label': `${buffer.mentions} for you` }, label);
}

/** How many are in a channel right now: a swarm of up to nine dots, then a number. */
function swarm(buffer) {
  let online = 0;
  for (const member of buffer.members.values()) if (member.online) online += 1;
  const label = `${online} online`;
  if (online > 9) return h('span.nav-count', { title: label, 'aria-label': label }, String(online));
  const glyph = swarmGlyph(online);
  glyph.setAttribute('role', 'img');
  glyph.setAttribute('aria-label', label);
  glyph.removeAttribute('aria-hidden');
  return glyph;
}

function row(buffer, label = buffer.name) {
  const active = buffer.key === app.activeKey;
  const dm = buffer.type === 'dm';
  return h(
    `button.nav-row${active ? '.active' : ''}${buffer.unread ? '.unread' : ''}${dm ? '.dm' : ''}`,
    {
      type: 'button',
      'aria-current': active ? 'page' : null,
      on: { click: () => { app.activate(buffer.key); closeDrawer(); } },
    },
    dm && h(`span.dot${buffer.peer && !buffer.peer.online ? '.gone' : buffer.peer?.away ? '.away' : ''}`),
    h('span.nav-name', null, label),
    badge(buffer),
    buffer.type === 'channel' && swarm(buffer),
  );
}

function group(label, buffers, action) {
  return h(
    'section.nav-group',
    null,
    h('div.nav-heading', null, h('h2', null, label), action),
    buffers.length ? buffers.map((buffer) => row(buffer)) : h('p.nav-empty', null, label === 'Classes' ? (app.self.teacher ? 'Open your first class with the plus.' : 'Join a class with its code.') : 'Nobody yet.'),
  );
}

function selfMenu(anchor) {
  const { self } = app;
  menu(
    anchor,
    [
      { heading: self.nick, detail: self.teacher ? 'teacher' : self.registered ? 'registered' : 'guest' },
      self.away
        ? { label: 'Come back', run: () => app.run('away', { message: null }) }
        : { label: 'Set away', run: () => app.run('away', { message: 'Away' }) },
      !self.registered && { label: 'Keep this name…', run: () => app.emit('compose', { prefill: '/register ' }) },
      self.registered && !self.teacher && app.server.rules?.teacherCode && { label: 'I am a teacher…', run: () => app.emit('compose', { prefill: '/teacher ' }) },
      { label: 'Change nick…', run: () => app.emit('compose', { prefill: '/nick ' }) },
      null,
      {
        label: 'Dusk theme', checked: document.documentElement.dataset.theme === 'dusk',
        run: () => app.setTheme(document.documentElement.dataset.theme === 'dusk' ? 'day' : 'dusk'),
      },
      {
        label: 'Notify me of mentions', checked: app.settings.notify,
        run: () => app.emit('toggle-notify'),
      },
      {
        label: 'Flock in the header', checked: app.settings.flock,
        run: () => app.setSetting('flock', !app.settings.flock),
      },
      {
        label: 'Show joins and leaves', checked: app.settings.showJoins,
        run: () => app.setSetting('showJoins', !app.settings.showJoins),
      },
      null,
      { label: 'Sign out', run: () => app.signOut(), danger: true },
    ],
    { side: 'top' },
  );
}

function render() {
  if (!app.self) return;
  const status = app.buffers.get('*');
  const { self } = app;
  fill(
    el,
    h(
      'div.sidebar-head',
      null,
      h('p.brand', null, mark(), h('span.brand-name', null, app.server.name)),
      h('button.icon-button', { type: 'button', title: 'Jump to… (Ctrl K)', 'aria-label': 'Jump to a channel or person', on: { click: () => app.emit('dialog', 'jump') } }, icon('search')),
    ),
    h(
      'nav.nav',
      null,
      group('Classes', app.list('channel'), h('button.icon-button', { type: 'button', title: self.teacher ? 'Open or join a class' : 'Join a class', 'aria-label': self.teacher ? 'Open or join a class' : 'Join a class', on: { click: () => app.emit('dialog', 'jump') } }, icon('plus'))),
      group('Direct messages', app.list('dm'), h('button.icon-button', { type: 'button', title: 'Message someone', 'aria-label': 'Message someone', on: { click: () => app.emit('dialog', 'jump') } }, icon('plus'))),
      h('section.nav-group', null, h('div.nav-heading', null, h('h2', null, 'Server')), row(status, 'Status')),
    ),
    h(
      'button.self-row',
      { type: 'button', 'aria-haspopup': 'menu', 'aria-label': `${self.nick}, settings`, on: { click: (event) => selfMenu(event.currentTarget) } },
      h(`span.dot.self${self.away ? '.away' : ''}`),
      h('span.self-text', null, h('span.self-nick', null, self.nick), h('span.self-state', null, self.away ? `away: ${self.away}` : self.teacher ? 'teacher' : self.registered ? 'registered' : 'guest')),
      icon('more'),
    ),
  );
}

for (const name of ['buffers', 'active', 'self', 'settings', 'theme', 'members']) app.on(name, render);
app.on('phase', ({ phase }) => {
  if (phase === 'online') render();
});
