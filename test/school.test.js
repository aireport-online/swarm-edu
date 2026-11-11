import assert from 'node:assert/strict';
import { connect } from 'node:net';
import { after, before, test } from 'node:test';
import { WebSocket } from 'ws';
import { createApp } from '../src/server.js';
import { fakeConn, makeHub, rejectsWith } from './helpers.js';

const PASSWORD = 'correct horse';
const STAFF_CODE = 'staffroom-kettle';

/** A hub under the school rules, with one teacher who has opened a class. */
async function school(config = {}) {
  const made = makeHub({ school: {}, defaultChannels: [], teacherCode: STAFF_CODE, ...config });
  const teacher = await made.login('ms-rivera', { password: PASSWORD, register: true, teacherCode: STAFF_CODE });
  const { channel } = made.hub.join(teacher.user, '#history-3b');
  return { ...made, teacher, code: channel.code, klas: '#history-3b' };
}

test('a teacher opens a class and gets its code; students cannot open one', async () => {
  const { hub, login, teacher, code } = await school();
  assert.equal(teacher.snapshot.self.teacher, true);
  assert.match(code, /^[A-HJ-NP-Z2-9]{6}$/);
  assert.equal(hub.channelInfo(teacher.user, '#history-3b').modes, 'tk');

  const sam = await login('sam', { code });
  assert.equal(sam.snapshot.self.teacher, false);
  assert.throws(() => hub.join(sam.user, '#secret-club'), rejectsWith('forbidden'));
  assert.equal(hub.channels.has('#secret-club'), false);
});

test('guests come in through a class code, typed however they like', async () => {
  const { hub, login, teacher, code, klas } = await school();
  await assert.rejects(login('sam'), rejectsWith('code_required'));
  await assert.rejects(login('sam', { code: 'NOPE22' }), rejectsWith('bad_code'));
  assert.equal(hub.users.has('sam'), false, 'a failed attempt leaves nobody behind');

  const sam = await login('sam', { code: ` ${code.slice(0, 3).toLowerCase()}-${code.slice(3).toLowerCase()} ` });
  assert.deepEqual(sam.snapshot.channels.map((c) => c.name), [klas]);
  assert.equal(teacher.last('join').member.nick, 'sam');
  // The code is for the people who run the class, not for passing around.
  assert.equal('code' in sam.snapshot.channels[0], false);
  assert.equal(hub.channelInfo(teacher.user, klas).code, code);
});

test('a class is joined by name and code, by code alone, or freely by a teacher', async () => {
  const { hub, login, teacher, code, klas } = await school();
  const physics = hub.join(teacher.user, '#physics-4a').channel;
  const kai = await login('kai', { code });

  assert.throws(() => hub.join(kai.user, '#physics-4a'), rejectsWith('bad_code'));
  assert.throws(() => hub.join(kai.user, '#physics-4a', { code }), rejectsWith('bad_code'), 'another class\'s code');
  assert.throws(() => hub.joinByCode(kai.user, 'ZZZZZZ'), rejectsWith('bad_code'));
  assert.equal(hub.joinByCode(kai.user, physics.code).channel.name, '#physics-4a');

  const colleague = await login('mr-okafor', { password: PASSWORD, register: true, teacherCode: STAFF_CODE });
  assert.equal(hub.join(colleague.user, klas).channel.members.find((m) => m.nick === 'mr-okafor').role, null);
  assert.equal(hub.channelInfo(kai.user, klas).members.find((m) => m.nick === 'mr-okafor').teacher, true);
});

test('a new code shuts the old one; a locked class lets nobody new in', async () => {
  const { hub, login, teacher, code, klas } = await school();
  const sam = await login('sam', { code });
  const fresh = hub.setCode(teacher.user, klas, 'new').code;
  assert.notEqual(fresh, code);
  assert.equal(teacher.last('code').code, fresh);
  assert.equal(sam.of('code').length, 0);
  await assert.rejects(login('kai', { code }), rejectsWith('bad_code'));
  assert.throws(() => hub.setCode(sam.user, klas, 'new'), rejectsWith('not_op'));

  hub.setMode(teacher.user, klas, [{ add: true, mode: 'i' }]);
  await assert.rejects(login('kai', { code: fresh }), rejectsWith('invite_only'));
  hub.setMode(teacher.user, klas, [{ add: false, mode: 'i' }]);
  await login('kai', { code: fresh });

  hub.setCode(teacher.user, klas, 'off');
  assert.equal(sam.last('mode').changes[0].add, false);
  assert.equal(hub.channelInfo(sam.user, klas).modes, 't');
});

