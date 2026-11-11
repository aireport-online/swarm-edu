import { app } from '../app.js';
import { Flock, mark } from '../swarm.js';
import { $ } from './dom.js';

const form = $('#login-form');
const error = $('#login-error');
const hint = $('#login-hint');
const passwordField = $('#password-field');
const codeField = $('#code-field');
const staffField = $('#staff-field');
const HINTS = {
  guest: 'No account needed. Letters, digits, "_" and "-", no spaces.',
  signin: 'For a name you registered earlier. Add a class code to join another class as well.',
  register: 'Keeps your name, your classes and your messages between visits. The class code is optional here.',
};

const mode = () => new FormData(form).get('mode');

function syncMode() {
  const current = mode();
  passwordField.hidden = current === 'guest';
  form.elements.password.required = current !== 'guest';
  form.elements.code.required = current === 'guest';
  staffField.hidden = current !== 'register' || !app.info.staffCode;
  form.elements.password.autocomplete = current === 'register' ? 'new-password' : 'current-password';
  hint.textContent = HINTS[current];
}

function fail(message) {
  error.textContent = message;
  error.hidden = !message;
}

form.addEventListener('change', syncMode);
form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const data = new FormData(form);
  const current = mode();
  const nick = data.get('nick').trim();
  const password = current === 'guest' ? undefined : data.get('password');
  const code = data.get('code').trim() || undefined;
  const teacherCode = (current === 'register' && data.get('staff')) || undefined;
  if (!nick) return fail('Type your name first.');
  if (current === 'guest' && !code) return fail('Type the class code your teacher gave you.');
  const button = form.querySelector('button[type=submit]');
  button.disabled = true;
  fail('');
  try {
    await app.connect({ nick, password, register: current === 'register', code, teacherCode });
    form.elements.password.value = '';
    form.elements.staff.value = '';
    form.elements.code.value = '';
  } catch (err) {
    app.setPhase('login');
    fail(err.message);
    // A registered nick needs its password: offer the right form.
    if (err.code === 'nick_registered' && current === 'guest') {
      form.elements.mode.value = 'signin';
      syncMode();
      form.elements.password.focus();
    }
  } finally {
    button.disabled = false;
  }
});

// The sign-in screen's flock: a few hundred birds and, in colour, you.
const canvas = $('#login-flock');
const flock = new Flock(canvas, { mode: 'ribbon' });
flock.populate(innerWidth < 900 ? 420 : 1100);
canvas.addEventListener('pointermove', (event) => {
  const box = canvas.getBoundingClientRect();
  flock.setPointer({ x: event.clientX - box.left, y: event.clientY - box.top });
});
canvas.addEventListener('pointerleave', () => flock.setPointer(null));
app.on('theme', () => requestAnimationFrame(() => flock.readColours()));
$('#login .brand').prepend(mark());

app.on('phase', ({ phase, message }) => {
  requestAnimationFrame(() => flock.wake());
  if (phase !== 'login') return;
  if (message) fail(message);
  form.elements.nick.value ||= app.stored.get('nick') ?? '';
  requestAnimationFrame(() => form.elements.nick.focus());
});

/** A link such as /#join=ABC234 arrives with the class code filled in. */
function codeFromLink() {
  const match = /^#join=([A-Za-z0-9-]{4,14})$/.exec(location.hash);
  if (!match) return;
  form.elements.code.value = match[1].toUpperCase();
  history.replaceState(null, '', location.pathname);
}

export async function initLogin() {
  codeFromLink();
  syncMode();
  try {
    app.info = await (await fetch('/api/info')).json();
    for (const el of document.querySelectorAll('.brand-name')) el.textContent = app.info.name;
    document.title = app.info.name;
    syncMode();
    if (app.info.ircPort) {
      const irc = $('#login-irc');
      irc.textContent = `irc: ${location.hostname}:${app.info.ircPort}`;
      irc.title = 'Any IRC client can connect here too';
      irc.hidden = false;
    }
  } catch {
    // The page works without the extra details.
  }
}
