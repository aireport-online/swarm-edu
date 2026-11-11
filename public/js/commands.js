import { app } from './app.js';
import { formatAgo, formatWhen } from './format.js';

const channelOf = (buffer) => {
  if (buffer.type !== 'channel') throw new Error('That only works in a channel.');
  return buffer.name;
};
const need = (value, usage) => {
  if (!value) throw new Error(`Usage: ${usage}`);
  return value;
};
const words = (text) => text.split(/\s+/).filter(Boolean);
const say = (text, kind = 'info') => app.note(app.active, kind, text);

const role = (mode, add) => ({
  usage: `<nick> [nick…]`,
  run(rest, buffer) {
    const nicks = words(need(rest, `<nick>`));
    return app.run('mode', { channel: channelOf(buffer), changes: nicks.map((arg) => ({ add, mode, arg })) });
  },
});

/**
 * Every slash command. `usage` and `help` feed /help and the autocomplete;
 * `run` gets the text after the command and the buffer it was typed in.
 */
const onOff = (rest, current) => (rest === 'on' ? true : rest === 'off' ? false : !current);

/** "Question | A | *B | C": the star marks the right answer of a quiz. */
function parsePoll(rest, usage) {
  const [question, ...options] = rest.split('|').map((part) => part.trim());
  if (!question || options.length < 2) throw new Error(`Usage: ${usage}`);
  const right = options.findIndex((option) => option.startsWith('*'));
  return { question, options: options.map((option) => option.replace(/^\*\s*/, '')), correct: right < 0 ? null : right };
}

