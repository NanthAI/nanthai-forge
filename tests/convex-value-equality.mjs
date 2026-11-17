// SPDX-License-Identifier: Apache-2.0
import { compareValues } from 'convex/values';

/** Match Convex byte/object value equality without sorting primitive index keys on every row. */
export function equalConvexValue(a, b) {
  if (typeof a === 'number' && typeof b === 'number') return compareValues(a, b) === 0;
  if (a === b) return true;
  return (
    a !== null && b !== null && typeof a === 'object' && typeof b === 'object' && compareValues(a, b) === 0
  );
}
