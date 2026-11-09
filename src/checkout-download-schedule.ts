// SPDX-License-Identifier: Apache-2.0
import type { ContentPin } from './native-exchange.js';

/** Yields each item with its result, keeping up to `depth` later calls in flight. A failed
 * call surfaces when its own item is reached; nothing is left unobserved. */
export async function* aheadOf<T, R>(items: readonly T[], depth: number, run: (item: T) => Promise<R>) {
  const started: Promise<R>[] = [];
  for (let index = 0; index < items.length; index++) {
    while (started.length < Math.min(items.length, index + 1 + depth)) {
      const call = run(items[started.length]!);
      call.catch(() => undefined);
      started.push(call);
    }
    yield [items[index]!, await started[index]!] as const;
  }
}

/** A group holding an object this large streams it (often as chunks) and takes longest. */
export const heavyObjectBytes = 2 * 1024 * 1024;
const heavy = (group: ContentPin[]) => group.some(pin => pin.size > heavyObjectBytes);

/** Runs up to `windows` light downloads and, beside them, up to `windows` heavy ones over groups
 * as their pages are described. A group with a large object starts its slow recipe walk and
 * chunk stream in its own window as soon as its page is seen, instead of waiting behind (or
 * trailing) the small-file windows (fea47345 round 3). At most `held` pins are queued or
 * downloading (bounded rows in memory), and every started window settles before this returns
 * or throws its first failure. */
export async function runDownloadWindows(
  pages: AsyncIterable<ContentPin[][]>,
  windows: number,
  download: (group: ContentPin[]) => Promise<void>,
  held = 4000,
) {
  const queues = { heavy: [] as ContentPin[][], light: [] as ContentPin[][] },
    running = { heavy: 0, light: 0 },
    active = new Set<Promise<void>>();
  let failed = false,
    stopped = false,
    failure: unknown,
    holding = 0;
  const pump = () => {
    for (const kind of ['heavy', 'light'] as const)
      while (!failed && !stopped && running[kind] < windows && queues[kind].length) {
        const group = queues[kind].shift()!;
        running[kind]++;
        const task: Promise<void> = download(group)
          .catch(error => {
            if (!failed) [failed, failure] = [true, error];
          })
          .finally(() => {
            active.delete(task);
            running[kind]--;
            holding -= group.length;
            pump();
          });
        active.add(task);
      }
  };
  try {
    for await (const groups of pages) {
      if (failed) break;
      for (const group of groups) queues[heavy(group) ? 'heavy' : 'light'].push(group);
      holding += groups.reduce((sum, group) => sum + group.length, 0);
      pump();
      while (!failed && holding > held && active.size) await Promise.race(active);
    }
    while (!failed && active.size) await Promise.race(active);
  } finally {
    stopped = true;
    while (active.size) await Promise.all([...active]);
  }
  if (failed) throw failure;
}
