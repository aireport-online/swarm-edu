import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { connect } from 'node:net';
import { after, before, test } from 'node:test';
import { WebSocket } from 'ws';
import { wrapForIrc } from '../src/gateways/irc.js';
import { createApp } from '../src/server.js';

const PASSWORD = 'correct horse';
let app;
let ports;
const open = [];

before(async () => {
  app = createApp(
    {
      host: '127.0.0.1', port: 0, ircPort: -1, dbPath: ':memory:', trustProxy: false,
      hub: { serverName: 'Test Net', motd: 'Hello there.', defaultChannels: ['#lobby'], graceMs: 0, messageBurst: 1000 },
    },
    { log: () => {} },
  );
  ports = await app.start();
});

after(async () => {
  for (const close of open) close();
  await app.stop();
});

/** A web client: `request()` resolves with the reply, events pile up in `events`. */
async function web(hello) {
  const ws = new WebSocket(`ws://127.0.0.1:${ports.http}/ws`);
  const pending = new Map();
  const waiters = [];
  const client = {
    ws,
    events: [],
    request(op, params = {}) {
      const id = pending.size + Math.random();
      ws.send(JSON.stringify({ id, op, ...params }));
      return new Promise((resolve, reject) => {
        pending.set(id, (reply) => (reply.ok ? resolve(reply.data) : reject(Object.assign(new Error(reply.error.message), reply.error))));
      });
    },
    /** Resolves with the first event (past or future) the predicate accepts. */
    event(predicate) {
      const seen = client.events.find(predicate);
      if (seen) return Promise.resolve(seen);
      return new Promise((resolve) => waiters.push({ predicate, resolve }));
    },
  };
  ws.on('message', (data) => {
    const message = JSON.parse(data);
    if (message.type === 'reply') return pending.get(message.id)?.(message);
    client.events.push(message);
    for (const waiter of [...waiters]) {
      if (waiter.predicate(message)) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve(message);
      }
    }
  });
  open.push(() => ws.terminate());
  await new Promise((resolve, reject) => ws.once('open', resolve).once('error', reject));
  if (hello) client.snapshot = await client.request('hello', hello);
  return client;
}

/** An IRC client: `line()` resolves with the first line matching a pattern. */
async function irc(...commands) {
  const socket = connect(ports.irc, '127.0.0.1');
  socket.setEncoding('utf8');
  const lines = [];
  const waiters = [];
  let buffer = '';
  socket.on('data', (chunk) => {
    buffer += chunk;
    const parts = buffer.split('\r\n');
    buffer = parts.pop();
    for (const line of parts) {
      lines.push(line);
      for (const waiter of [...waiters]) {
        if (waiter.pattern.test(line)) {
          waiters.splice(waiters.indexOf(waiter), 1);
          waiter.resolve(line);
        }
      }
    }
  });
  open.push(() => socket.destroy());
  await new Promise((resolve, reject) => socket.once('connect', resolve).once('error', reject));
  const client = {
    socket,
    lines,
    send: (...list) => socket.write(list.map((line) => `${line}\r\n`).join('')),
    line(pattern, { fresh = false } = {}) {
      const seen = fresh ? null : lines.find((line) => pattern.test(line));
      if (seen) return Promise.resolve(seen);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`No line matched ${pattern}\n${lines.join('\n')}`)), 2000);
        waiters.push({ pattern, resolve: (line) => (clearTimeout(timer), resolve(line)) });
      });
    },
  };
  client.send(...commands);
  return client;
}

test('http serves the client, its info and nothing outside the public folder', async () => {
  const base = `http://127.0.0.1:${ports.http}`;
  const page = await fetch(base);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /text\/html/);
  assert.match(page.headers.get('content-security-policy'), /default-src 'self'/);
  assert.deepEqual(await (await fetch(`${base}/api/info`)).json(), { name: 'Test Net', version: JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version, ircPort: ports.irc });
  assert.equal((await (await fetch(`${base}/healthz`)).json()).ok, true);
  assert.equal((await fetch(`${base}/%2e%2e/package.json`)).status, 404);
  assert.equal((await fetch(`${base}/..%2fsrc/server.js`)).status, 404);
  assert.equal((await fetch(base, { method: 'POST' })).status, 405);
});