export const COMMANDS = {
  joincode: {
    usage: '<code>', help: 'Join a class with the code from your teacher',
    run: (rest) => app.joinCode(need(rest, '/joincode <code>')),
  },
  hand: {
    usage: '', help: 'Raise your hand, or lower it',
    run(rest, buffer) {
      const up = !buffer.hands.some((nick) => app.isSelf(nick));
      return app.run('hand', { channel: channelOf(buffer), up });
    },
  },
  class: {
    usage: '<name>', help: 'Teachers: open a class (it gets a code)',
    run: (rest) => app.join(need(words(rest)[0], '/class <name>')),
  },
  code: {
    usage: '[new|off]', help: 'Teachers: show the class code, make a new one, or remove it',
    async run(rest, buffer) {
      const channel = channelOf(buffer);
      if (rest === 'new' || rest === 'off') {
        const result = await app.run('code', { channel, action: rest });
        if (result) say(result.code ? `The new code of ${channel} is ${result.code}. The old one no longer works.` : `${channel} has no code now.`);
        return;
      }
      say(buffer.code ? `The code of ${channel} is ${buffer.code}.` : app.runs(buffer) ? `${channel} has no code. /code new gives it one.` : 'Ask your teacher for the code.');
    },
  },
  quiet: {
    usage: '[on|off]', help: 'Teachers: quiet mode, where students raise a hand to speak',
    run: (rest, buffer) => app.setFlag('m', onOff(rest, channelOf(buffer) && buffer.modes.includes('m')), buffer),
  },
  lock: {
    usage: '[on|off]', help: 'Teachers: lock the class so nobody new can join',
    run: (rest, buffer) => app.setFlag('i', onOff(rest, channelOf(buffer) && buffer.modes.includes('i')), buffer),
  },
  floor: { help: 'Teachers: let a student write during quiet mode', ...role('v', true) },
  poll: {
    usage: '<question> | <option> | <option> …', help: 'Teachers: ask the class; results show once you have voted',
    run: (rest, buffer) => app.run('poll', { channel: channelOf(buffer), ...parsePoll(rest, '/poll Question | Option | Option') }),
  },
  quiz: {
    usage: '<question> | <option> | *<right option> …', help: 'Teachers: a poll with a right answer, hidden until you close it',
    run(rest, buffer) {
      const poll = parsePoll(rest, '/quiz Question | Option | *Right option');
      if (poll.correct == null) throw new Error('Put a * in front of the right option.');
      return app.run('poll', { channel: channelOf(buffer), ...poll });
    },
  },
  unpin: {
    usage: '', help: 'Teachers: take the pinned message down',
    run: (rest, buffer) => app.run('pin', { channel: channelOf(buffer), msgId: null }),
  },
  teacher: {
    usage: '<staff code>', help: 'Staff: turn your registered name into a teacher account',
    async run(rest) {
      const self = await app.request('teacher', { code: need(rest, '/teacher <staff code>') });
      app.self = self;
      app.emit('self');
      say('You are a teacher now. Open a class with /class <name>.');
    },
  },
  join: {
    usage: '<#class> [code]', help: 'Join a class by name',
    run(rest) {
      const [name, code] = words(rest);
      return app.join(need(name, '/join <#class> [code]'), code);
    },
  },
  part: {
    usage: '[reason]', help: 'Leave this class',
    run: (rest, buffer) => app.run('part', { channel: channelOf(buffer), reason: rest }),
  },
  close: { usage: '', help: 'Close this conversation or leave this class', run: (rest, buffer) => app.close(buffer) },
  msg: {
    usage: '<nick> <text>', help: 'Send a private message',
    async run(rest) {
      const [, nick, text] = /^(\S+)\s+([\s\S]+)$/.exec(rest) ?? [];
      need(text, '/msg <nick> <text>');
      if (nick.startsWith('#') && !app.buffers.has(nick.toLowerCase())) throw new Error(`You are not in ${nick}.`);
      // Sent before any window opens for it: a refusal is shown here, where it was typed.
      await app.request('send', { target: nick, text });
      if (nick.startsWith('#')) app.activate(nick.toLowerCase());
      else app.openDm(nick);
    },
  },
  query: {
    usage: '<nick>', help: 'Open a private conversation',
    run: (rest) => app.openDm(need(words(rest)[0], '/query <nick>')),
  },
  me: {
    usage: '<action>', help: 'Say what you are doing: /me waves',
    run: (rest) => app.send(need(rest, '/me <action>'), { kind: 'action' }),
  },
  nick: {
    usage: '<new nick>', help: 'Change your nick',
    run: (rest) => app.run('nick', { nick: need(words(rest)[0], '/nick <new nick>') }),
  },
  topic: {
    usage: '[text]', help: 'Show or change the topic',
    run(rest, buffer) {
      const channel = channelOf(buffer);
      if (rest) return app.run('topic', { channel, topic: rest });
      say(buffer.topic ? `Topic: ${buffer.topic}${buffer.topicBy ? ` (set by ${buffer.topicBy})` : ''}` : 'No topic is set.');
    },
  },
  whois: {
    usage: '<nick>', help: 'Who is this?',
    async run(rest, buffer) {
      const nick = words(rest)[0] ?? (buffer.type === 'dm' ? buffer.name : null);
      const who = await app.request('whois', { nick: need(nick, '/whois <nick>') });
      const lines = [`${who.nick} is ${who.registered ? 'a registered nick' : 'a guest'}.`];
      if (who.online) {
        lines.push(`Online for ${formatAgo(Date.now() - who.connectedAt)}, last active ${formatAgo(Date.now() - who.lastActive)} ago.`);
      } else if (who.lastSeen) {
        lines.push(`Offline, last seen ${formatWhen(who.lastSeen)}.`);
      }
      if (who.away) lines.push(`Away: ${who.away}`);
      if (who.channels.length) {
        lines.push(`In ${who.channels.map((c) => (c.role === 'op' ? '@' : c.role === 'voice' ? '+' : '') + c.name).join(' ')}`);
      }
      say(lines.join('\n'));
    },
  },
  list: { usage: '', help: 'Find a class or a person', run: () => app.emit('dialog', 'jump') },
  search: {
    usage: '<text>', help: 'Search your classes and conversations',
    run: (rest) => app.emit('dialog', { name: 'search', query: rest }),
  },
  away: {
    usage: '[message]', help: 'Mark yourself away; without a message, come back',
    async run(rest) {
      if (await app.run('away', { message: rest || null })) say(rest ? `You are away: ${rest}` : 'You are back.');
    },
  },
  back: { usage: '', help: 'You are no longer away', run: () => COMMANDS.away.run('') },
  register: {
    usage: '<password>', help: 'Keep your name and classes: turn the name into an account',
    async run(rest) {
      const result = await app.request('register', { password: need(rest, '/register <password>') });
      app.self = result.self;
      if (result.token) app.stored.set('token', result.token);
      app.emit('self');
      say(`${result.self.nick} is now registered. Sign in with this password next time.`);
    },
  },
  kick: {
    usage: '<nick> [reason]', help: 'Teachers: remove someone from the class',
    run(rest, buffer) {
      const [, nick, reason = ''] = /^(\S+)\s*([\s\S]*)$/.exec(rest) ?? [];
      return app.run('kick', { channel: channelOf(buffer), nick: need(nick, '/kick <nick> [reason]'), reason });
    },
  },
  ban: { help: 'Ban a nick from the channel', ...role('b', true) },
  unban: { help: 'Lift a ban', ...role('b', false) },
  kickban: {
    usage: '<nick> [reason]', help: 'Ban and remove someone',
    async run(rest, buffer) {
      const [, nick, reason = ''] = /^(\S+)\s*([\s\S]*)$/.exec(rest) ?? [];
      const channel = channelOf(buffer);
      await app.request('mode', { channel, changes: [{ add: true, mode: 'b', arg: need(nick, '/kickban <nick> [reason]') }] });
      await app.request('kick', { channel, nick, reason });
    },
  },
  bans: {
    usage: '', help: 'List the bans of this channel',
    async run(rest, buffer) {
      const { bans } = await app.request('bans', { channel: channelOf(buffer) });
      say(bans.length ? `Banned: ${bans.map((ban) => `${ban.nick} (by ${ban.by})`).join(', ')}` : 'Nobody is banned.');
    },
  },
  op: { help: 'Make someone an operator', ...role('o', true) },
  deop: { help: 'Take operator status away', ...role('o', false) },
  voice: { help: 'Same as /floor', ...role('v', true) },
  devoice: { help: 'Take voice away', ...role('v', false) },
  mode: {
    usage: '<+flags|-flags> [nick…]', help: 'The IRC way: t topic, m quiet, i locked, k code, o v b',
    run(rest, buffer) {
      const [flags, ...args] = words(rest);
      const channel = channelOf(buffer);
      if (!flags) return say(`Modes of ${channel}: +${buffer.modes || ''}`);
      const changes = [];
      let add = true;
      for (const flag of flags) {
        if (flag === '+' || flag === '-') add = flag === '+';
        else changes.push({ add, mode: flag, ...('ovb'.includes(flag) ? { arg: args.shift() } : {}) });
      }
      return app.run('mode', { channel, changes });
    },
  },
  invite: {
    usage: '<nick>', help: 'Invite someone to this channel',
    async run(rest, buffer) {
      const nick = need(words(rest)[0], '/invite <nick>');
      await app.request('invite', { channel: channelOf(buffer), nick });
      say(`Invited ${nick}.`);
    },
  },
  clear: {
    usage: '', help: 'Clear this window (history stays on the server)',
    run(rest, buffer) {
      buffer.items = [];
      buffer.hasMore = buffer.type !== 'status';
      app.emit('items', { buffer, kind: 'reset' });
    },
  },
  quit: { usage: '', help: 'Sign out', run: () => app.signOut() },
  help: {
    usage: '', help: 'Show this list',
    run() {
      const lines = Object.entries(COMMANDS).map(([name, c]) => `/${name}${c.usage ? ` ${c.usage}` : ''}  ${c.help}`);
      say(`${lines.join('\n')}\nTab completes nicks, commands and channels. Up and Down recall what you typed.`);
    },
  },
};

const ALIASES = { j: 'join', leave: 'part', q: 'query', w: 'whois', signout: 'quit', logout: 'quit', pol: 'poll' };

/**
 * Handles one line from the composer.
 * @returns {Promise<boolean>} false when the input should stay in the box
 */
export async function submit(input, { replyTo = null } = {}) {
  const buffer = app.active;
  // "//" at the start sends a message that begins with a slash.
  if (!input.startsWith('/') || input.startsWith('//')) {
    return app.send(input.startsWith('//') ? input.slice(1) : input, { replyTo });
  }
  const [, word, rest = ''] = /^\/(\S*)\s*([\s\S]*)$/.exec(input);
  const name = ALIASES[word.toLowerCase()] ?? word.toLowerCase();
  if (!Object.hasOwn(COMMANDS, name)) {
    say(`Unknown command /${word}. Type /help for the list.`, 'error');
    return false;
  }
  try {
    await COMMANDS[name].run(rest.trim(), buffer);
    return true;
  } catch (err) {
    say(err.message, 'error');
    return false;
  }
}