test('the staff code makes teachers, at registration or later; nothing else does', async () => {
  const { hub, login } = await school();
  await assert.rejects(login('eve', { password: PASSWORD, register: true, teacherCode: 'guess' }), rejectsWith('bad_teacher_code'));
  assert.equal(hub.store.accountByKey('eve'), null, 'no account is made on a wrong staff code');

  const later = await login('mr-okafor', { password: PASSWORD, register: true });
  assert.equal(later.snapshot.self.teacher, false);
  assert.throws(() => hub.becomeTeacher(later.user, 'guess'), rejectsWith('bad_teacher_code'));
  assert.equal(hub.becomeTeacher(later.user, STAFF_CODE).teacher, true);
  const guesser = await login('guesser', { password: PASSWORD, register: true });
  for (let i = 0; i < 5; i += 1) assert.throws(() => hub.becomeTeacher(guesser.user, `guess ${i}`), rejectsWith('bad_teacher_code'));
  assert.throws(() => hub.becomeTeacher(guesser.user, STAFF_CODE), rejectsWith('rate_limited'), 'five misses and the door stays shut');
  hub.disconnect(later);
  assert.equal((await login('mr-okafor', { password: PASSWORD })).snapshot.self.teacher, true);

  // The school can also simply name its teachers.
  const named = makeHub({ school: {}, defaultChannels: [], teachers: ['head'] });
  assert.equal((await named.login('head', { password: PASSWORD, register: true })).snapshot.self.teacher, true);
  const student = await named.login('pupil', { password: PASSWORD, register: true });
  assert.throws(() => named.hub.becomeTeacher(student.user, 'anything'), rejectsWith('forbidden'));
});

test('private messages need a teacher at one end', async () => {
  const { hub, login, teacher, code } = await school();
  const sam = await login('sam', { code });
  const kai = await login('kai', { code });
  assert.throws(() => hub.send(sam.user, 'kai', 'psst'), rejectsWith('forbidden'));
  hub.send(sam.user, 'ms-rivera', 'can I hand it in tomorrow?');
  assert.equal(teacher.last('message').target, 'sam');
  hub.send(teacher.user, 'sam', 'yes, before nine');
  assert.equal(sam.last('message').msg.text, 'yes, before nine');
  assert.equal(kai.of('message').length, 0);
});

test('students only see their own classes in the list; teachers see them all', async () => {
  const { hub, login, teacher, code } = await school();
  hub.join(teacher.user, '#physics-4a');
  const sam = await login('sam', { code });
  assert.deepEqual(hub.list(sam.user).channels.map((c) => c.name), ['#history-3b']);
  assert.deepEqual(hub.list(teacher.user).channels.map((c) => c.name).sort(), ['#history-3b', '#physics-4a']);
});

test('quiet mode: hands go up in order, and getting the floor lowers the hand', async () => {
  const { hub, login, teacher, code, klas } = await school();
  const sam = await login('sam', { code });
  const kai = await login('kai', { code });
  hub.setMode(teacher.user, klas, [{ add: true, mode: 'm' }]);
  assert.throws(() => hub.send(sam.user, klas, 'me!'), rejectsWith('moderated'));

  hub.hand(kai.user, klas);
  hub.hand(sam.user, klas);
  hub.hand(sam.user, klas); // twice is once
  assert.deepEqual(hub.channelInfo(teacher.user, klas).hands, ['kai', 'sam']);
  assert.deepEqual({ nick: teacher.last('hand').nick, up: teacher.last('hand').up }, { nick: 'sam', up: true });
  assert.equal(teacher.of('hand').length, 2);

  hub.setMode(teacher.user, klas, [{ add: true, mode: 'v', arg: 'kai' }]);
  assert.deepEqual(hub.channelInfo(teacher.user, klas).hands, ['sam']);
  hub.send(kai.user, klas, 'the treaty came first');

  assert.throws(() => hub.hand(kai.user, klas, { up: false, nick: 'sam' }), rejectsWith('not_op'));
  hub.hand(teacher.user, klas, { up: false, nick: 'sam' });
  assert.deepEqual(hub.channelInfo(teacher.user, klas).hands, []);

  // A hand keeps its place through a rename and comes down when its owner leaves.
  hub.hand(sam.user, klas);
  hub.changeNick(sam.user, 'samuel');
  assert.deepEqual(hub.channelInfo(teacher.user, klas).hands, ['samuel']);
  hub.disconnect(sam);
  assert.deepEqual(hub.channelInfo(teacher.user, klas).hands, []);
});

