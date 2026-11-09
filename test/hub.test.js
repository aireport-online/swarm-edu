import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Hub } from '../src/core/hub.js';
import { fakeConn, makeHub, rejectsWith } from './helpers.js';

const PASSWORD = 'correct horse';

test('a guest lands in the default channel, which only admins run', async () => {
  const { hub, login } = makeHub({ admins: ['root'] });
  const ada = await login('ada');
  assert.equal(ada.snapshot.self.registered, false);
  assert.deepEqual(ada.snapshot.channels.map((c) => c.name), ['#lobby']);
  assert.equal(ada.snapshot.channels[0].members[0].role, null);

  const bob = await login('bob');
  assert.equal(ada.last('join').member.nick, 'bob');
  const root = await login('root', { password: PASSWORD, register: true });
  assert.equal(root.snapshot.channels[0].members.find((m) => m.nick === 'root').role, 'op');

  // Anywhere else, whoever walks into a channel without operators runs it.
  assert.equal(hub.join(ada.user, '#new').channel.members[0].role, 'op');
  assert.equal(hub.join(bob.user, '#new').channel.members.find((m) => m.nick === 'bob').role, null);
});

test('nicks are unique, case-insensitive and validated', async () => {
  const { hub, login } = makeHub();
  await login('ada');
  await assert.rejects(login('ADA'), rejectsWith('nick_in_use'));
  await assert.rejects(login('1abc'), rejectsWith('invalid_nick'));
  await assert.rejects(login('a'), rejectsWith('invalid_nick'));
  await assert.rejects(login('NickServ'), rejectsWith('invalid_nick'));
  await assert.rejects(hub.login(fakeConn(), {}), rejectsWith('invalid_nick'));
});

test('registered nicks need their password and guests cannot take them', async () => {
  const { hub, login } = makeHub();
  const ada = await login('ada', { password: PASSWORD, register: true });
  assert.equal(ada.snapshot.self.registered, true);
  hub.disconnect(ada);

  await assert.rejects(login('ada'), rejectsWith('nick_registered'));
  await assert.rejects(login('ada', { password: 'wrong password' }), rejectsWith('bad_password'));
  await assert.rejects(login('ada', { password: PASSWORD, register: true }), rejectsWith('nick_registered'));
  await assert.rejects(login('bob', { password: PASSWORD }), rejectsWith('no_such_account'));
  await assert.rejects(login('bob', { password: 'short', register: true }), rejectsWith('bad_password'));

  const again = await login('Ada', { password: PASSWORD });
  assert.equal(again.snapshot.self.nick, 'ada');
});

test('a session token resumes without a password, and logout revokes it', async () => {
  const { hub, login } = makeHub();
  const ada = await login('ada', { password: PASSWORD, register: true });
  const { token } = ada.snapshot;
  hub.disconnect(ada);

  const resumed = fakeConn();
  const snapshot = await hub.login(resumed, { token });
  assert.equal(snapshot.self.nick, 'ada');
  hub.logout(resumed);
  await assert.rejects(hub.login(fakeConn(), { token }), rejectsWith('bad_token'));
});

test('several connections of one user see the same events', async () => {
  const { hub, login } = makeHub();
  const phone = await login('ada', { password: PASSWORD, register: true });
  const laptop = await login('ada', { password: PASSWORD });
  assert.equal(phone.user, laptop.user);

  hub.send(phone.user, '#lobby', 'hello', { origin: phone.id });
  assert.equal(phone.last('message').msg.text, 'hello');
  assert.equal(laptop.last('message').msg.text, 'hello');
  assert.equal(laptop.last('message').meta.origin, phone.id);

  // Dropping one connection does not take the user offline.
  hub.disconnect(phone);
  assert.equal(hub.users.has('ada'), true);
});

