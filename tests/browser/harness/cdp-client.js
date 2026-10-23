'use strict';

const CDP_TIMEOUT_MS = 15_000;

class CdpClient {
  constructor(url) {
    this.socket = new WebSocket(url);
    this.nextId = 1;
    this.pending = new Map();
    this.events = new Map();
    this.opened = new Promise((resolve, reject) => {
      this.socket.addEventListener('open', resolve, { once: true });
      this.socket.addEventListener('error', () => reject(new Error('CDP WebSocket failed to open')), { once: true });
    });
    this.socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message));
        else pending.resolve(message.result || {});
        return;
      }
      for (const listener of this.events.get(message.method) || []) listener(message.params || {});
    });
    const rejectPending = () => {
      for (const { reject } of this.pending.values()) reject(new Error('CDP WebSocket closed'));
      this.pending.clear();
    };
    this.socket.addEventListener('close', rejectPending);
    this.socket.addEventListener('error', rejectPending);
  }

  async send(method, params = {}) {
    await this.opened;
    const id = this.nextId++;
    const result = new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP command timed out: ${method}`));
      }, CDP_TIMEOUT_MS);
      this.pending.set(id, {
        resolve(value) { clearTimeout(timeoutId); resolve(value); },
        reject(error) { clearTimeout(timeoutId); reject(error); }
      });
    });
    this.socket.send(JSON.stringify({ id, method, params }));
    return result;
  }

  once(method) {
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.events.set(method, (this.events.get(method) || []).filter((value) => value !== listener));
        reject(new Error(`CDP event timed out: ${method}`));
      }, CDP_TIMEOUT_MS);
      const listener = (params) => {
        clearTimeout(timeoutId);
        this.events.set(method, (this.events.get(method) || []).filter((value) => value !== listener));
        resolve(params);
      };
      const listeners = this.events.get(method) || [];
      listeners.push(listener);
      this.events.set(method, listeners);
    });
  }

  close() {
    this.socket.close();
  }
}

async function evaluate(client, expression) {
  const result = await client.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  }
  return result.result?.value;
}

module.exports = { CdpClient, evaluate };