test('a poll shows its tally to those who voted; a quiz keeps tally and answer until it closes', async () => {
  const { hub, login, teacher, code, klas } = await school();
  const sam = await login('sam', { code });
  const kai = await login('kai', { code });
  assert.throws(() => hub.createPoll(sam.user, klas, { question: 'Homework?', options: ['no', 'never'] }), rejectsWith('not_op'));
  assert.throws(() => hub.createPoll(teacher.user, klas, { question: 'One?', options: ['only'] }), rejectsWith('bad_request'));
  assert.throws(() => hub.createPoll(teacher.user, klas, { question: 'Q', options: ['a', 'b'], correct: 2 }), rejectsWith('bad_request'));

  const poll = hub.createPoll(teacher.user, klas, { question: 'Field trip on Friday?', options: ['Museum', 'Archive', 'Stay in'] });
  assert.deepEqual(sam.last('message').msg.poll, {
    kind: 'poll', options: ['Museum', 'Archive', 'Stay in'], total: 0, closed: false, mine: null, counts: null, correct: null,
  });
  assert.deepEqual(teacher.last('message').msg.poll.counts, [0, 0, 0]);

  hub.vote(sam.user, poll.id, 0);
  assert.deepEqual(sam.last('message_update').msg.poll.counts, [1, 0, 0]);
  assert.equal(sam.last('message_update').msg.poll.mine, 0);
  assert.deepEqual({ counts: kai.last('message_update').msg.poll.counts, total: kai.last('message_update').msg.poll.total }, { counts: null, total: 1 });
  hub.vote(sam.user, poll.id, 1); // changing your mind is allowed
  hub.vote(kai.user, poll.id, 1);
  assert.deepEqual(teacher.last('message_update').msg.poll.counts, [0, 2, 0]);
  assert.throws(() => hub.vote(kai.user, poll.id, 7), rejectsWith('bad_request'));
  assert.throws(() => hub.edit(teacher.user, poll.id, 'Field trip on Monday?'), rejectsWith('forbidden'));

  const quiz = hub.createPoll(teacher.user, klas, { question: 'Treaty of Utrecht?', options: ['1648', '1713', '1815'], correct: 1 });
  assert.equal(sam.last('message').msg.poll.kind, 'quiz');
  hub.vote(sam.user, quiz.id, 0);
  const before = sam.last('message_update').msg.poll;
  assert.deepEqual({ counts: before.counts, correct: before.correct, mine: before.mine }, { counts: null, correct: null, mine: 0 });
  assert.equal(teacher.last('message_update').msg.poll.correct, 1);
  assert.throws(() => hub.closePoll(sam.user, quiz.id), rejectsWith('not_op'));
  hub.closePoll(teacher.user, quiz.id);
  const closed = sam.last('message_update').msg.poll;
  assert.deepEqual({ counts: closed.counts, correct: closed.correct, closed: closed.closed }, { counts: [1, 0, 0], correct: 1, closed: true });
  assert.throws(() => hub.vote(kai.user, quiz.id, 1), rejectsWith('forbidden'));

  // History gives each reader their own view too.
  const fromHistory = hub.history(kai.user, klas).messages.find((m) => m.id === poll.id).poll;
  assert.deepEqual({ mine: fromHistory.mine, counts: fromHistory.counts }, { mine: 1, counts: [0, 2, 0] });
  const late = await login('ivy', { code });
  assert.equal(hub.history(late.user, klas).messages.find((m) => m.id === poll.id).poll.counts, null);
});

