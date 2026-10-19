// SPDX-License-Identifier: Apache-2.0
export class ForgeError extends Error {
  readonly code: string;
  constructor(
    code: string,
    message: string,
    readonly retryAt?: number,
  ) {
    super(message);
    this.name = 'ForgeError';
    this.code = code;
  }
}
export function invariant(condition: unknown, code: string, message: string): asserts condition {
  if (!condition) throw new ForgeError(code, message);
}
