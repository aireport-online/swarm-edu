import { app } from '../app.js';
import { nickHue } from '../format.js';
import { $, fill, h, icon } from './dom.js';
import { menu } from './overlay.js';

const el = $('#sidebar');
const closeDrawer = () => document.body.classList.remove('nav-open');

function badge(buffer) {
  if (!buffer.unread) return null;
  const label = buffer.unread > 99 ? '99+' : String(buffer.unread);
  return h(`span.badge${buffer.mentions ? '.ping' : ''}`, { 'aria-label': `${buffer.unread} unread` }, label);
}

function row(buffer, label = buffer.name) {
  const active = buffer.key === app.activeKey;
  const dm = buffer.type === 'dm';
  return h(
    `button.nav-row${active ? '.active' : ''}${buffer.unread ? '.unread' : ''}${dm && buffer.peer && !buffer.peer.online ? '.offline' : ''}`,
    {
      type: 'button',
      'aria-current': active ? 'page' : null,
      on: { click: () => { app.activate(buffer.key); closeDrawer(); } },
    },
    dm && h('span.dot', { style: { '--hue': nickHue(buffer.name) } }),
    h('span.nav-name', null, label),
    badge(buffer),
  );
}

function group(label, buffers, action) {
  return h(
    'section.nav-group',
    null,
    h('div.nav-heading', null, h('h2', null, label), action),
    buffers.length ? buffers.map((buffer) => row(buffer)) : h('p.nav-empty', null, label === 'Channels' ? 'No channels yet.' : 'Nobody yet.'),
  );
}

function selfMenu(anchor) {
  const { self } = app;
  menu(
    anchor,
    [
      { heading: self.nick, detail: self.registered ? 'registered' : 'guest' },
      self.away
        ? { label: 'Come back', run: () => app.run('away', { message: null }) }
        : { label: 'Set away', run: () => app.run('away', { message: 'Away' }) },
      !self.registered && { label: 'Register this nick…', run: () => app.emit('compose', { prefill: '/register ' }) },
      { label: 'Change nick…', run: () => app.emit('compose', { prefill: '/nick ' }) },
      null,
      {
        label: 'Light theme', checked: document.documentElement.dataset.theme === 'light',
        run: () => app.setTheme(document.documentElement.dataset.theme === 'light' ? 'dark' : 'light'),
      },
      {
        label: 'Notify me of mentions', checked: app.settings.notify,
        run: () => app.emit('toggle-notify'),
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
      h('p.brand', null, h('span.brand-mark', { 'aria-hidden': 'true' }), h('span.brand-name', null, app.server.name)),
      h('button.icon-button', { type: 'button', title: 'Jump to… (Ctrl K)', 'aria-label': 'Jump to a channel or person', on: { click: () => app.emit('dialog', 'jump') } }, icon('search')),
    ),
    h(
      'nav.nav',
      null,
      group('Channels', app.list('channel'), h('button.icon-button', { type: 'button', title: 'Join a channel', 'aria-label': 'Join a channel', on: { click: () => app.emit('dialog', 'jump') } }, icon('plus'))),
      group('Direct messages', app.list('dm'), h('button.icon-button', { type: 'button', title: 'Message someone', 'aria-label': 'Message someone', on: { click: () => app.emit('dialog', 'jump') } }, icon('plus'))),
      h('section.nav-group', null, h('div.nav-heading', null, h('h2', null, 'Server')), row(status, 'Status')),
    ),
    h(
      'button.self',
      { type: 'button', 'aria-haspopup': 'menu', on: { click: (event) => selfMenu(event.currentTarget) } },
      h('span.dot', { style: { '--hue': nickHue(self.nick) } }),
      h('span.self-text', null, h('span.self-nick', null, self.nick), h('span.self-state', null, self.away ? `away: ${self.away}` : self.registered ? 'registered' : 'guest')),
      icon('more'),
    ),
  );
}

for (const name of ['buffers', 'active', 'self', 'settings', 'theme']) app.on(name, render);
app.on('phase', ({ phase }) => {
  if (phase === 'online') render();
});