test('registered members stay in their channels while offline; guests leave', async () => {
  const { hub, login } = makeHub();
  const ada = await login('ada', { password: PASSWORD, register: true });
  const guest = await login('guest');
  const watcher = await login('watcher');
  hub.join(ada.user, '#dev');

  hub.disconnect(guest);
  assert.equal(watcher.last('quit').nick, 'guest');
  hub.disconnect(ada);
  assert.deepEqual(
    { change: watcher.last('presence').change, nick: watcher.last('presence').nick },
    { change: 'offline', nick: 'ada' },
  );

  const members = hub.channelInfo(watcher.user, '#lobby').members;
  assert.deepEqual(members.map((m) => [m.nick, m.online]), [['ada', false], ['watcher', true]]);

  const back = await login('ada', { password: PASSWORD });
  assert.deepEqual(back.snapshot.channels.map((c) => c.name), ['#lobby', '#dev']);
  assert.equal(watcher.last('presence').change, 'online');
});

test('state survives a restart', async () => {
  const { hub, store, login } = makeHub();
  const ada = await login('ada', { password: PASSWORD, register: true });
  hub.join(ada.user, '#dev');
  hub.setTopic(ada.user, '#dev', 'Ship it');
  hub.send(ada.user, '#dev', 'first');
  hub.setMode(ada.user, '#dev', [{ add: true, mode: 'm' }, { add: true, mode: 'b', arg: 'troll' }]);

  const second = makeHub({}, store);
  const again = await second.login('ada', { password: PASSWORD });
  const dev = again.snapshot.channels.find((c) => c.name === '#dev');
  assert.equal(dev.topic, 'Ship it');
  assert.equal(dev.modes, 'tm');
  assert.equal(dev.members[0].role, 'op');
  assert.equal(second.hub.history(again.user, '#dev').messages[0].text, 'first');
  const troll = await second.login('troll');
  assert.throws(() => second.hub.join(troll.user, '#dev'), rejectsWith('banned'));
});

test('channels are created on join and vanish with their last member', async () => {
  const { hub, login } = makeHub();
  const ada = await login('ada');
  const { channel } = hub.join(ada.user, 'Rust');
  assert.equal(channel.name, '#rust');
  assert.equal(ada.last('channel_joined').channel.name, '#rust');
  hub.send(ada.user, '#rust', 'anyone?');
  assert.throws(() => hub.join(ada.user, '#bad name'), rejectsWith('invalid_channel'));

  hub.part(ada.user, '#rust', 'bye');
  assert.equal(ada.last('part').reason, 'bye');
  assert.equal(hub.channels.has('#rust'), false);
  hub.part(ada.user, '#lobby');
  assert.equal(hub.channels.has('#lobby'), true, 'default channels are permanent');
});

test('messages: history pages, replies, edits, deletes and reactions', async () => {
  const { hub, login, clock } = makeHub({ historyPageSize: 3 });
  const ada = await login('ada');
  const bob = await login('bob');
  const ids = [];
  for (let i = 1; i <= 5; i += 1) {
    clock.t += 1000;
    ids.push(hub.send(ada.user, '#lobby', `line ${i}`).id);
  }

  const latest = hub.history(bob.user, '#lobby');
  assert.deepEqual(latest.messages.map((m) => m.text), ['line 3', 'line 4', 'line 5']);
  assert.equal(latest.hasMore, true);
  const older = hub.history(bob.user, '#lobby', { before: latest.messages[0].id });
  assert.deepEqual(older.messages.map((m) => m.text), ['line 1', 'line 2']);
  assert.equal(older.hasMore, false);

  hub.send(bob.user, '#lobby', 'agreed', { replyTo: ids[4] });
  assert.deepEqual(ada.last('message').msg.replyTo, { id: ids[4], nick: 'ada', text: 'line 5', deleted: false });
  assert.throws(() => hub.send(bob.user, '#lobby', 'x', { replyTo: 9999 }), rejectsWith('not_found'));

  hub.edit(ada.user, ids[0], 'line one');
  assert.equal(bob.last('message_update').msg.text, 'line one');
  assert.ok(bob.last('message_update').msg.editedAt);
  assert.throws(() => hub.edit(bob.user, ids[0], 'hijack'), rejectsWith('forbidden'));

  hub.react(bob.user, ids[0], '👍');
  hub.react(ada.user, ids[0], '👍');
  assert.deepEqual(ada.last('message_update').msg.reactions, [{ emoji: '👍', nicks: ['bob', 'ada'] }]);
  hub.react(bob.user, ids[0], '👍');
  assert.deepEqual(ada.last('message_update').msg.reactions, [{ emoji: '👍', nicks: ['ada'] }]);

  assert.throws(() => hub.remove(bob.user, ids[1]), rejectsWith('forbidden'));
  hub.remove(ada.user, ids[1]);
  assert.deepEqual(
    { text: bob.last('message_update').msg.text, deleted: bob.last('message_update').msg.deleted },
    { text: '', deleted: true },
  );
  assert.throws(() => hub.edit(ada.user, ids[1], 'undelete'), rejectsWith('not_found'));
});

