// The classroom on top of the chat: the class code and the board view, quiet
// mode and hands, polls, the pinned message, reports and the transcript.
import { app } from '../app.js';
import { formatAgo, formatDay, formatTime } from '../format.js';
import { Flock } from '../swarm.js';
import { $, fill, h, icon } from './dom.js';
import { reveal } from './log.js';
import { dialog } from './overlay.js';

/** "K7M2QX" as people read it out: "K7M 2QX". */
export const spellCode = (code) => (code ? `${code.slice(0, 3)} ${code.slice(3)}` : '');
const joinLink = (code) => `${location.origin}/#join=${code}`;
const onlineIn = (buffer) => [...buffer.members.values()].filter((member) => member.online);

// ------------------------------------------------------------ pinned message

const pinnedBar = $('#pinned');

function showPinned() {
  const buffer = app.active;
  const pinned = buffer?.type === 'channel' ? buffer.pinned : null;
  pinnedBar.hidden = !pinned;
  if (!pinned) return;
  fill(
    pinnedBar,
    icon('pin', 15),
    h(
      'button.pinned-text',
      { type: 'button', title: 'Show this message', on: { click: () => reveal(pinned.id) } },
      h('span.pinned-nick', null, pinned.nick),
      h('span', null, pinned.text),
    ),
    app.runs(buffer) &&
      h('button.icon-button', { type: 'button', title: 'Take it down', 'aria-label': 'Unpin', on: { click: () => app.run('pin', { channel: buffer.name, msgId: null }) } }, icon('x', 14)),
  );
}

// ---------------------------------------------------- hand and poll buttons

const input = $('#input');
const tools = h('div.composer-tools');
$('.composer-box').insertBefore(tools, $('.composer-box .send'));

function showTools() {
  const buffer = app.active;
  if (!buffer || !app.self) return;
  const inClass = buffer.type === 'channel';
  const muted = app.muted(buffer);
  const up = inClass && buffer.hands.some((nick) => app.isSelf(nick));
  input.disabled = muted;
  document.body.classList.toggle('quiet', muted);
  fill(
    tools,
    inClass && !app.runs(buffer) &&
      h(
        `button.tool${up ? '.on' : ''}`,
        {
          type: 'button', 'aria-pressed': String(up), title: up ? 'Lower your hand' : 'Raise your hand',
          on: { click: () => app.run('hand', { channel: buffer.name, up: !up }) },
        },
        icon('hand', 20),
        (muted || up) && h('span', null, up ? 'Hand is up' : 'Raise your hand'),
      ),
    inClass && app.runs(buffer) &&
      h('button.tool', { type: 'button', title: 'Ask the class: poll or quiz', 'aria-label': 'New poll', on: { click: () => app.emit('dialog', 'poll') } }, icon('poll', 20)),
  );
}

for (const name of ['active', 'header', 'members', 'hands', 'self']) {
  app.on(name, showTools);
  app.on(name, showPinned);
}

// ----------------------------------------------------------- the board view

/** Full screen, for the projector: where to go, what to type, and who is in. */
function board(buffer) {
  let sync;
  const el = dialog(`Join ${buffer.name}`, (close) => {
    const canvas = h('canvas.board-flock', { 'aria-hidden': 'true' });
    const flock = new Flock(canvas);
    const count = h('p.board-count');
    const code = h('p.board-code');
    sync = () => {
      if (!app.buffers.has(buffer.key)) return;
      const online = onlineIn(buffer);
      flock.setBirds(online.map((member) => ({ id: member.nick.toLowerCase(), self: app.isSelf(member.nick) })));
      count.textContent = `${online.length} ${online.length === 1 ? 'person is' : 'people are'} here`;
      code.textContent = spellCode(buffer.code) || 'no code';
    };
    app.on('members', sync);
    app.on('school', sync);
    requestAnimationFrame(sync);
    return h(
      'div.board',
      null,
      canvas,
      h('p.board-class', null, buffer.name),
      h('p.board-step', null, 'Go to ', h('strong', null, location.host), ' and type this code'),
      code,
      count,
      h('button.button.primary.board-close', { type: 'button', on: { click: close } }, 'Back to the class'),
    );
  });
  el.classList.add('board-dialog');
  el.addEventListener('close', () => {
    app.off('members', sync);
    app.off('school', sync);
  });
}

// -------------------------------------------------------- the class dialog