test('the teacher pins one message; deleting it unpins', async () => {
  const { hub, login, teacher, code, klas } = await school();
  const sam = await login('sam', { code });
  const { id } = hub.send(teacher.user, klas, 'Read chapter 4 for Thursday.');
  assert.throws(() => hub.pin(sam.user, klas, id), rejectsWith('not_op'));
  hub.pin(teacher.user, klas, id);
  assert.equal(sam.last('pin').pinned.text, 'Read chapter 4 for Thursday.');
  assert.equal((await login('kai', { code })).snapshot.channels[0].pinned.id, id);
  hub.remove(teacher.user, id);
  assert.equal(sam.last('pin').pinned, null);
  assert.equal(hub.channelInfo(sam.user, klas).pinned, null);
});

test('a report reaches the teacher, not the class, and clears when handled', async () => {
  const { hub, login, teacher, code, klas } = await school();
  const sam = await login('sam', { code });
  const kai = await login('kai', { code });
  const { id } = hub.send(kai.user, klas, 'something unkind');
  assert.throws(() => hub.report(kai.user, id), rejectsWith('bad_request'));
  hub.report(sam.user, id);
  hub.report(sam.user, id); // once is enough
  assert.deepEqual(teacher.last('reports').reports.map((r) => [r.by, r.msg.text]), [['sam', 'something unkind']]);
  assert.equal(teacher.of('reports').length, 1);
  assert.equal(kai.of('reports').length + sam.of('reports').length, 0);
  assert.equal('reports' in hub.channelInfo(kai.user, klas), false);
  assert.equal(hub.channelInfo(teacher.user, klas).reports.length, 1);

  assert.throws(() => hub.resolveReport(kai.user, teacher.last('reports').reports[0].id), rejectsWith('not_found'));
  hub.remove(teacher.user, id); // deleting the message settles it
  assert.deepEqual(teacher.last('reports').reports, []);

  const second = hub.send(kai.user, klas, 'a misunderstanding');
  hub.report(sam.user, second.id);
  hub.resolveReport(teacher.user, teacher.last('reports').reports[0].id);
  assert.deepEqual(hub.channelInfo(teacher.user, klas).reports, []);
});

test('participation and transcript are the teacher\'s', async () => {
  const { hub, login, teacher, code, klas, clock } = await school();
  const sam = await login('sam', { code });
  await login('kai', { code });
  hub.send(sam.user, klas, 'first');
  clock.t += 60_000;
  hub.send(sam.user, klas, 'second');
  hub.send(teacher.user, klas, 'good');
  assert.deepEqual(hub.participation(teacher.user, klas).people.map((p) => [p.nick, p.messages]), [
    ['sam', 2], ['ms-rivera', 1], ['kai', 0],
  ]);
  assert.throws(() => hub.participation(sam.user, klas), rejectsWith('not_op'));
  assert.deepEqual(hub.transcript(teacher.user, klas).lines.map((l) => `${l.nick}: ${l.text}`), ['sam: first', 'sam: second', 'ms-rivera: good']);
  assert.throws(() => hub.transcript(sam.user, klas), rejectsWith('not_op'));
});

test('codes, roles, pins and polls survive a restart', async () => {
  const first = await school();
  const sam = await first.login('sam', { code: first.code });
  const pinned = first.hub.send(first.teacher.user, first.klas, 'Bring your atlas.');
  first.hub.pin(first.teacher.user, first.klas, pinned.id);
  const quiz = first.hub.createPoll(first.teacher.user, first.klas, { question: 'Capital of Friesland?', options: ['Leeuwarden', 'Groningen'], correct: 0 });
  first.hub.vote(sam.user, quiz.id, 0);

  const second = makeHub({ school: {}, defaultChannels: [], teacherCode: STAFF_CODE }, first.store);
  const teacher = await second.login('ms-rivera', { password: PASSWORD });
  const state = teacher.snapshot.channels[0];
  assert.deepEqual(
    { teacher: teacher.snapshot.self.teacher, code: state.code, pinned: state.pinned.text, modes: state.modes },
    { teacher: true, code: first.code, pinned: 'Bring your atlas.', modes: 'tk' },
  );
  assert.deepEqual(second.hub.history(teacher.user, first.klas).messages.at(-1).poll.counts, [1, 0]);
  await second.login('kai', { code: first.code });
});

// ----------------------------------------------------------- over the wire

let app;
let ports;
const open = [];