test('message text is validated and cleaned', async () => {
  const { hub, login } = makeHub({ maxMessageLength: 20 });
  const ada = await login('ada');
  assert.throws(() => hub.send(ada.user, '#lobby', '   '), rejectsWith('bad_request'));
  assert.throws(() => hub.send(ada.user, '#lobby', 'x'.repeat(21)), rejectsWith('too_long'));
  assert.throws(() => hub.send(ada.user, '#nowhere', 'hi'), rejectsWith('no_such_channel'));
  hub.send(ada.user, '#lobby', '\x02bold\x034,5 red\x0f\r\n');
  assert.equal(ada.last('message').msg.text, 'bold red');
});

test('flooding is throttled', async () => {
  const { hub, login, clock } = makeHub({ messageBurst: 3, messagesPerSecond: 1 });
  const ada = await login('ada');
  for (let i = 0; i < 3; i += 1) hub.send(ada.user, '#lobby', 'spam');
  assert.throws(() => hub.send(ada.user, '#lobby', 'spam'), rejectsWith('rate_limited'));
  clock.t += 1000;
  hub.send(ada.user, '#lobby', 'ok');
});

test('operators: topic lock, moderation, voice, kick and ban', async () => {
  const { hub, login } = makeHub();
  const op = await login('op');
  const bob = await login('bob');
  hub.join(op.user, '#ops');
  hub.join(bob.user, '#ops');

  assert.throws(() => hub.setTopic(bob.user, '#ops', 'mine'), rejectsWith('not_op'));
  assert.throws(() => hub.kick(bob.user, '#ops', 'op'), rejectsWith('not_op'));
  hub.setTopic(op.user, '#ops', 'Be kind');
  assert.equal(bob.last('topic').topic, 'Be kind');

  hub.setMode(op.user, '#ops', [{ add: true, mode: 'm' }]);
  assert.throws(() => hub.send(bob.user, '#ops', 'hi'), rejectsWith('moderated'));
  hub.setMode(op.user, '#ops', [{ add: true, mode: 'v', arg: 'bob' }]);
  assert.equal(bob.last('mode').changes[0].role, 'voice');
  hub.send(bob.user, '#ops', 'hi');

  hub.setMode(op.user, '#ops', [{ add: false, mode: 't' }, { add: true, mode: 'o', arg: 'bob' }]);
  hub.setTopic(bob.user, '#ops', 'Anyone may');
  assert.equal(hub.channelInfo(op.user, '#ops').modes, 'm');

  // A bad change does not undo the good ones before it.
  assert.throws(
    () => hub.setMode(op.user, '#ops', [{ add: false, mode: 'm' }, { add: true, mode: 'z' }]),
    rejectsWith('bad_request'),
  );
  assert.equal(hub.channelInfo(op.user, '#ops').modes, '');

  // Taking operator status away leaves a voice alone, and the other way round.
  hub.setMode(op.user, '#ops', [{ add: false, mode: 'o', arg: 'bob' }, { add: true, mode: 'v', arg: 'bob' }]);
  assert.deepEqual(hub.setMode(op.user, '#ops', [{ add: false, mode: 'o', arg: 'bob' }]).changes, []);
  assert.equal(hub.channelInfo(op.user, '#ops').members.find((m) => m.nick === 'bob').role, 'voice');

  const { id } = hub.send(bob.user, '#ops', 'before the ban');
  hub.setMode(op.user, '#ops', [{ add: true, mode: 'b', arg: 'bob' }]);
  assert.throws(() => hub.send(bob.user, '#ops', 'still here'), rejectsWith('banned'));
  assert.throws(() => hub.edit(bob.user, id, 'rewritten after the ban'), rejectsWith('banned'));
  assert.throws(() => hub.changeNick(bob.user, 'robert'), rejectsWith('banned'));
  hub.kick(op.user, '#ops', 'bob', 'enough');
  assert.deepEqual(
    { nick: bob.last('kick').nick, by: bob.last('kick').by, reason: bob.last('kick').reason },
    { nick: 'bob', by: 'op', reason: 'enough' },
  );
  assert.throws(() => hub.join(bob.user, '#ops'), rejectsWith('banned'));
  assert.deepEqual(hub.bans(op.user, '#ops').bans.map((b) => b.nick), ['bob']);
  hub.setMode(op.user, '#ops', [{ add: false, mode: 'b', arg: 'bob' }]);
  hub.join(bob.user, '#ops');
});

