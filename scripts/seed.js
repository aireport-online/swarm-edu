// Fills a database with a small school, for demos and screenshots:
//   DB_PATH=data/demo.db npm run seed
// Every account gets the password "swarm-demo". The class codes are printed
// at the end; they are different on every run.
import { loadConfig } from '../src/config.js';
import { Hub } from '../src/core/hub.js';
import { Store } from '../src/db.js';

const PASSWORD = 'swarm-demo';
const STAFF_CODE = 'seed-only-staff-code';
const MINUTE = 60_000;
const config = loadConfig();
const store = new Store(config.dbPath);
const clock = { t: Date.now() - 3 * 24 * 60 * MINUTE };
const hub = new Hub({
  store,
  now: () => clock.t,
  config: { ...config.hub, graceMs: 0, messageBurst: 1e9, teacherCode: STAFF_CODE },
});

if (store.accountByKey('ms-rivera')) {
  console.error(`${config.dbPath} already holds the demo school.`);
  process.exit(1);
}

const people = {};
async function account(nick, teacher = false) {
  const conn = { id: nick, user: null, deliver() {} };
  await hub.login(conn, { nick, password: PASSWORD, register: true, session: false, teacherCode: teacher ? STAFF_CODE : undefined });
  people[nick] = conn.user;
}
for (const nick of ['ms-rivera', 'mr-okafor']) await account(nick, true);
for (const nick of ['noor', 'daan', 'sam', 'kai', 'ivy', 'lena', 'milan', 'zoe', 'omar', 'tess']) await account(nick);

const classes = {
  '#history-3b': { teacher: 'ms-rivera', topic: 'The Dutch Republic, 1588 to 1795', students: ['noor', 'daan', 'sam', 'kai', 'ivy', 'lena', 'milan', 'zoe'] },
  '#physics-4a': { teacher: 'mr-okafor', topic: 'Forces and motion. Lab on Thursday', students: ['omar', 'tess', 'kai', 'zoe', 'milan'] },
  '#staffroom': { teacher: 'ms-rivera', topic: 'Staff only', students: [] },
};
const codes = {};
for (const [name, { teacher, topic, students }] of Object.entries(classes)) {
  const { channel } = hub.join(people[teacher], name);
  codes[name] = channel.code;
  hub.setTopic(people[teacher], name, topic);
  for (const nick of students) hub.joinByCode(people[nick], channel.code);
}
hub.join(people['mr-okafor'], '#staffroom');
hub.join(people['mr-okafor'], '#history-3b');
hub.setMode(people['ms-rivera'], '#staffroom', [{ add: true, mode: 'i' }]);

/** `[minutes since the previous line, nick, text, options]` */
function talk(channel, startMinutesAgo, lines) {
  clock.t = Date.now() - startMinutesAgo * MINUTE;
  const ids = [];
  for (const [gap, nick, text, options = {}] of lines) {
    clock.t += gap * MINUTE;
    const replyTo = options.reply != null ? ids[options.reply] : null;
    const { id } = hub.send(people[nick], channel, text, { kind: options.kind, replyTo });
    ids.push(id);
    for (const [emoji, nicks] of Object.entries(options.react ?? {})) {
      for (const reactor of nicks) hub.react(people[reactor], id, emoji);
    }
  }
  return ids;
}

function ask(channel, teacher, minutesAgo, question, options, correct, votes, close) {
  clock.t = Date.now() - minutesAgo * MINUTE;
  const { id } = hub.createPoll(people[teacher], channel, { question, options, correct });
  for (const [nick, choice] of Object.entries(votes)) {
    clock.t += 20_000;
    hub.vote(people[nick], id, choice);
  }
  if (close) hub.closePoll(people[teacher], id);
  return id;
}