before(async () => {
  app = createApp(
    {
      host: '127.0.0.1', port: 0, ircPort: -1, dbPath: ':memory:', trustProxy: false,
      hub: { serverName: 'Test School', motd: '', defaultChannels: [], graceMs: 0, messageBurst: 1000, teacherCode: STAFF_CODE },
    },
    { log: () => {} },
  );
  ports = await app.start();
});

after(async () => {
  for (const close of open) close();
  await app.stop();
});

async function web(hello) {
  const ws = new WebSocket(`ws://127.0.0.1:${ports.http}/ws`);
  const pending = new Map();
  const waiters = [];
  let seq = 0;
  const client = {
    events: [],
    request(op, params = {}) {
      const id = ++seq;
      ws.send(JSON.stringify({ ...params, id, op }));
      return new Promise((resolve, reject) => {
        pending.set(id, (reply) => (reply.ok ? resolve(reply.data) : reject(Object.assign(new Error(reply.error.message), reply.error))));
      });
    },
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

test('websocket: a lesson from sign-in to poll', async () => {
  const teacher = await web({ nick: 'ms-rivera', password: PASSWORD, register: true, teacherCode: STAFF_CODE });
  assert.equal(teacher.snapshot.server.rules.onlyTeachersCreate, true);
  const { channel } = await teacher.request('join', { channel: '#history-3b' });

  await assert.rejects((await web()).request('hello', { nick: 'sam' }), { code: 'code_required' });
  const sam = await web({ nick: 'sam', code: channel.code });
  assert.equal(sam.snapshot.channels[0].name, '#history-3b');
  await assert.rejects(sam.request('join', { channel: '#elsewhere' }), { code: 'forbidden' });

  await sam.request('hand', { channel: '#history-3b', up: true });
  assert.equal((await teacher.event((e) => e.type === 'hand')).nick, 'sam');

  const { id } = await teacher.request('poll', { channel: '#history-3b', question: 'Ready for the test?', options: ['Yes', 'Not yet'] });
  const asked = await sam.event((e) => e.type === 'message' && e.msg.id === id);
  assert.equal(asked.msg.poll.counts, null);
  await sam.request('vote', { msgId: id, choice: 1 });
  assert.deepEqual((await sam.event((e) => e.type === 'message_update' && e.msg.poll.mine === 1)).msg.poll.counts, [0, 1]);
  await teacher.request('closePoll', { msgId: id });
  assert.equal((await sam.event((e) => e.type === 'message_update' && e.msg.poll.closed)).msg.poll.closed, true);
  assert.equal((await teacher.request('participation', { channel: '#history-3b' })).people.length, 2);
});

test('irc: the server password is the class code for a student', async () => {
  const teacher = await web({ nick: 'mr-okafor', password: PASSWORD, register: true, teacherCode: STAFF_CODE });
  const { channel } = await teacher.request('join', { channel: '#physics-4a' });

  const lines = [];
  const socket = connect(ports.irc, '127.0.0.1');
  socket.setEncoding('utf8');
  open.push(() => socket.destroy());
  const until = (pattern) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no ${pattern} in\n${lines.join('\n')}`)), 2000);
    const check = () => {
      const hit = lines.find((line) => pattern.test(line));
      if (hit) { clearTimeout(timer); resolve(hit); } else setTimeout(check, 10);
    };
    check();
  });
  socket.on('data', (chunk) => lines.push(...chunk.split('\r\n').filter(Boolean)));
  await new Promise((resolve) => socket.once('connect', resolve));
  socket.write(`PASS ${channel.code}\r\nNICK ivy\r\nUSER ivy 0 * :Ivy\r\n`);
  await until(/ 001 ivy /);
  await until(/^:ivy!ivy@user\.swarm JOIN #physics-4a$/);
  socket.write('JOIN #lunch\r\nMODE #physics-4a\r\n');
  await until(/ NOTICE ivy :Only teachers can open a class/);
  await until(/ 324 ivy #physics-4a \+tk$/);

  const stranger = connect(ports.irc, '127.0.0.1');
  stranger.setEncoding('utf8');
  open.push(() => stranger.destroy());
  const got = [];
  stranger.on('data', (chunk) => got.push(chunk));
  stranger.write('NICK zed\r\nUSER zed 0 * :Zed\r\n');
  await new Promise((resolve) => stranger.once('close', resolve));
  assert.match(got.join(''), / 464 zed :Enter the class code your teacher gave you\./);
  assert.equal(fakeConn().user, null);
});
