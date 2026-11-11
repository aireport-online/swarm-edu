import { app } from './app.js';
import { $ } from './ui/dom.js';
import { focusInput } from './ui/composer.js';
import './ui/dialogs.js';
import './ui/log.js';
import { initLogin } from './ui/login.js';
import './ui/members.js';
import { closePopover } from './ui/overlay.js';
import './ui/school.js';
import './ui/sidebar.js';
import './ui/topbar.js';

const root = document.documentElement;
const login = $('#login');
const chat = $('#chat');

// ------------------------------------------------------------------- theme

// Two skies. Without a choice of your own, the system's light or dark decides.
const prefersDark = matchMedia('(prefers-color-scheme: dark)');
function applyTheme() {
  const chosen = { day: 'day', dusk: 'dusk', light: 'day', dark: 'dusk' }[app.theme];
  root.dataset.theme = chosen ?? (prefersDark.matches ? 'dusk' : 'day');
}
applyTheme();
app.on('theme', applyTheme);
prefersDark.addEventListener('change', () => {
  applyTheme();
  app.emit('theme');
});

const applySettings = () => document.body.classList.toggle('no-flock', !app.settings.flock);
applySettings();
app.on('settings', applySettings);

// ------------------------------------------------------------------ phases

app.on('phase', ({ phase }) => {
  const inChat = phase === 'online' || phase === 'reconnecting';
  login.hidden = inChat;
  chat.hidden = !inChat;
  root.dataset.phase = phase;
  if (!inChat) {
    closePopover();
    document.title = app.info.name ?? 'Swarm';
  }
});

// ------------------------------------------------------- title and pings

function title() {
  if (app.phase === 'login' || !app.active) return;
  let unread = 0;
  let pings = 0;
  for (const buffer of app.buffers.values()) {
    unread += buffer.unread;
    pings += buffer.mentions;
  }
  const name = app.active.type === 'status' ? 'Status' : app.active.name;
  document.title = `${pings ? `(${pings}) ` : unread ? '• ' : ''}${name} · ${app.server.name}`;
}
app.on('buffers', title);
app.on('active', title);

app.on('ping', ({ buffer, msg }) => {
  if (!app.settings.notify || !document.hidden || Notification.permission !== 'granted') return;
  const notification = new Notification(buffer.type === 'dm' ? msg.nick : `${msg.nick} in ${buffer.name}`, {
    body: msg.text.slice(0, 200),
    tag: buffer.key,
  });
  notification.onclick = () => {
    focus();
    app.activate(buffer.key);
    notification.close();
  };
});

app.on('toggle-notify', async () => {
  if (app.settings.notify) return app.setSetting('notify', false);
  if (!('Notification' in window)) return app.note(app.active, 'error', 'This browser cannot show notifications.');
  const permission = await Notification.requestPermission();
  if (permission === 'granted') app.setSetting('notify', true);
  else app.note(app.active, 'error', 'Notifications are blocked for this site in your browser settings.');
});

// --------------------------------------------------------- layout toggles

if (app.stored.get('membersHidden')) document.body.classList.add('members-hidden');
app.on('toggle-members', () => {
  // On a phone the list is a drawer; on a desktop it is a column that can be put away.
  if (matchMedia('(max-width: 900px)').matches) {
    document.body.classList.toggle('members-open');
  } else {
    app.stored.set('membersHidden', document.body.classList.toggle('members-hidden') || null);
  }
});
$('#scrim').addEventListener('click', () => document.body.classList.remove('nav-open', 'members-open'));
app.on('active', () => document.body.classList.remove('nav-open', 'members-open'));

// --------------------------------------------------------------- keyboard

addEventListener('keydown', (event) => {
  if (app.phase !== 'online' && app.phase !== 'reconnecting') return;
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    return app.emit('dialog', 'jump');
  }
  if (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
    event.preventDefault();
    const order = [...app.list('channel'), ...app.list('dm'), app.buffers.get('*')];
    const index = order.findIndex((buffer) => buffer.key === app.activeKey);
    const next = order[(index + (event.key === 'ArrowDown' ? 1 : -1) + order.length) % order.length];
    return app.activate(next.key);
  }
  if (event.key === 'Escape') document.body.classList.remove('nav-open', 'members-open');
  // Typing anywhere lands in the message box.
  const typing = event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey;
  const busy = document.activeElement?.matches('input, textarea, select, [contenteditable]') || document.querySelector('dialog[open], .popover');
  if (typing && !busy) focusInput();
});

// -------------------------------------------------------------------- boot

async function boot() {
  await initLogin();
  if (await app.resume()) return;
  // /?nick=ada connects straight away as a guest, for links and demos.
  const nick = new URLSearchParams(location.search).get('nick');
  if (nick) {
    for (const candidate of [nick, `${nick}_`, `${nick}__`]) {
      try {
        await app.connect({ nick: candidate });
        history.replaceState(null, '', location.pathname + location.hash);
        return;
      } catch (err) {
        if (err.code !== 'nick_in_use') break;
      }
    }
  }
  app.setPhase('login');
}
boot();
