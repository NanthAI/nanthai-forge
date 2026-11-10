// SPDX-License-Identifier: Apache-2.0
export class ForgeError extends Error {
  readonly code: string;
  constructor(
    code: string,
    message: string,
    readonly retryAt?: number,
    readonly recovery?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ForgeError';
    this.code = code;
  }
}
export function invariant(condition: unknown, code: string, message: string): asserts condition {
  if (!condition) throw new ForgeError(code, message);
}
/** A versioned Work item moved past the version a write expected (flip 5, Issue 0695ab24). It names the
 * item and both versions, so a caller re-reads that one item instead of the whole project. */
export function itemChanged(item: {
  kind: string;
  id: string;
  expectedVersion: number;
  currentVersion: number;
}) {
  return new ForgeError(
    'ITEM_CHANGED',
    `The ${item.kind} ${item.id} is at version ${item.currentVersion}, not ${item.expectedVersion}. Read it again before saving; your existing work remains available.`,
    undefined,
    item,
  );
}
