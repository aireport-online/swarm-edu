import { app } from '../app.js';
import { Flock } from '../swarm.js';
import { $, fill, h, icon } from './dom.js';

const el = $('#topbar');
const MODE_WORDS = { m: 'quiet mode', i: 'locked' };

// The conversation's flock: one bird per person who is here, you in colour.
// It swells where someone speaks. The canvas outlives every redraw of the bar.
const canvas = h('canvas.topbar-flock', { 'aria-hidden': 'true' });
const flock = new Flock(canvas);

function birds(buffer) {
  if (buffer.type === 'channel') {
    return [...buffer.members.values()]
      .filter((member) => member.online)
      .slice(0, 120)
      .map((member) => ({ id: member.nick.toLowerCase(), self: app.isSelf(member.nick) }));
  }
  if (buffer.type === 'dm') {
    const me = { id: app.self.nick.toLowerCase(), self: true };
    return buffer.peer?.online ? [me, { id: buffer.key }] : [me];
  }
  return [];
}

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
  const quiet = buffer.modes.includes('m');
  flock.setBirds(birds(buffer));
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
    canvas,
    app.phase === 'reconnecting' && h('p.offline-note', { role: 'status' }, 'Reconnecting…'),
    h(
      'div.topbar-actions',
      null,
      // For whoever runs the class: quiet mode in one press, and the class itself.
      app.runs(buffer) &&
        h(
          `button.people-toggle.quiet-toggle${quiet ? '.on' : ''}`,
          {
            type: 'button', 'aria-pressed': String(quiet), title: quiet ? 'Quiet mode is on: let everyone write again' : 'Quiet mode: only you write, students raise a hand',
            on: { click: () => app.setFlag('m', !quiet, buffer) },
          },
          icon(quiet ? 'quiet' : 'sound', 18),
          h('span', null, quiet ? 'Quiet' : 'Open'),
        ),
      app.runs(buffer) &&
        h(
          'button.people-toggle.class-button',
          { type: 'button', title: 'Class code, the board view, reports and who took part', on: { click: () => app.emit('dialog', 'class') } },
          icon('board', 18),
          h('span', null, buffer.code ? `${buffer.code.slice(0, 3)} ${buffer.code.slice(3)}` : 'Class'),
          buffer.reports.length > 0 && h('span.badge', { 'aria-label': `${buffer.reports.length} reported` }, String(buffer.reports.length)),
        ),
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

for (const name of ['active', 'header', 'members', 'phase', 'school']) app.on(name, render);
app.on('items', ({ buffer, kind, item }) => {
  if (buffer === app.active && kind === 'append' && !item.local) flock.pulse(item.nick.toLowerCase());
});
app.on('theme', () => requestAnimationFrame(() => flock.readColours()));
app.on('settings', () => requestAnimationFrame(() => flock.wake()));
