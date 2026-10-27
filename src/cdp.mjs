import { EventEmitter } from 'node:events';

export function loopbackEndpoint(value) {
  const url = new URL(value);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
      || !url.port || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('CDP endpoint must be a literal loopback HTTP origin with a port.');
  }
  return url.origin;
}

export class Cdp extends EventEmitter {
  #socket;
  #next = 0;
  #pending = new Map();
  constructor(socket) {
    super();
    this.#socket = socket;
    socket.addEventListener('message', event => {
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      if (message.id) {
        const pending = this.#pending.get(message.id);
        if (!pending) return;
        this.#pending.delete(message.id);
        clearTimeout(pending.timer);
        message.error ? pending.reject(new Error(`${pending.method}: ${message.error.message}`)) : pending.resolve(message.result);
      } else if (message.method) {
        this.emit(message.method, message.params, message.sessionId);
      }
    });
    socket.addEventListener('close', () => {
      for (const pending of this.#pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error('CDP connection closed.'));
      }
      this.#pending.clear();
      this.emit('disconnected');
    });
    socket.addEventListener('error', () => this.emit('transportError', new Error('CDP WebSocket error.')));
  }
  static async connect(endpoint, timeoutMs = 5000) {
    const base = loopbackEndpoint(endpoint);
    const response = await fetch(`${base}/json/version`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) throw new Error(`CDP discovery returned ${response.status}.`);
    const version = await response.json();
    const url = new URL(version.webSocketDebuggerUrl);
    if (url.protocol !== 'ws:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
        || url.port !== new URL(base).port) throw new Error('CDP discovery returned a non-local WebSocket.');
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { socket.close(); reject(new Error('CDP connect timeout.')); }, timeoutMs);
      socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('CDP connect failed.')); }, { once: true });
    });
    return new Cdp(socket);
  }
  send(method, params = {}, sessionId, timeoutMs = 10000) {
    const id = ++this.#next;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.#pending.delete(id); reject(new Error(`${method}: timeout`)); }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timer, method });
      try { this.#socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); }
      catch (error) { clearTimeout(timer); this.#pending.delete(id); reject(error); }
    });
  }
  close() { this.#socket.close(); }
}