test('a founder keeps the channel: no deop, kick or ban by others', async () => {
  const { hub, login } = makeHub();
  const ada = await login('ada', { password: PASSWORD, register: true });
  const bob = await login('bob');
  hub.join(ada.user, '#mine');
  hub.join(bob.user, '#mine');
  hub.setMode(ada.user, '#mine', [{ add: true, mode: 'o', arg: 'bob' }]);
  assert.throws(() => hub.kick(bob.user, '#mine', 'ada'), rejectsWith('forbidden'));
  assert.throws(() => hub.setMode(bob.user, '#mine', [{ add: false, mode: 'o', arg: 'ada' }]), rejectsWith('forbidden'));
  assert.throws(() => hub.setMode(bob.user, '#mine', [{ add: true, mode: 'b', arg: 'ada' }]), rejectsWith('forbidden'));
});

test('a ban on a registered nick follows the account through a rename', async () => {
  const { hub, login } = makeHub();
  const op = await login('op');
  const eve = await login('eve', { password: PASSWORD, register: true });
  hub.join(op.user, '#ops');
  hub.join(eve.user, '#ops');
  hub.setMode(op.user, '#ops', [{ add: true, mode: 'b', arg: 'eve' }]);
  hub.kick(op.user, '#ops', 'eve');
  hub.changeNick(eve.user, 'eva');
  assert.throws(() => hub.join(eve.user, '#ops'), rejectsWith('banned'));
  hub.setMode(op.user, '#ops', [{ add: false, mode: 'b', arg: 'eve' }]);
  hub.join(eve.user, '#ops');
});

test('sessions that go unused expire', async () => {
  const { hub, login, clock } = makeHub({ sessionTtlMs: 1000 });
  const ada = await login('ada', { password: PASSWORD, register: true });
  hub.disconnect(ada);
  clock.t += 500;
  const again = fakeConn();
  await hub.login(again, { token: ada.snapshot.token });
  hub.disconnect(again);
  clock.t += 1500;
  await assert.rejects(hub.login(fakeConn(), { token: ada.snapshot.token }), rejectsWith('bad_token'));
});

