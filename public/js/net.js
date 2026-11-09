/**
 * The WebSocket to the server. Requests are answered by id; everything else
 * the server sends is passed to `onEvent`.
 */
export class Connection {
  constructor({ onEvent, onClose }) {
    this.onEvent = onEvent;
    this.onClose = onClose;
    this.pending = new Map();
    this.seq = 0;
    this.ws = null;
  }

  open() {
    const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${scheme}://${location.host}/ws`);
    this.ws = ws;
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.type !== 'reply') return this.onEvent(message);
      const waiting = this.pending.get(message.id);
      if (!waiting) return;
      this.pending.delete(message.id);
      if (message.ok) waiting.resolve(message.data);
      else waiting.reject(Object.assign(new Error(message.error.message), { code: message.error.code }));
    });
    ws.addEventListener('close', () => {
      if (this.ws !== ws) return;
      this.ws = null;
      for (const waiting of this.pending.values()) {
        waiting.reject(Object.assign(new Error('The connection was lost.'), { code: 'closed' }));
      }
      this.pending.clear();
      this.onClose();
    });
    return new Promise((resolve, reject) => {
      ws.addEventListener('open', () => resolve(), { once: true });
      ws.addEventListener('error', () => reject(Object.assign(new Error('Cannot reach the server.'), { code: 'closed' })), { once: true });
    });
  }

  get connected() {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  request(op, params = {}) {
    if (!this.connected) {
      return Promise.reject(Object.assign(new Error('You are offline.'), { code: 'closed' }));
    }
    const id = ++this.seq;
    this.ws.send(JSON.stringify({ ...params, id, op }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  /** Closes without triggering `onClose`. */
  close() {
    const ws = this.ws;
    this.ws = null;
    ws?.close();
  }
}
