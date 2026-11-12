// SPDX-License-Identifier: Apache-2.0
import type { SourceOutput } from './projectConvexSourceOutput';

// A stored output can consult its primary/point/catalog binding, recipe or pack,
// retained key, State root and promotion row. Reserve 16 queries per physical
// output plus three per projected leaf. Keep half of 4,096 for the enclosing
// step, observations and publication. Ordinary 100-raw-object batches still fit.
const cost = (pin: SourceOutput) =>
  16 * (1 + (pin.physical?.length ?? 0)) + 3 * (pin.recipeClosure?.length ?? 0);

/** Continue large output batches through the existing stage mutation. Physical
 * children stage before their logical parent; every stage marks its source keys
 * and cleanup fence, so publication never exposes an unprotected dependency.
 * keepLast leaves one fitting page for the existing terminal commit. */
export function takeSourceOutputs(outputs: SourceOutput[], keepLast = false): SourceOutput[] {
  let count = 0,
    queries = 0;
  while (count < outputs.length && count < 100) {
    const pin = outputs[count]!;
    if (cost(pin) > 2048 && pin.physical?.length) {
      const { physical, ...logical } = pin;
      outputs.splice(count, 1, ...physical, logical);
      continue;
    }
    if (count && queries + cost(pin) > 2048) break;
    queries += cost(pin);
    count++;
  }
  return keepLast && count === outputs.length ? [] : outputs.splice(0, count);
}
