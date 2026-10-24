// SPDX-License-Identifier: Apache-2.0
import { watch, mkdtempSync, realpathSync, writeFileSync, rmSync, type FSWatcher } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

type Command = { id: number; type: string; path: string; recursive: boolean; probe: number };
type Probe = {
  directory: string;
  watcher?: FSWatcher;
  signal?: NodeJS.Timeout;
  participants: Map<number, number>;
  closing: boolean;
};
/** One child multiplexes every subscription in its parent. A native hang stalls
 * only this helper; the parent bounds each acknowledgement and can abandon it. */
export function startLocalWatcher() {
  const targets = new Map<number, FSWatcher>();
  let probe: Probe | undefined;
  const queued = new Map<number, Command>();
  const send = (message: object, done = () => {}) => {
    if (process.connected) process.send?.(message, done);
  };
  const failed = (id: number, error: NodeJS.ErrnoException) =>
    send({ id, type: 'degraded', code: error.code ?? 'WATCH_FAILED' });
  const probeMessages = (current: Probe, type: string) => {
    for (const [id, generation] of current.participants) send({ id, probe: generation, type });
  };
  const cleaned = (current: Probe) => {
    if (probe !== current) return;
    probe = undefined;
    try {
      rmSync(current.directory, { recursive: true, force: true });
      send({ type: 'probe-cleaned', directory: current.directory });
    } catch {
      /* Parent retains cleanup ownership if the helper cannot remove it. */
    }
    probeMessages(current, 'healthy');
    const waiting = [...queued.values()];
    queued.clear();
    for (const message of waiting) if (targets.has(message.id)) requestProbe(message);
  };
  const closeProbe = (current: Probe) => {
    current.closing = true;
    clearTimeout(current.signal);
    if (!current.watcher) return; // Initialization's IPC callback observes cancellation.
    current.watcher.once('close', () => cleaned(current));
    // Flush the event receipt before a potentially blocking native close.
    setImmediate(() => current.watcher?.close());
  };
  const initializeProbe = (current: Probe, recursive: boolean) => {
    if (current.closing) {
      cleaned(current);
      return;
    }
    try {
      current.watcher = watch(current.directory, { recursive }, (_event, name) => {
        if (name?.toString() !== 'signal' || probe !== current || current.closing) return;
        probeMessages(current, 'probe-event');
        closeProbe(current);
      });
      current.watcher.on('error', error => {
        for (const id of current.participants.keys()) failed(id, error);
      });
      probeMessages(current, 'probe-ready');
      // fs.watch returning is not a stream-readiness barrier on every OS.
      current.signal = setTimeout(() => {
        try {
          writeFileSync(join(current.directory, 'signal'), 'probe', { mode: 0o600 });
          probeMessages(current, 'probe-written');
        } catch (error) {
          for (const id of current.participants.keys()) failed(id, error as NodeJS.ErrnoException);
        }
      }, 100);
    } catch (error) {
      for (const id of current.participants.keys()) failed(id, error as NodeJS.ErrnoException);
      current.participants.clear();
      cleaned(current);
    }
  };
  const requestProbe = (message: Command) => {
    const { id } = message;
    // Closing separate probes while other signals are in flight can lose
    // FSEvents. Overlapping requests share one native stream and close.
    if (probe?.closing) {
      queued.set(id, message);
      return;
    }
    if (!probe) {
      probe = {
        directory: mkdtempSync(join(realpathSync(tmpdir()), 'forge-watch-probe-')),
        participants: new Map([[id, message.probe]]),
        closing: false,
      };
      const current = probe;
      // Parent knows cleanup ownership before native open can hang.
      send({ type: 'probe-directory', directory: current.directory }, () =>
        initializeProbe(current, message.recursive),
      );
    } else {
      probe.participants.set(id, message.probe);
      if (probe.watcher) send({ id, probe: message.probe, type: 'probe-ready' });
    }
  };
  process.on('message', (message: Command) => {
    const { id } = message;
    try {
      if (message.type === 'open') {
        const target = watch(message.path, { recursive: message.recursive }, (event, name) =>
          send({ id, type: 'event', event, name: name?.toString() ?? null }),
        );
        targets.set(id, target);
        target.on('error', error => failed(id, error));
        send({ id, type: 'opened' });
      } else if (message.type === 'close') {
        queued.delete(id);
        probe?.participants.delete(id);
        if (probe && !probe.participants.size && !probe.closing) closeProbe(probe);
        const target = targets.get(id);
        targets.delete(id);
        if (!target) send({ id, type: 'closed' });
        else {
          target.once('close', () => send({ id, type: 'closed' }));
          target.close();
        }
      } else if (message.type === 'probe') {
        requestProbe(message);
      }
    } catch (error) {
      failed(id, error as NodeJS.ErrnoException);
    }
  });
  process.once('disconnect', () => process.exit(0));
  send({ type: 'ready' });
}
if (process.argv[1] === fileURLToPath(import.meta.url)) startLocalWatcher();