test('invite-only channels need an invitation', async () => {
  const { hub, login } = makeHub();
  const op = await login('op');
  const bob = await login('bob');
  hub.join(op.user, '#club');
  hub.setMode(op.user, '#club', [{ add: true, mode: 'i' }]);
  assert.throws(() => hub.join(bob.user, '#club'), rejectsWith('invite_only'));
  hub.invite(op.user, '#club', 'bob');
  assert.deepEqual({ channel: bob.last('invite').channel, by: bob.last('invite').by }, { channel: '#club', by: 'op' });
  hub.join(bob.user, '#club');
  assert.deepEqual(hub.whois(bob.user, 'op').channels.map((c) => c.name), ['#lobby', '#club']);

  // An invitation is for a person: the next holder of the nick cannot use it.
  const guest = await login('guest');
  hub.invite(op.user, '#club', 'guest');
  hub.disconnect(guest);
  const impostor = await login('guest');
  assert.throws(() => hub.join(impostor.user, '#club'), rejectsWith('invite_only'));
  const eve = await login('eve');
  assert.deepEqual(hub.whois(eve.user, 'op').channels.map((c) => c.name), ['#lobby'], 'private channels stay private');
});

test('nick changes follow the user everywhere', async () => {
  const { hub, login } = makeHub();
  const ada = await login('ada', { password: PASSWORD, register: true });
  const bob = await login('bob');
  assert.throws(() => hub.changeNick(bob.user, 'ada'), rejectsWith('nick_in_use'));
  hub.changeNick(ada.user, 'lovelace');
  assert.deepEqual({ old: bob.last('nick').old, nick: bob.last('nick').nick }, { old: 'ada', nick: 'lovelace' });
  assert.deepEqual(hub.channelInfo(bob.user, '#lobby').members.map((m) => m.nick).sort(), ['bob', 'lovelace']);
  hub.disconnect(ada);
  await assert.rejects(login('lovelace'), rejectsWith('nick_registered'));
  await login('ada');
  assert.equal((await login('Lovelace', { password: PASSWORD })).snapshot.self.nick, 'lovelace');
});

test('direct messages are kept between accounts and fleeting with guests', async () => {
  const { hub, login } = makeHub();
  const ada = await login('ada', { password: PASSWORD, register: true });
  const bob = await login('bob', { password: PASSWORD, register: true });
  const guest = await login('guest');

  const sent = hub.send(ada.user, 'bob', 'psst');
  assert.equal(bob.last('message').target, 'ada');
  assert.equal(ada.last('message').target, 'bob');
  assert.equal(Number.isInteger(sent.id), true);

  // Offline delivery: bob finds the message and an unread count on return.
  hub.disconnect(bob);
  hub.send(ada.user, 'bob', 'are you there?');
  const back = await login('bob', { password: PASSWORD });
  assert.deepEqual(back.snapshot.dms.map((dm) => [dm.nick, dm.unread]), [['ada', 2]]);
  const { messages } = hub.history(back.user, 'ada');
  assert.deepEqual(messages.map((m) => m.text), ['psst', 'are you there?']);
  hub.markRead(back.user, 'ada', messages[1].id);
  hub.disconnect(back);
  const third = await login('bob', { password: PASSWORD });
  assert.equal(third.snapshot.dms[0].unread, 0);
  hub.disconnect(third);

  const fleeting = hub.send(guest.user, 'ada', 'hi from a guest');
  assert.match(String(fleeting.id), /^e\d+$/);
  assert.equal(ada.last('message').msg.ephemeral, true);
  assert.deepEqual(hub.history(guest.user, 'ada').messages, []);
  assert.throws(() => hub.send(guest.user, 'bob', 'hello?'), rejectsWith('no_such_nick'));
  assert.throws(() => hub.send(guest.user, 'nobody', 'hello?'), rejectsWith('no_such_nick'));
  assert.throws(() => hub.send(ada.user, 'ada', 'me'), rejectsWith('bad_request'));

  // Only the two people in a conversation can touch its messages.
  assert.throws(() => hub.react(guest.user, sent.id, '👀'), rejectsWith('not_found'));
});