test('websocket: requests need a sign-in, then chat flows between clients', async () => {
  const stranger = await web();
  await assert.rejects(stranger.request('join', { channel: '#x' }), { code: 'not_signed_in' });
  await assert.rejects(stranger.request('hello', { nick: '!' }), { code: 'invalid_nick' });

  const ada = await web({ nick: 'ada' });
  const bob = await web({ nick: 'bob' });
  assert.equal(ada.snapshot.server.name, 'Test Net');
  await assert.rejects(ada.request('launch', {}), { code: 'bad_request' });

  const { id } = await ada.request('send', { target: '#lobby', text: 'hello bob' });
  const heard = await bob.event((e) => e.type === 'message' && e.msg.id === id);
  assert.equal(heard.msg.text, 'hello bob');
  assert.equal('meta' in heard, false);

  await bob.request('react', { msgId: id, emoji: '🎉' });
  const update = await ada.event((e) => e.type === 'message_update');
  assert.deepEqual(update.msg.reactions, [{ emoji: '🎉', nicks: ['bob'] }]);

  const page = await bob.request('history', { target: '#lobby' });
  assert.equal(page.messages.at(-1).id, id);

  ada.ws.close();
  assert.equal((await bob.event((e) => e.type === 'quit')).nick, 'ada');
});

test('websocket: register, resume by token, and sign out', async () => {
  const cy = await web({ nick: 'cy' });
  const { token } = await cy.request('register', { password: PASSWORD });
  cy.ws.close();

  const resumed = await web({ token });
  assert.deepEqual(resumed.snapshot.self, { nick: 'cy', registered: true, away: null });
  await resumed.request('logout');
  await assert.rejects((await web()).request('hello', { token }), { code: 'bad_token' });
  await assert.rejects((await web()).request('hello', { nick: 'cy', password: 'not the one' }), { code: 'bad_password' });
});

