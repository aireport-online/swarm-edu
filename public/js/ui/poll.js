import { app } from '../app.js';
import { h } from './dom.js';

/**
 * A poll or quiz inside its message. What it shows is decided by the server
 * for each reader: no tally before you vote, no answer before it closes.
 */
export function pollCard(buffer, msg) {
  const { poll } = msg;
  const votes = `${poll.total} ${poll.total === 1 ? 'vote' : 'votes'}`;
  const state = poll.closed
    ? 'closed'
    : poll.counts
      ? null
      : poll.kind === 'quiz'
        ? 'the answer shows when your teacher closes it'
        : 'vote to see the results';
  return h(
    `div.poll${poll.closed ? '.closed' : ''}`,
    null,
    h('p.poll-question', null, msg.text),
    h(
      'div.poll-options',
      { role: 'group', 'aria-label': msg.text },
      poll.options.map((text, i) => {
        const count = poll.counts?.[i] ?? 0;
        const share = poll.counts && poll.total ? Math.round((count / poll.total) * 100) : 0;
        const right = poll.correct === i;
        return h(
          `button.poll-option${poll.mine === i ? '.mine' : ''}${right ? '.right' : ''}`,
          { type: 'button', disabled: poll.closed, dataset: { choice: i }, 'aria-pressed': String(poll.mine === i) },
          poll.counts && h('span.poll-bar', { style: { '--share': `${share}%` } }),
          h('span.poll-text', null, text),
          right && h('span.poll-note', null, 'right answer'),
          poll.mine === i && !right && h('span.poll-note', null, 'your vote'),
          poll.counts && h('span.poll-count', null, String(count)),
        );
      }),
    ),
    h(
      'p.poll-foot',
      null,
      h('span', null, [votes, state].filter(Boolean).join(' · ')),
      app.runs(buffer) && !poll.closed && h('button.poll-close', { type: 'button' }, 'Close and show the results'),
    ),
  );
}