// ---- history, yesterday: a quiz, then the lesson
ask('#history-3b', 'ms-rivera', 26 * 60 + 12, 'To warm up: in which year was the Union of Utrecht signed?', ['1568', '1579', '1588', '1648'], 1,
  { noor: 1, daan: 1, sam: 0, kai: 1, ivy: 2, lena: 1, milan: 3, zoe: 1 }, true);
talk('#history-3b', 26 * 60, [
  [0, 'ms-rivera', 'Five of eight had it. 1579: the northern provinces promise to stand together against Spain.'],
  [2, 'sam', 'I mixed it up with the start of the revolt'],
  [1, 'ms-rivera', 'sam: easy to do. 1568 is the first battle, 1579 the union, 1588 the Republic. Three steps.', { react: { '👍': ['sam', 'ivy'] } }],
  [3, 'noor', 'why did the south not join?'],
  [2, 'ms-rivera', 'Good question. Mostly religion and who held the cities: the Union of Arras, also 1579, kept the south with Spain.', { reply: 3 }],
  [1, 'daan', 'so two unions in one year'],
  [1, 'ms-rivera', 'Exactly. Write that down, it comes back on the test.'],
]);

// ---- history, today
const today = talk('#history-3b', 95, [
  [0, 'ms-rivera', 'For Thursday: read chapter 4 (pages 82 to 97) and answer questions 1 to 6. Hand in here or on paper.'],
  [3, 'lena', 'can question 6 be a drawing? it asks for a map'],
  [1, 'ms-rivera', 'lena: yes, a sketch of the trade routes is fine. Take a photo if you draw it.'],
  [6, 'milan', 'is the test on the whole chapter?'],
  [1, 'ms-rivera', 'Chapters 3 and 4. I will post a list of what to know tomorrow.', { react: { '🙏': ['milan', 'zoe', 'kai'] } }],
  [22, 'kai', 'found a good video about the VOC, can I share it?'],
  [1, 'ms-rivera', 'Please do, after class.'],
]);
hub.pin(people['ms-rivera'], '#history-3b', today[0]);
ask('#history-3b', 'ms-rivera', 30, 'Friday we visit one place. Which one?', ['Maritime museum', 'City archive', 'Walk along the old harbour'], null,
  { noor: 0, daan: 2, sam: 0, kai: 0, lena: 1 }, false);

// ---- physics
talk('#physics-4a', 5 * 60, [
  [0, 'mr-okafor', 'Lab on Thursday: bring a ruler and a phone with a stopwatch. We measure g with a pendulum.'],
  [2, 'tess', 'do we work in pairs?'],
  [1, 'mr-okafor', 'Pairs of two, one group of three. Pick your partner before Thursday.'],
  [4, 'omar', 'what length should the string be?'],
  [1, 'mr-okafor', 'Try three lengths between 30 cm and 1 m. The period only depends on the length:\n```\nT = 2π √(L / g)\n```', { react: { '💡': ['omar', 'zoe'] } }],
  [3, 'zoe', 'so a heavier weight changes nothing?'],
  [1, 'mr-okafor', 'zoe: that is exactly what you are going to check.'],
]);

// ---- staffroom
talk('#staffroom', 3 * 60, [
  [0, 'ms-rivera', 'Is the projector in 2.14 fixed? I want to put the class code on the board tomorrow.'],
  [4, 'mr-okafor', 'Fixed this morning. HDMI only, the old cable is gone.'],
  [1, 'ms-rivera', 'Thanks!'],
]);

// ---- a question in private
clock.t = Date.now() - 40 * MINUTE;
hub.send(people.ivy, 'ms-rivera', 'I was ill on Tuesday. Is there something I should catch up on?');
clock.t += 6 * MINUTE;
hub.send(people['ms-rivera'], 'ivy', 'Hope you feel better. Read the quiz and the answers above it in the class, that covers it.');

clock.t = Date.now();
hub.close();
store.close();
console.log(`Seeded ${config.dbPath}: 2 teachers and 10 students (password "${PASSWORD}").`);
console.log(JSON.stringify(codes));
