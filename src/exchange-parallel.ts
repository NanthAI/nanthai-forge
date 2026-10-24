// SPDX-License-Identifier: Apache-2.0
/** Internal transfer scheduling, not retained-content limits. An oversized item
 * keeps its existing capability and runs alone. Reject only after active work
 * settles, so callers can safely remove private staging on failure. */
export function mapExchange<T, R>(
  items: readonly T[],
  concurrency: number,
  run: (item: T, index: number) => Promise<R>,
  budget?: { bytes: number; size: (item: T) => number },
): Promise<R[]> {
  return new Promise((resolve, reject) => {
    const values: R[] = new Array(items.length);
    let next = 0,
      active = 0,
      bytes = 0,
      failed = false,
      failure: unknown;
    function schedule() {
      while (!failed && next < items.length && active < concurrency) {
        const index = next,
          item = items[index]!,
          cost = budget ? Math.min(budget.bytes, budget.size(item)) : 0;
        if (active && budget && bytes + cost > budget.bytes) break;
        next++;
        active++;
        bytes += cost;
        void Promise.resolve()
          .then(() => run(item, index))
          .then(
            value => {
              values[index] = value;
            },
            error => {
              if (!failed) {
                failed = true;
                failure = error;
              }
            },
          )
          .then(() => {
            active--;
            bytes -= cost;
            schedule();
          });
      }
      if (!active) {
        if (failed) reject(failure);
        else if (next === items.length) resolve(values);
      }
    }
    schedule();
  });
}

/** Share one in-flight request/byte allowance across independently traversed trees. */
export function exchangePool(concurrency: number, maxBytes: number) {
  const queue: { cost: number; start: () => void }[] = [];
  let active = 0,
    bytes = 0;
  function schedule() {
    while (queue.length && active < concurrency) {
      const next = queue[0]!;
      if (active && bytes + next.cost > maxBytes) break;
      queue.shift();
      active++;
      bytes += next.cost;
      next.start();
    }
  }
  return <T>(run: () => Promise<T>, size = 0): Promise<T> =>
    new Promise((resolve, reject) => {
      const cost = Math.min(size, maxBytes);
      queue.push({
        cost,
        start: () => {
          void Promise.resolve()
            .then(run)
            .then(resolve, reject)
            .then(() => {
              active--;
              bytes -= cost;
              schedule();
            });
        },
      });
      schedule();
    });
}