test('unread counts and mentions for registered members', async () => {
  const { hub, login } = makeHub();
  const ada = await login('ada', { password: PASSWORD, register: true });
  const bob = await login('bob');
  hub.disconnect(ada);
  hub.send(bob.user, '#lobby', 'one');
  hub.send(bob.user, '#lobby', 'ada: two');
  const back = await login('ada', { password: PASSWORD });
  const lobby = back.snapshot.channels[0];
  assert.deepEqual({ unread: lobby.unread, mentions: lobby.mentions }, { unread: 2, mentions: 1 });

  const other = await login('ada', { password: PASSWORD });
  const latest = hub.history(back.user, '#lobby').messages.at(-1).id;
  hub.markRead(back.user, '#lobby', latest, { origin: back.id });
  assert.equal(other.last('read').lastRead, latest);
  assert.equal(hub.channelInfo(back.user, '#lobby').unread, 0);
});

test('a guest can register their nick mid-session and keep their place', async () => {
  const { hub, login } = makeHub();
  const ada = await login('ada');
  const bob = await login('bob');
  hub.join(ada.user, '#dev');
  const result = await hub.register(ada.user, PASSWORD, ada);
  assert.equal(result.self.registered, true);
  assert.equal(bob.last('presence').change, 'registered');
  hub.disconnect(ada);
  assert.equal(hub.channels.has('#dev'), true, 'the channel outlives its registered member going offline');
  const again = await login('ada', { password: PASSWORD });
  assert.equal(again.snapshot.channels.find((c) => c.name === '#dev').members[0].role, 'op');
  assert.equal((await hub.login(fakeConn(), { token: result.token })).self.nick, 'ada');
});

test('away, whois, list and search', async () => {
  const { hub, login } = makeHub();
  const ada = await login('ada');
  const bob = await login('bob');
  hub.setAway(ada.user, 'lunch');
  assert.equal(bob.last('presence').away, 'lunch');
  assert.equal(hub.send(bob.user, 'ada', 'ping').away, 'lunch');
  const who = hub.whois(bob.user, 'ADA');
  assert.deepEqual(
    { nick: who.nick, online: who.online, away: who.away, registered: who.registered },
    { nick: 'ada', online: true, away: 'lunch', registered: false },
  );
  assert.throws(() => hub.whois(bob.user, 'ghost'), rejectsWith('no_such_nick'));

  hub.join(ada.user, '#quiet');
  assert.deepEqual(hub.list().channels.map((c) => [c.name, c.online]), [['#lobby', 2], ['#quiet', 1]]);

  hub.send(ada.user, '#lobby', 'the 100% solution');
  hub.send(ada.user, '#quiet', 'a 100% secret');
  assert.deepEqual(hub.search(bob.user, '100%').results.map((r) => [r.target, r.msg.text]), [
    ['#lobby', 'the 100% solution'],
  ]);
  assert.deepEqual(hub.search(bob.user, '1000').results, []);
});

test('a guest stays online through a short disconnect', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { hub, login } = makeHub({ graceMs: 5000 });
  const ada = await login('ada');
  const bob = await login('bob');
  const { token } = ada.snapshot;
  hub.disconnect(ada);
  t.mock.timers.tick(4000);
  assert.equal(bob.of('quit').length, 0);
  const resumed = fakeConn();
  await hub.login(resumed, { token });
  t.mock.timers.tick(10_000);
  assert.equal(bob.of('quit').length, 0, 'reconnecting cancels the departure');
  hub.disconnect(resumed);
  t.mock.timers.tick(5000);
  assert.equal(bob.last('quit').nick, 'ada');
  assert.equal(hub instanceof Hub, true);
});
