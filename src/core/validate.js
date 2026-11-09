import { ChatError } from './errors.js';

const NICK_RE = /^[A-Za-z_][A-Za-z0-9_-]{1,19}$/;
const CHANNEL_RE = /^#[a-z0-9][a-z0-9_.-]{0,31}$/;
const RESERVED_NICKS = new Set(['nickserv', 'chanserv', 'server', 'system', 'swarm']);

// IRC colour codes carry their arguments with them; the other formatting
// codes are single bytes. Tabs and newlines are the only control characters
// that survive.
const IRC_COLOUR_RE = /\x03(\d{1,2}(,\d{1,2})?)?/g;
const CONTROL_RE = /[\x00-\x08\x0b-\x1f\x7f]/g;

export const nickKey = (nick) => nick.toLowerCase();

export function parseNick(value) {
  if (typeof value !== 'string' || !NICK_RE.test(value)) {
    throw new ChatError(
      'invalid_nick',
      'A nick is 2 to 20 characters: letters, digits, "_" or "-", and it cannot start with a digit or "-".',
    );
  }
  if (RESERVED_NICKS.has(nickKey(value))) {
    throw new ChatError('invalid_nick', `The nick ${value} is reserved.`);
  }
  return value;
}

export function parseChannel(value) {
  if (typeof value !== 'string') throw new ChatError('invalid_channel', 'Channel name missing.');
  let name = value.trim().toLowerCase();
  if (!name.startsWith('#')) name = `#${name}`;
  if (!CHANNEL_RE.test(name)) {
    throw new ChatError(
      'invalid_channel',
      'A channel name is "#" followed by 1 to 32 letters, digits, ".", "_" or "-".',
    );
  }
  return name;
}

export const isChannelName = (value) => typeof value === 'string' && value.startsWith('#');

export function cleanText(value) {
  return value
    .replace(/\r\n?/g, '\n')
    .replace(IRC_COLOUR_RE, '')
    .replace(CONTROL_RE, '');
}

export function parseText(value, maxLength) {
  if (typeof value !== 'string') throw new ChatError('bad_request', 'Message text missing.');
  // Length first: nothing below should ever run over an oversized string.
  if (value.length > maxLength) {
    throw new ChatError('too_long', `Messages are limited to ${maxLength} characters.`);
  }
  const text = cleanText(value).trimEnd();
  if (!text.trim()) throw new ChatError('bad_request', 'Cannot send an empty message.');
  return text;
}

export function parseLine(value, maxLength, what) {
  if (typeof value !== 'string') throw new ChatError('bad_request', `${what} missing.`);
  if (value.length > maxLength * 4) {
    throw new ChatError('too_long', `${what} is limited to ${maxLength} characters.`);
  }
  const line = cleanText(value).replace(/\s+/g, ' ').trim();
  if (line.length > maxLength) {
    throw new ChatError('too_long', `${what} is limited to ${maxLength} characters.`);
  }
  return line;
}

export function parsePassword(value) {
  if (typeof value !== 'string' || value.length < 8 || value.length > 200) {
    throw new ChatError('bad_password', 'A password is 8 to 200 characters.');
  }
  return value;
}

export function parseEmoji(value) {
  if (typeof value !== 'string' || !value || value.length > 16 || /[\s\x00-\x1f]/.test(value)) {
    throw new ChatError('bad_request', 'Not a usable reaction.');
  }
  return value;
}
