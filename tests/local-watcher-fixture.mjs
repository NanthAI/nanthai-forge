// SPDX-License-Identifier: Apache-2.0
import { EventEmitter } from 'node:events';

/** One multiplexed process fake, with independently routed subscription events. */
export class FakeWatchWorker extends EventEmitter {
  messages = [];
  subscriptions = new Map();
  unrefs = 0;
  terminations = 0;
  constructor({
    code,
    silent = false,
    hangClose = false,
    hangTerminate = false,
    startupMs = 0,
    hangStartup = false,
  } = {}) {
    super();
    Object.assign(this, { code, silent, hangClose, hangTerminate });
    if (hangStartup) return;
    if (startupMs) setTimeout(() => this.emit('message', { type: 'ready' }), startupMs);
    else queueMicrotask(() => this.emit('message', { type: 'ready' }));
  }
  postMessage(message) {
    this.messages.push(message);
    const { id, probe } = message;
    if (message.type === 'open') {
      this.subscriptions.set(id, message);
      queueMicrotask(() =>
        this.emit('message', this.code ? { id, type: 'degraded', code: this.code } : { id, type: 'opened' }),
      );
    } else if (message.type === 'probe') {
      queueMicrotask(() => {
        this.emit('message', { id, probe, type: 'probe-ready' });
        this.emit('message', { id, probe, type: 'probe-written' });
        if (!this.silent) {
          this.emit('message', { id, probe, type: 'probe-event' });
          this.emit('message', { id, probe, type: 'healthy' });
        }
      });
    } else if (message.type === 'close' && !this.hangClose) {
      this.subscriptions.delete(id);
      queueMicrotask(() => this.emit('message', { id, type: 'closed' }));
    }
  }
  event(name, event = 'change', path) {
    for (const [id, subscription] of this.subscriptions) {
      if (!path || subscription.path === path) this.emit('message', { id, type: 'event', name, event });
    }
  }
  unref() {
    this.unrefs++;
  }
  ref() {}
  terminate() {
    this.terminations++;
    this.subscriptions.clear();
    return this.hangTerminate
      ? new Promise(resolve => {
          this.exit = resolve;
        })
      : Promise.resolve(0);
  }
}
