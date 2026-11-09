import { app } from '../app.js';
import { formatDay, formatTime } from '../format.js';
import { fill, h } from './dom.js';
import { reveal } from './log.js';
import { dialog } from './overlay.js';

/** Arrow keys and Enter drive a result list from its search field. */
function listKeys(input, list) {
  input.addEventListener('keydown', (event) => {
    const rows = [...list.querySelectorAll('button')];
    const current = rows.findIndex((row) => row.classList.contains('selected'));
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const next = (current + (event.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length;
      rows[current]?.classList.remove('selected');
      rows[next]?.classList.add('selected');
      rows[next]?.scrollIntoView({ block: 'nearest' });
    } else if (event.key === 'Enter' && rows[current]) {
      event.preventDefault();
      rows[current].click();
    }
  });
}

/** Go to a channel or a person: joined, known to the server, or brand new. */
function jump() {
  dialog('Jump to', (close) => {
    const input = h('input.dialog-input', { type: 'text', placeholder: 'Find or create a channel, or type a nick', spellcheck: false, autocapitalize: 'none', 'aria-label': 'Channel or nick' });
    const list = h('div.results', { role: 'listbox' });
    let known = [];

    const entry = (name, detail, tag, go) =>
      h('button.result', { type: 'button', on: { click: () => { close(); go(); } } }, h('span.result-name', null, name), h('span.result-detail', null, detail), tag && h('span.tag', null, tag));

    function show() {
      const query = input.value.trim().toLowerCase();
      const rows = [];
      const mine = [...app.list('channel'), ...app.list('dm')].filter((buffer) => buffer.name.toLowerCase().includes(query));
      for (const buffer of mine) {
        rows.push(entry(buffer.name, buffer.type === 'channel' ? buffer.topic : 'direct message', buffer.unread ? `${buffer.unread} new` : null, () => app.activate(buffer.key)));
      }
      for (const channel of known) {
        if (app.buffers.has(channel.name) || !channel.name.includes(query)) continue;
        rows.push(entry(channel.name, channel.topic, `${channel.online} online`, () => app.join(channel.name)));
      }
      const bare = query.replace(/^#/, '');
      if (/^[a-z0-9][a-z0-9_.-]{0,31}$/.test(bare) && !app.buffers.has(`#${bare}`) && !known.some((channel) => channel.name === `#${bare}`)) {
        rows.push(entry(`#${bare}`, 'Create this channel', null, () => app.join(`#${bare}`)));
      }
      if (/^[a-z_][a-z0-9_-]{1,19}$/.test(query) && !app.buffers.has(query) && !app.isSelf(query)) {
        rows.push(entry(query, 'Send a direct message', null, () => app.openDm(query)));
      }
      rows[0]?.classList.add('selected');
      fill(list, rows.length ? rows : h('p.results-empty', null, 'Nothing by that name. Channel names use letters, digits, ".", "_" and "-".'));
    }

    input.addEventListener('input', show);
    listKeys(input, list);
    show();
    app.request('list').then(({ channels }) => {
      known = channels;
      show();
    }).catch(() => {});
    return h('div.dialog-body', null, input, list);
  });
}

function search(initial = '') {
  dialog('Search', (close) => {
    const input = h('input.dialog-input', { type: 'search', placeholder: 'Search your channels and conversations', value: initial, 'aria-label': 'Search' });
    const list = h('div.results');
    let latest = 0;

    async function run() {
      const query = input.value.trim();
      if (query.length < 2) return fill(list, h('p.results-empty', null, 'Type at least two characters and press Enter.'));
      const ticket = ++latest;
      fill(list, h('p.results-empty', null, 'Searching…'));
      try {
        const { results } = await app.request('search', { query });
        if (ticket !== latest) return;
        if (!results.length) return fill(list, h('p.results-empty', null, `No messages mention "${query}".`));
        fill(
          list,
          results.map(({ target, msg }) =>
            h(
              'button.result.result-message',
              {
                type: 'button',
                on: {
                  click: () => {
                    close();
                    const key = target.toLowerCase();
                    if (!app.buffers.has(key)) return;
                    app.activate(key);
                    // The line can only be shown once the buffer's history is in.
                    setTimeout(() => reveal(msg.id), 300);
                  },
                },
              },
              h('span.result-meta', null, `${target} · ${formatDay(msg.ts)} ${formatTime(msg.ts)} · ${msg.nick}`),
              h('span.result-text', null, msg.text),
            ),
          ),
        );
      } catch (err) {
        if (ticket === latest) fill(list, h('p.results-empty', null, err.message));
      }
    }

    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        run();
      }
    });
    run();
    return h('div.dialog-body', null, input, list);
  });
}

app.on('dialog', (request) => {
  const name = typeof request === 'string' ? request : request.name;
  if (name === 'jump') jump();
  if (name === 'search') search(request.query ?? '');
});
