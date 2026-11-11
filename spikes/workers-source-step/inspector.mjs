// SPDX-License-Identifier: Apache-2.0
// Local CDP only. Heap checkpoints are lower bounds, never process RSS.
export async function connectInspector(url) {
  const listUrl = new URL('/json/list', url);
  listUrl.protocol = 'http:';
  const targets = await (await fetch(listUrl)).json();
  const target =
    targets.find(t => t.title === 'core:user:source-spike') ??
    targets.find(t => t.title.includes('source-spike'));
  if (!target) throw Error(`Missing local source isolate: ${targets.map(t => t.title).join(', ')}`);
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  let id = 0;
  const pending = new Map(),
    samples = [];
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      pending.set(++id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params }));
    });
  socket.addEventListener('message', async event => {
    const message = JSON.parse(event.data);
    if (message.id) {
      const p = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) p.reject(Error(JSON.stringify(message.error)));
      else p.resolve(message.result);
    }
    if (message.method === 'Debugger.paused') {
      try {
        samples.push(await send('Runtime.getHeapUsage'));
      } finally {
        await send('Debugger.resume');
      }
    }
  });
  await send('Debugger.enable');
  return { send, samples, close: () => socket.close() };
}
