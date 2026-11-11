import { app } from '../app.js';
import { $, fill, h, icon } from './dom.js';
import { menu } from './overlay.js';

const el = $('#members');
const SIGIL = { op: '@', voice: '+' };

/** The actions one can take on a person, from wherever their nick is shown. */
export function userMenu(nick, anchor, buffer = app.active) {
  const member = buffer.type === 'channel' ? buffer.members.get(nick.toLowerCase()) : null;
  const iRun = app.runs(buffer);
  const self = app.isSelf(nick);
  const hasHand = buffer.hands.some((hand) => hand.toLowerCase() === nick.toLowerCase());
  const mode = (flag, add) => () => app.run('mode', { channel: buffer.name, changes: [{ add, mode: flag, arg: nick }] });
  const state = member && [
    member.teacher ? 'teacher' : null,
    member.role === 'voice' ? 'has the floor' : null,
    member.online ? (member.away ? 'away' : 'online') : 'offline',
  ].filter(Boolean).join(', ');
  menu(anchor, [
    { heading: nick, detail: state || '' },
    !self && app.mayMessage(nick) && { label: 'Message', run: () => app.openDm(nick) },
    { label: 'Who is this?', run: () => app.emit('command', `/whois ${nick}`) },
    !self && { label: 'Mention', run: () => app.emit('compose', { insert: `${nick}: ` }) },
    iRun && member && !self && null,
    iRun && member && member.role !== 'op' && (member.role === 'voice'
      ? { label: 'Take the floor back', run: mode('v', false) }
      : { label: 'Give the floor', run: mode('v', true) }),
    iRun && hasHand && { label: 'Lower the hand', run: () => app.run('hand', { channel: buffer.name, up: false, nick }) },
    iRun && member && !self && (member.role === 'op'
      ? { label: 'Stop them running the class', run: mode('o', false) }
      : { label: 'Let them run the class', run: mode('o', true) }),
    iRun && member && !self && { label: 'Remove from the class', danger: true, run: () => app.run('kick', { channel: buffer.name, nick }) },
    iRun && member && !self && { label: 'Ban', danger: true, run: mode('b', true) },
  ]);
}

function person(member, raised = false) {
  return h(
    `button.person${member.online ? '' : '.offline'}${member.away ? '.away' : ''}`,
    {
      type: 'button',
      title: member.away ? `Away: ${member.away}` : null,
      on: { click: (event) => userMenu(member.nick, event.currentTarget) },
    },
    h(`span.dot${app.isSelf(member.nick) ? '.self' : ''}${!member.online ? '.gone' : member.away ? '.away' : ''}`),
    h('span.person-nick', null, SIGIL[member.role] && h('span.sigil', null, SIGIL[member.role]), member.nick),
    raised && h('span.person-hand', { title: 'Hand up' }, icon('hand', 15)),
  );
}

function render() {
  const buffer = app.active;
  if (!buffer || buffer.type !== 'channel') return fill(el);
  const members = [...buffer.members.values()].sort((a, b) => a.nick.localeCompare(b.nick));
  const online = members.filter((member) => member.online);
  const staff = (member) => member.role === 'op' || member.teacher;
  // Hands first, in the order they went up: that is the queue.
  const hands = buffer.hands.map((nick) => buffer.members.get(nick.toLowerCase())).filter(Boolean);
  const groups = [
    ['Hands up', hands, true],
    ['Teachers', online.filter(staff)],
    ['Has the floor', online.filter((member) => !staff(member) && member.role === 'voice')],
    ['Students', online.filter((member) => !staff(member) && !member.role)],
    ['Offline', members.filter((member) => !member.online)],
  ];
  fill(
    el,
    groups
      .filter(([, list]) => list.length)
      .map(([label, list, raised]) =>
        h(`section.people-group${raised ? '.hands' : ''}`, null, h('h2', null, label, h('span.count', null, String(list.length))), list.map((member) => person(member, raised))),
      ),
  );
}

app.on('members', render);
app.on('active', render);
