import { app } from '../app.js';
import { COMMANDS, submit } from '../commands.js';
import { $, fill, h, icon } from './dom.js';

const form = $('#composer');
const input = $('#input');
const context = $('#composer-context');
const list = $('#complete');
const typingLine = $('#typing');
const TYPING_EVERY_MS = 3000;

/** What the next message does: answers `reply`, or replaces `edit`. */
let reply = null;
let edit = null;
const sent = [];
let sentIndex = -1;
let lastTypingAt = 0;
/** Tab completion in progress: the candidates and where the word started. */
let cycle = null;
/** The slash-command list under the box. */
let options = [];
let optionIndex = 0;

form.querySelector('.send').append(icon('send', 18));

function resize() {
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, innerHeight * 0.4)}px`;
}

function setValue(value) {
  input.value = value;
  resize();
  input.focus();
  input.setSelectionRange(value.length, value.length);
  showOptions();
}

function showContext() {
  const subject = edit ?? reply;
  context.hidden = !subject;
  if (!subject) return;
  fill(
    context,
    h('span.context-label', null, edit ? 'Editing your message' : `Replying to ${reply.nick}`),
    h('span.context-text', null, subject.text),
    h('button.icon-button', { type: 'button', 'aria-label': 'Cancel', title: 'Cancel (Esc)', on: { click: cancelContext } }, icon('x', 14)),
  );
}

function cancelContext() {
  if (edit) setValue('');
  reply = null;
  edit = null;
  showContext();
  input.focus();
}

function placeholder() {
  const buffer = app.active;
  if (!buffer) return;
  input.placeholder =
    buffer.type === 'status' ? (app.self?.teacher ? 'Type /class <name> to open a class, or /help' : 'Type /joincode <code> to join a class, or /help') :
    app.muted(buffer) ? 'Quiet mode. Raise your hand to ask for the floor.' :
    `Message ${buffer.name}`;
}

// ---------------------------------------------------------------- commands

function showOptions() {
  const match = /^\/(\w*)$/.exec(input.value);
  options = match ? Object.keys(COMMANDS).filter((name) => name.startsWith(match[1].toLowerCase())) : [];
  optionIndex = Math.min(optionIndex, Math.max(0, options.length - 1));
  list.hidden = options.length === 0;
  if (!options.length) return;
  fill(
    list,
    options.map((name, i) =>
      h(
        `li${i === optionIndex ? '.selected' : ''}`,
        { role: 'option', 'aria-selected': String(i === optionIndex), on: { mousedown: (event) => { event.preventDefault(); setValue(`/${name} `); } } },
        h('span.complete-name', null, `/${name}`),
        h('span.complete-usage', null, COMMANDS[name].usage),
        h('span.complete-help', null, COMMANDS[name].help),
      ),
    ),
  );
  list.querySelector('.selected')?.scrollIntoView({ block: 'nearest' });
}

// ---------------------------------------------------------- tab completion

function candidates(word, atStart) {
  const lower = word.toLowerCase();
  const buffer = app.active;
  if (word.startsWith('/') && atStart) {
    return Object.keys(COMMANDS).filter((name) => `/${name}`.startsWith(lower)).map((name) => `/${name} `);
  }
  if (word.startsWith('#')) {
    return app.list('channel').map((channel) => channel.name).filter((name) => name.startsWith(lower)).map((name) => `${name} `);
  }
  const bare = lower.replace(/^@/, '');
  if (!bare) return [];
  // Whoever spoke last is the likeliest person to be answered.
  const recent = [...new Set(buffer.items.filter((item) => !item.local).map((item) => item.nick).reverse())];
  const nicks = [...new Set([...recent, ...[...buffer.members.values()].map((member) => member.nick), ...(buffer.type === 'dm' ? [buffer.name] : [])])];
  return nicks
    .filter((nick) => nick.toLowerCase().startsWith(bare) && !app.isSelf(nick))
    .map((nick) => (atStart ? `${nick}: ` : `${nick} `));
}

function complete() {
  if (!cycle) {
    const caret = input.selectionStart;
    const start = input.value.slice(0, caret).search(/\S+$/);
    if (start < 0) return;
    const found = candidates(input.value.slice(start, caret), start === 0);
    if (!found.length) return;
    cycle = { start, end: caret, found, index: -1 };
  }
  cycle.index = (cycle.index + 1) % cycle.found.length;
  const text = cycle.found[cycle.index];
  input.setRangeText(text, cycle.start, cycle.end, 'end');
  cycle.end = cycle.start + text.length;
  resize();
}

// ------------------------------------------------------------------ sending

async function send() {
  const text = input.value.replace(/\s+$/, '');
  if (!text.trim()) return;
  if (sent.at(-1) !== text) sent.push(text);
  sentIndex = -1;
  lastTypingAt = 0; // the message ends the "is typing" on the other side; the next key restarts it
  let ok;
  if (edit) {
    ok = (await app.run('edit', { msgId: edit.id, text })) !== undefined;
  } else {
    ok = await submit(text, { replyTo: reply?.id ?? null });
  }
  // Only clear what was sent: the user may have typed on while waiting.
  if (ok !== false && input.value.replace(/\s+$/, '') === text) {
    input.value = '';
    resize();
  }
  if (ok !== false) {
    reply = null;
    edit = null;
    showContext();
  }
  showOptions();
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  send();
});

input.addEventListener('keydown', (event) => {
  if (event.isComposing) return;
  if (event.key !== 'Tab') cycle = null;

  if (options.length && ['ArrowDown', 'ArrowUp'].includes(event.key)) {
    event.preventDefault();
    optionIndex = (optionIndex + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length;
    return showOptions();
  }
  if (event.key === 'Tab' && !event.shiftKey && !event.ctrlKey && !event.altKey) {
    if (options.length) {
      event.preventDefault();
      return setValue(`/${options[optionIndex]} `);
    }
    if (input.value.slice(0, input.selectionStart).trim()) {
      event.preventDefault();
      complete();
    }
    return;
  }
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    if (options.length && `/${options[optionIndex]}` !== input.value) return setValue(`/${options[optionIndex]} `);
    return send();
  }
  if (event.key === 'Escape' && (reply || edit)) return cancelContext();

  // Up and Down walk through what was sent before, as in any IRC client.
  const firstLine = !input.value.slice(0, input.selectionStart).includes('\n');
  const lastLine = !input.value.slice(input.selectionEnd).includes('\n');
  if (event.key === 'ArrowUp' && firstLine && sent.length && (input.value === '' || sentIndex >= 0)) {
    event.preventDefault();
    sentIndex = sentIndex < 0 ? sent.length - 1 : Math.max(0, sentIndex - 1);
    setValue(sent[sentIndex]);
  } else if (event.key === 'ArrowDown' && lastLine && sentIndex >= 0) {
    event.preventDefault();
    sentIndex += 1;
    if (sentIndex >= sent.length) sentIndex = -1;
    setValue(sentIndex < 0 ? '' : sent[sentIndex]);
  }
});

input.addEventListener('input', () => {
  resize();
  optionIndex = 0;
  showOptions();
  const buffer = app.active;
  const now = Date.now();
  if (buffer.type !== 'status' && input.value && !input.value.startsWith('/') && now - lastTypingAt > TYPING_EVERY_MS) {
    lastTypingAt = now;
    app.request('typing', { target: buffer.name }).catch(() => {});
  }
});
input.addEventListener('blur', () => {
  list.hidden = true;
});
input.addEventListener('focus', showOptions);

// ------------------------------------------------------------------ outside

let draftOwner = null;
app.on('active', (buffer) => {
  if (draftOwner) draftOwner.draft = edit ? '' : input.value;
  draftOwner = buffer;
  reply = null;
  edit = null;
  showContext();
  input.value = buffer.draft;
  resize();
  placeholder();
  showOptions();
  showTyping(buffer);
  // On a phone, focusing would pop the keyboard over what the user came to read.
  if (matchMedia('(pointer: fine)').matches) input.focus();
});

app.on('compose', ({ reply: msg, edit: own, prefill, insert }) => {
  if (msg) {
    reply = msg;
    edit = null;
    showContext();
    input.focus();
  } else if (own) {
    edit = own;
    reply = null;
    showContext();
    setValue(own.text);
  } else if (prefill != null) {
    setValue(prefill);
  } else if (insert != null) {
    setValue(input.value + insert);
  }
});

app.on('command', (line) => submit(line));

function showTyping(buffer) {
  if (buffer !== app.active) return;
  const nicks = [...buffer.typing.values()].map((entry) => entry.nick);
  const text =
    nicks.length === 0 ? '' :
    nicks.length === 1 ? `${nicks[0]} is typing` :
    nicks.length === 2 ? `${nicks[0]} and ${nicks[1]} are typing` :
    'Several people are typing';
  fill(typingLine, text && h('span.typing-dots', { 'aria-hidden': 'true' }, h('i'), h('i'), h('i')), text);
}
app.on('typing', showTyping);
app.on('buffers', placeholder);
app.on('header', placeholder);
app.on('members', placeholder);

/** Puts the caret in the message box. */
export const focusInput = () => input.focus();
