// Fills a database with a small, believable community, for demos and
// screenshots:  DB_PATH=data/demo.db npm run seed
// Every account gets the password "swarm-demo".
import { loadConfig } from '../src/config.js';
import { Hub } from '../src/core/hub.js';
import { Store } from '../src/db.js';

const PASSWORD = 'swarm-demo';
const MINUTE = 60_000;
const config = loadConfig();
const store = new Store(config.dbPath);
const clock = { t: Date.now() - 3 * 24 * 60 * MINUTE };
const hub = new Hub({
  store,
  now: () => clock.t,
  config: { ...config.hub, graceMs: 0, messageBurst: 1e9, defaultChannels: ['#lobby'], admins: ['ada'] },
});

if (store.accountByKey('ada')) {
  console.error(`${config.dbPath} already holds the demo data.`);
  process.exit(1);
}

const people = {};
for (const nick of ['ada', 'linus', 'grace', 'mira', 'niko', 'sam', 'jules', 'kai', 'ivan', 'chloe']) {
  const conn = { id: nick, user: null, deliver() {} };
  await hub.login(conn, { nick, password: PASSWORD, register: true, session: false });
  people[nick] = conn.user;
}

const channels = {
  '#dev': { topic: 'Ship small, ship often', members: ['ada', 'linus', 'grace', 'mira', 'niko', 'sam', 'kai'], voiced: ['mira', 'niko'], ops: ['linus'] },
  '#design': { topic: 'Critique on Thursdays. Bring screenshots.', members: ['mira', 'chloe', 'jules', 'ada', 'sam'], ops: [] },
  '#music': { topic: 'What is playing right now', members: ['kai', 'ivan', 'jules'], ops: [] },
  '#random': { topic: 'Anything that fits nowhere else', members: ['sam', 'ivan', 'chloe', 'grace', 'linus', 'niko'], ops: [] },
};
for (const [name, { topic, members, voiced = [], ops }] of Object.entries(channels)) {
  const [founder, ...rest] = members;
  hub.join(people[founder], name);
  hub.setTopic(people[founder], name, topic);
  for (const nick of rest) hub.join(people[nick], name);
  const changes = [...ops.map((arg) => ({ add: true, mode: 'o', arg })), ...voiced.map((arg) => ({ add: true, mode: 'v', arg }))];
  if (changes.length) hub.setMode(people[founder], name, changes);
}
hub.setTopic(people.ada, '#lobby', 'Welcome. Say hello, then /join a channel that fits.');

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
}

talk('#lobby', 2 * 24 * 60, [
  [0, 'ada', 'Morning all. New here? This is where everyone lands first.'],
  [3, 'ivan', 'hi! found this through the IRC port, connected with WeeChat and it just worked'],
  [1, 'ada', 'that is the idea: same channels from a browser or from any IRC client', { react: { '🎉': ['ivan', 'kai'] } }],
  [42, 'chloe', 'is there a channel for design talk?'],
  [1, 'mira', 'chloe: #design, critique is on Thursdays'],
  [0, 'chloe', 'perfect, thanks'],
]);

talk('#dev', 26 * 60, [
  [0, 'linus', 'the reconnect bug is fixed on main: clients no longer lose the last few messages'],
  [2, 'ada', 'nice. what was it?'],
  [1, 'linus', 'history was requested before the session resumed, so the server answered for a guest'],
  [4, 'mira', 'should we add a test around that?'],
  [1, 'linus', 'already in: `resumes by token before asking for history`', { react: { '👍': ['ada', 'mira', 'niko'] } }],
  [35, 'niko', 'unrelated: the IRC gateway now plays back history with server-time tags'],
  [2, 'sam', 'niko: does that work in irssi?'],
  [1, 'niko', 'yes, anything that asks for the server-time capability. others just join without playback', { reply: 6 }],
]);

talk('#dev', 190, [
  [0, 'ada', 'pushed a small refactor of the message parser'],
  [1, 'linus', 'the diff is much easier to read now'],
  [1, 'mira', 'should we add more tests around edge cases?'],
  [1, 'ada', 'yes, especially malformed input'],
  [2, 'linus', 'how about we fuzz it a bit?'],
  [2, 'mira', 'good call', { react: { '❤️': ['ada'] } }],
  [1, 'ada', 'here is the tweak that came out of it:\n```\nif (line.length > MAX_LINE) return drop(client, "line too long");\n```'],
  [2, 'linus', 'looks good'],
  [38, 'kai', 'waves from the train', { kind: 'action' }],
  [1, 'kai', 'reading back now, back online properly in an hour'],
  [44, 'grace', 'is there a docs plan for the retry policy?'],
  [1, 'ada', 'draft is in docs/reliability.md, comments welcome'],
  [3, 'grace', 'reading it now. **backoff with jitter** deserves its own section', { reply: 11 }],
  [1, 'sam', 'agreed, and a link to https://aws.amazon.com/builders-library/timeouts-retries-and-backoff-with-jitter/ would save us a page'],
]);

talk('#design', 5 * 60, [
  [0, 'mira', 'new sidebar: people are dots, a channel is a little swarm of them'],
  [2, 'chloe', 'love that it says how busy a channel is without a number'],
  [1, 'jules', 'does it hold up with 200 people?'],
  [1, 'mira', 'it caps at nine dots, after that the count takes over', { reply: 2, react: { '👀': ['jules'], '👍': ['chloe', 'ada'] } }],
  [26, 'ada', 'can we try the light theme on a projector before Thursday?'],
  [1, 'chloe', 'I will bring one'],
]);

talk('#music', 9 * 60, [
  [0, 'kai', 'Nils Frahm, "Says". eight minutes of patience'],
  [3, 'ivan', 'good pick for a Monday'],
  [61, 'jules', 'anyone going to the Colin Stetson show next month?'],
  [2, 'kai', 'got tickets yesterday', { react: { '🔥': ['jules'] } }],
]);

talk('#random', 7 * 60, [
  [0, 'sam', 'the office plant has a new leaf. that is the news'],
  [1, 'chloe', 'pics or it did not happen'],
  [4, 'ivan', 'TIL starlings in a murmuration each track about seven neighbours'],
  [1, 'grace', 'seven! not the whole flock?'],
  [1, 'ivan', 'seven is enough for the whole flock to turn together', { react: { '🤯': ['grace', 'sam', 'niko'] } }],
]);

clock.t = Date.now() - 50 * MINUTE;
hub.send(people.grace, 'ada', 'do you have ten minutes to look at the retry doc with me?');
clock.t += 2 * MINUTE;
hub.send(people.ada, 'grace', 'sure, after standup');
clock.t = Date.now() - 20 * MINUTE;
hub.send(people.linus, 'ada', 'the parser refactor is merged, thanks for the quick review');

clock.t = Date.now();
hub.close();
store.close();
console.log(`Seeded ${config.dbPath}: ${Object.keys(people).length} accounts (password "${PASSWORD}"), ${Object.keys(channels).length + 1} channels.`);
