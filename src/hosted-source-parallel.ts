// SPDX-License-Identifier: Apache-2.0
import { mapExchange } from './exchange-parallel.js';

/** Independent source reads/uploads in flight per action. Each call is a network
 * round trip, so a step's wall time (and billed memory-time) follows the serial
 * chain, not CPU. Runs in both the V8 and Node source runtimes. */
export const sourceIoConcurrency = 8;

/** Run independent source I/O with bounded concurrency. Results and the reported
 * failure follow input order, so a quantum's cursor, outputs and failure code are
 * those of the one-at-a-time loop it replaces. Callers pass only work whose
 * effects are reads or immutable content-addressed writes. */
export async function mapSourceOrdered<T, R>(
  items: readonly T[],
  run: (item: T, index: number) => Promise<R>,
  concurrency = sourceIoConcurrency,
): Promise<R[]> {
  const settled = await mapExchange(items, concurrency, (item, index) =>
    run(item, index).then(
      value => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    ),
  );
  for (const result of settled) if (!result.ok) throw result.error;
  return settled.map(result => (result as { value: R }).value);
}
