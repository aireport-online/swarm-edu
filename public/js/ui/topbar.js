import { app } from '../app.js';
import { $, fill, h, icon } from './dom.js';

const el = $('#topbar');
const MODE_WORDS = { m: 'moderated', i: 'invite-only' };

function subtitle(buffer) {
  if (buffer.type === 'channel') {
    const iAmOp = buffer.members.get(app.self.nick.toLowerCase())?.role === 'op';
    const canEdit = iAmOp || !buffer.modes.includes('t');
    const text = buffer.topic || (canEdit ? 'Add a topic' : 'No topic');
    return canEdit
      ? h(`button.topic${buffer.topic ? '' : '.empty'}`, { type: 'button', title: 'Change the topic', on: { click: () => app.emit('compose', { prefill: `/topic ${buffer.topic}` }) } }, text)
      : h('p.topic', { title: buffer.topic }, text);
  }
  if (buffer.type === 'dm') {
    const peer = buffer.peer;
    const state = !peer ? '' : !peer.online ? 'offline' : peer.away ? `away: ${peer.away}` : 'online';
    return h('p.topic', null, state);
  }
  return h('p.topic', null, 'What the server has to say');
}

function render() {
  const buffer = app.active;
  if (!buffer || !app.self) return;
  const online = [...buffer.members.values()].filter((member) => member.online).length;
  const flags = [...buffer.modes].map((flag) => MODE_WORDS[flag]).filter(Boolean);
  fill(
    el,
    h('button.icon-button.nav-toggle', { type: 'button', 'aria-label': 'Conversations', on: { click: () => document.body.classList.toggle('nav-open') } }, icon('menu', 20)),
    h(
      'div.topbar-title',
      null,
      h('h1', null, buffer.type === 'status' ? 'Status' : buffer.name),
      flags.map((flag) => h('span.tag', null, flag)),
      subtitle(buffer),
    ),
    app.phase === 'reconnecting' && h('p.offline-note', { role: 'status' }, 'Reconnecting…'),
    h(
      'div.topbar-actions',
      null,
      h('button.icon-button', { type: 'button', title: 'Search', 'aria-label': 'Search messages', on: { click: () => app.emit('dialog', { name: 'search' }) } }, icon('search', 18)),
      buffer.type === 'channel' &&
        h(
          'button.people-toggle',
          {
            type: 'button', title: 'People', 'aria-label': `${online} people online, show or hide the list`,
            on: { click: () => app.emit('toggle-members') },
          },
          icon('people', 18),
          h('span', null, String(online)),
        ),
    ),
  );
}

for (const name of ['active', 'header', 'members', 'phase']) app.on(name, render);