async function download(buffer) {
  const data = await app.run('transcript', { channel: buffer.name });
  if (!data) return;
  const lines = [`${data.name}${data.topic ? ` — ${data.topic}` : ''}`, ''];
  let day = '';
  for (const line of data.lines) {
    const date = new Date(line.ts).toDateString();
    if (date !== day) lines.push('', `— ${new Date(line.ts).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })} —`);
    day = date;
    const text = line.kind === 'action' ? `* ${line.nick} ${line.text}` : `<${line.nick}> ${line.kind === 'poll' ? '[poll] ' : ''}${line.text}`;
    lines.push(`[${formatTime(line.ts)}] ${text}`);
  }
  const url = URL.createObjectURL(new Blob([`${lines.join('\n')}\n`], { type: 'text/plain;charset=utf-8' }));
  const link = h('a', { href: url, download: `${data.name.slice(1)}-transcript.txt` });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function switchRow(title, detail, on, change) {
  return h(
    'div.switch-row',
    null,
    h('div', null, h('p.switch-title', null, title), h('p.switch-detail', null, detail)),
    h('button.switch', { type: 'button', role: 'switch', 'aria-checked': String(on), 'aria-label': title, on: { click: change } }, h('i')),
  );
}

function classDialog(buffer) {
  let redraw;
  let onHeader;
  const el = dialog(`Class ${buffer.name}`, (close) => {
    const body = h('div.class-panel');
    let people = null;

    function draw() {
      if (!app.buffers.has(buffer.key) || !app.runs(buffer)) return close();
      const quiet = buffer.modes.includes('m');
      const locked = buffer.modes.includes('i');
      fill(
        body,
        h('header.class-head', null, h('h2', null, buffer.name), h('button.icon-button', { type: 'button', 'aria-label': 'Close', on: { click: close } }, icon('x'))),

        h(
          'section.class-code',
          null,
          buffer.code
            ? [
                h('p.code', { 'aria-label': `Class code ${buffer.code.split('').join(' ')}` }, spellCode(buffer.code)),
                h('p.class-note', null, 'Students go to ', h('strong', null, location.host), ', type their name and this code.'),
              ]
            : h('p.class-note', null, 'This class has no code: any teacher can come in, students cannot.'),
          h(
            'div.class-actions',
            null,
            buffer.code && h('button.pill', { type: 'button', on: { click: () => { close(); board(buffer); } } }, icon('board', 16), 'Show on the board'),
            buffer.code &&
              h(
                'button.pill',
                {
                  type: 'button',
                  on: {
                    click: async (event) => {
                      const label = event.currentTarget.lastChild;
                      try {
                        await navigator.clipboard.writeText(joinLink(buffer.code));
                        label.textContent = 'Link copied';
                      } catch {
                        label.textContent = joinLink(buffer.code);
                      }
                    },
                  },
                },
                icon('copy', 16),
                h('span', null, 'Copy the join link'),
              ),
            h('button.pill', { type: 'button', on: { click: () => app.run('code', { channel: buffer.name, action: 'new' }) } }, buffer.code ? 'New code' : 'Give it a code'),
          ),
        ),

        h(
          'section',
          null,
          switchRow('Quiet mode', 'Only you and whoever you give the floor can write. Students raise a hand.', quiet, () => app.setFlag('m', !quiet, buffer)),
          switchRow('Lock the class', 'Nobody new can join, even with the code.', locked, () => app.setFlag('i', !locked, buffer)),
        ),

        buffer.reports.length > 0 &&
          h(
            'section',
            null,
            h('h3', null, 'Reported to you', h('span.count', null, String(buffer.reports.length))),
            buffer.reports.map((report) =>
              h(
                'div.report',
                null,
                h('p.report-text', null, h('strong', null, report.msg.nick), ' ', report.msg.text),
                h('p.report-meta', null, `reported by ${report.by}, ${formatDay(report.at).toLowerCase()} ${formatTime(report.at)}`),
                h(
                  'div.class-actions',
                  null,
                  h('button.pill', { type: 'button', on: { click: () => { close(); setTimeout(() => reveal(report.msg.id), 100); } } }, 'Show'),
                  h('button.pill.danger', { type: 'button', on: { click: () => app.run('delete', { msgId: report.msg.id }) } }, 'Delete the message'),
                  h('button.pill', { type: 'button', on: { click: () => app.run('resolveReport', { reportId: report.id }) } }, 'Nothing wrong'),
                ),
              ),
            ),
          ),

        h(
          'section',
          null,
          h(
            'div.class-row',
            null,
            h('h3', null, 'Who took part'),
            h('button.pill', { type: 'button', on: { click: () => download(buffer) } }, icon('download', 16), 'Transcript'),
          ),
          people === null
            ? h('p.class-note', null, 'Counting…')
            : h(
                'table.people-table',
                null,
                h('thead', null, h('tr', null, h('th', null, 'Name'), h('th.num', null, 'Messages'), h('th.num', null, 'Last spoke'))),
                h(
                  'tbody',
                  null,
                  people.map((row) =>
                    h(
                      'tr',
                      null,
                      h('td', null, row.nick),
                      h('td.num', null, String(row.messages)),
                      h('td.num', null, row.lastAt ? `${formatAgo(Date.now() - row.lastAt)} ago` : h('span.dash', { 'aria-label': 'never' }, '–')),
                    ),
                  ),
                ),
              ),
        ),
      );
    }

    redraw = (changed) => {
      if (body.isConnected && (!changed || changed === buffer)) draw();
    };
    onHeader = () => redraw(app.active);
    app.on('school', redraw);
    app.on('header', onHeader);
    draw();
    app.request('participation', { channel: buffer.name }).then(({ people: rows }) => {
      people = rows;
      redraw();
    }).catch(() => {});
    return body;
  });
  el.classList.add('class-dialog');
  el.addEventListener('close', () => {
    app.off('school', redraw);
    app.off('header', onHeader);
  });
}

// ------------------------------------------------------------ a new poll

function pollDialog(buffer) {
  dialog('Ask the class', (close) => {
    const question = h('input.dialog-field', { type: 'text', maxLength: 300, placeholder: 'What do you want to ask?', 'aria-label': 'Question' });
    const options = h('div.poll-form-options');
    const error = h('p.login-error', { role: 'alert', hidden: true });
    const addButton = h('button.pill', { type: 'button', on: { click: () => addOption('', true) } }, icon('plus', 16), 'Another option');

    function addOption(value = '', focus = false) {
      const count = options.children.length;
      if (count >= 8) return;
      const field = h('input.dialog-field', { type: 'text', maxLength: 120, value, placeholder: `Option ${count + 1}`, 'aria-label': `Option ${count + 1}` });
      options.append(
        h(
          'div.poll-form-row',
          null,
          field,
          h('label.right-answer', { title: 'Marks the right answer and makes this a quiz' }, h('input', { type: 'radio', name: 'right', value: String(count), 'aria-label': `Option ${count + 1} is the right answer` }), h('span', null, 'right')),
        ),
      );
      addButton.hidden = options.children.length >= 8;
      if (focus) field.focus();
    }
    addOption();
    addOption();

    async function send(event) {
      event.preventDefault();
      const rows = [...options.children].map((row) => ({ text: row.querySelector('input[type=text]').value.trim(), right: row.querySelector('input[type=radio]').checked }));
      const filled = rows.filter((row) => row.text);
      const right = filled.findIndex((row) => row.right);
      try {
        await app.request('poll', {
          channel: buffer.name, question: question.value, options: filled.map((row) => row.text), correct: right < 0 ? null : right,
        });
        close();
      } catch (err) {
        error.textContent = err.message;
        error.hidden = false;
      }
    }

    return h(
      'form.class-panel',
      { on: { submit: send } },
      h('header.class-head', null, h('h2', null, 'Ask the class'), h('button.icon-button', { type: 'button', 'aria-label': 'Close', on: { click: close } }, icon('x'))),
      question,
      options,
      h('p.class-note', null, 'Mark one option as right to make it a quiz: answers and results then stay hidden until you close it. Without one it is a poll, and everyone sees the results once they have voted.'),
      error,
      h('div.class-row', null, addButton, h('button.button.primary', { type: 'submit' }, 'Ask')),
    );
  }).classList.add('class-dialog');
}

app.on('dialog', (request) => {
  const name = typeof request === 'string' ? request : request.name;
  const buffer = app.active;
  if (buffer?.type !== 'channel') return;
  if (name === 'class' && app.runs(buffer)) classDialog(buffer);
  if (name === 'poll' && app.runs(buffer)) pollDialog(buffer);
  if (name === 'board' && app.runs(buffer) && buffer.code) board(buffer);
});
