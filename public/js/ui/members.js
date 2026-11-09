import { app } from '../app.js';
import { nickHue } from '../format.js';
import { $, fill, h } from './dom.js';
import { menu } from './overlay.js';

const el = $('#members');
const SIGIL = { op: '@', voice: '+' };

/** The actions one can take on a person, from wherever their nick is shown. */
export function userMenu(nick, anchor, buffer = app.active) {
  const member = buffer.type === 'channel' ? buffer.members.get(nick.toLowerCase()) : null;
  const me = buffer.type === 'channel' ? buffer.members.get(app.self.nick.toLowerCase()) : null;
  const iAmOp = me?.role === 'op';
  const self = app.isSelf(nick);
  const mode = (flag, add) => () => app.run('mode', { channel: buffer.name, changes: [{ add, mode: flag, arg: nick }] });
  menu(anchor, [
    { heading: nick, detail: member ? [member.role === 'op' ? 'operator' : member.role === 'voice' ? 'voiced' : null, member.online ? (member.away ? 'away' : 'online') : 'offline'].filter(Boolean).join(', ') : '' },
    !self && { label: 'Message', run: () => app.openDm(nick) },
    { label: 'Who is this?', run: () => app.emit('command', `/whois ${nick}`) },
    !self && { label: 'Mention', run: () => app.emit('compose', { insert: `${nick}: ` }) },
    iAmOp && member && !self && null,
    iAmOp && member && (member.role === 'op'
      ? { label: 'Take operator status', run: mode('o', false) }
      : { label: 'Make operator', run: mode('o', true) }),
    iAmOp && member && member.role !== 'op' && (member.role === 'voice'
      ? { label: 'Take voice', run: mode('v', false) }
      : { label: 'Give voice', run: mode('v', true) }),
    iAmOp && member && !self && { label: 'Kick', danger: true, run: () => app.run('kick', { channel: buffer.name, nick }) },
    iAmOp && member && !self && { label: 'Ban', danger: true, run: mode('b', true) },
  ]);
}

function person(member) {
  return h(
    `button.person${member.online ? '' : '.offline'}${member.away ? '.away' : ''}`,
    {
      type: 'button',
      title: member.away ? `Away: ${member.away}` : null,
      on: { click: (event) => userMenu(member.nick, event.currentTarget) },
    },
    h('span.dot', { style: { '--hue': nickHue(member.nick) } }),
    h('span.person-nick', null, SIGIL[member.role] && h('span.sigil', null, SIGIL[member.role]), member.nick),
  );
}

function render() {
  const buffer = app.active;
  if (!buffer || buffer.type !== 'channel') return fill(el);
  const members = [...buffer.members.values()].sort((a, b) => a.nick.localeCompare(b.nick));
  const online = members.filter((member) => member.online);
  const groups = [
    ['Operators', online.filter((member) => member.role === 'op')],
    ['Voiced', online.filter((member) => member.role === 'voice')],
    ['Members', online.filter((member) => !member.role)],
    ['Offline', members.filter((member) => !member.online)],
  ];
  fill(
    el,
    groups
      .filter(([, list]) => list.length)
      .map(([label, list]) => h('section.people-group', null, h('h2', null, label, h('span.count', null, String(list.length))), list.map(person))),
  );
}

app.on('members', render);
app.on('active', render);
