import { app } from '../app.js';
import { $ } from './dom.js';

const form = $('#login-form');
const error = $('#login-error');
const hint = $('#login-hint');
const passwordField = $('#password-field');
const HINTS = {
  guest: 'No account needed. The nick is yours for as long as you are connected.',
  signin: 'For a nick you registered earlier.',
  register: 'Claims the nick with a password, and keeps your channels and messages between visits.',
};

const mode = () => new FormData(form).get('mode');

function syncMode() {
  const current = mode();
  passwordField.hidden = current === 'guest';
  form.elements.password.required = current !== 'guest';
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
  if (!nick) return fail('Choose a nick first.');
  const button = form.querySelector('button[type=submit]');
  button.disabled = true;
  fail('');
  try {
    await app.connect({ nick, password, register: current === 'register' });
    form.elements.password.value = '';
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

app.on('phase', ({ phase, message }) => {
  if (phase !== 'login') return;
  if (message) fail(message);
  form.elements.nick.value ||= app.stored.get('nick') ?? '';
  requestAnimationFrame(() => form.elements.nick.focus());
});

export async function initLogin() {
  syncMode();
  try {
    app.info = await (await fetch('/api/info')).json();
    for (const el of document.querySelectorAll('.brand-name')) el.textContent = app.info.name;
    document.title = app.info.name;
    if (app.info.ircPort) {
      const irc = $('#login-irc');
      irc.textContent = `Prefer your own client? Point it at ${location.hostname} port ${app.info.ircPort}.`;
      irc.hidden = false;
    }
  } catch {
    // The page works without the extra details.
  }
}