test('irc: a client registers, joins, talks and is heard on the web', async () => {
  const dee = await web({ nick: 'dee' });
  const client = await irc('CAP LS 302', 'NICK eli', 'USER eli 0 * :Eli', 'CAP REQ :server-time', 'CAP END');
  await client.line(/ 001 eli :Welcome to Test Net/);
  await client.line(/ 372 eli :- Hello there\./);
  await client.line(/^:eli!eli@user\.swarm JOIN #lobby$/);
  assert.match(await client.line(/ 353 eli = #lobby :/), /\beli\b/);
  assert.equal((await dee.event((e) => e.type === 'join' && e.member.nick === 'eli')).channel, '#lobby');

  client.send('PRIVMSG #lobby :hello from irc', 'PRIVMSG #lobby :\x01ACTION waves\x01');
  assert.equal((await dee.event((e) => e.type === 'message' && e.msg.text === 'hello from irc')).msg.nick, 'eli');
  assert.equal((await dee.event((e) => e.type === 'message' && e.msg.text === 'waves')).msg.kind, 'action');

  await dee.request('send', { target: '#lobby', text: 'hi eli\nsecond line' });
  assert.match(await client.line(/PRIVMSG #lobby :hi eli$/), /^@time=\d{4}-\d\d-\d\dT[\d:.]+Z :dee!dee@user\.swarm /);
  await client.line(/PRIVMSG #lobby :second line$/);
  assert.equal(client.lines.some((line) => /PRIVMSG #lobby :hello from irc/.test(line)), false, 'no echo unless asked for');

  await dee.request('send', { target: 'eli', text: 'private' });
  await client.line(/:dee!dee@user\.swarm PRIVMSG eli :private$/);
  client.send('PRIVMSG dee :and back');
  assert.equal((await dee.event((e) => e.type === 'message' && e.msg.text === 'and back')).target, 'eli');

  client.send('JOIN #irc-made', 'TOPIC #irc-made :Made on IRC', 'MODE #irc-made +m', 'MODE #irc-made');
  await client.line(/^:eli!eli@user\.swarm TOPIC #irc-made :Made on IRC$/);
  await client.line(/ 324 eli #irc-made \+tm$/);
  const { channel } = await dee.request('join', { channel: '#irc-made' });
  assert.equal(channel.topic, 'Made on IRC');
  await client.line(/^:dee!dee@user\.swarm JOIN #irc-made$/);
  await assert.rejects(dee.request('send', { target: '#irc-made', text: 'may I?' }), { code: 'moderated' });
  client.send('MODE #irc-made +v dee');
  assert.equal((await dee.event((e) => e.type === 'mode' && e.changes[0].mode === 'v')).changes[0].role, 'voice');

  client.send('WHOIS dee', 'LIST', 'NAMES #irc-made', 'KICK #irc-made dee :out', 'NICK elijah', 'FROB');
  await client.line(/ 311 eli dee dee user\.swarm \* :dee$/);
  await client.line(/ 322 eli #irc-made 2 :Made on IRC$/);
  await client.line(/ 353 eli = #irc-made :@eli \+dee$/);
  await client.line(/^:eli!eli@user\.swarm KICK #irc-made dee :out$/);
  await client.line(/^:eli!eli@user\.swarm NICK :elijah$/);
  await client.line(/ 421 elijah FROB :Unknown command$/);
  assert.equal((await dee.event((e) => e.type === 'kick')).by, 'eli');
  assert.equal((await dee.event((e) => e.type === 'nick')).nick, 'elijah');

  // A quit reason cannot smuggle in a second line, and nothing is read after QUIT.
  const watcher = await irc('NICK gus', 'USER gus 0 * :Gus');
  await watcher.line(/ 001 gus /);
  client.send('QUIT :gone\r:NickServ!services@irc.swarm PRIVMSG gus :your password please', 'PRIVMSG #lobby :from beyond');
  assert.equal((await dee.event((e) => e.type === 'quit')).reason, 'Quit: gone :NickServ!services@irc.swarm PRIVMSG gus :your password please');
  assert.match(await watcher.line(/ QUIT :/), /^:elijah!elijah@user\.swarm QUIT :Quit: gone :NickServ/);
  assert.equal(watcher.lines.some((line) => line.startsWith(':NickServ') || line.includes('from beyond')), false);
});

test('irc: nick collisions, registered nicks and the server password', async () => {
  const fay = await web({ nick: 'fay', password: PASSWORD, register: true });

  const clash = await irc('NICK fay', 'USER fay 0 * :Fay');
  await clash.line(/ NOTICE fay :fay is a registered nick/);
  await clash.line(/ 433 \* fay :/);
  clash.send('NICK fay_');
  await clash.line(/ 001 fay_ /);
  clash.send('PRIVMSG NickServ :REGISTER short', `PRIVMSG NickServ :REGISTER ${PASSWORD}`);
  await clash.line(/^:NickServ!\S+ NOTICE fay_ :A password is 8 to 200 characters\.$/);
  await clash.line(/^:NickServ!\S+ NOTICE fay_ :fay_ is now registered/);

  const wrong = await irc('PASS nope-nope', 'NICK fay', 'USER fay 0 * :Fay');
  await wrong.line(/ 464 fay :Password incorrect$/);
  await wrong.line(/^ERROR :Closing link/);

  // The same account on IRC and on the web at once, like a bouncer.
  const owner = await irc(`PASS :${PASSWORD}`, 'CAP REQ :server-time echo-message', 'CAP END', 'NICK fay', 'USER fay 0 * :Fay');
  await owner.line(/ 001 fay /);
  await owner.line(/ NOTICE fay :You are signed in as fay\.$/);
  await fay.request('send', { target: '#lobby', text: 'from my browser' });
  await owner.line(/:fay!fay@user\.swarm PRIVMSG #lobby :from my browser$/);
  owner.send('PRIVMSG #lobby :from my irc client');
  await owner.line(/:fay!fay@user\.swarm PRIVMSG #lobby :from my irc client$/);
  assert.equal((await fay.event((e) => e.type === 'message' && e.msg.text === 'from my irc client')).msg.registered, true);

  // History is played back with timestamps on the next connect.
  const later = await irc(`PASS :${PASSWORD}`, 'CAP REQ :server-time', 'CAP END', 'NICK fay', 'USER fay 0 * :Fay');
  await later.line(/^@time=\S+ :fay!fay@user\.swarm PRIVMSG #lobby :from my browser$/);

  const unregistered = await irc('JOIN #lobby');
  await unregistered.line(/ 451 \* :You have not registered$/);
});

test('long and multi-line text is wrapped for irc without splitting characters', () => {
  assert.deepEqual(wrapForIrc('one\n\ntwo'), ['one', 'two']);
  const wrapped = wrapForIrc(`${'word '.repeat(30)}${'é'.repeat(300)}`, 100);
  assert.ok(wrapped.every((line) => Buffer.byteLength(line) <= 100));
  assert.equal(wrapped.join(''), `${'word '.repeat(30)}${'é'.repeat(300)}`);
});
