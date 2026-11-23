// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
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

const localFailure = Symbol('forge.localFailure');
/** Attach the local error behind a coded failure: the CLI logs its stack, never its message in a reply. */
export function withLocalFailure<T extends ForgeError>(failure: T, error: unknown): T {
  Object.defineProperty(failure, localFailure, { value: error, enumerable: false });
  return failure;
}
export const localFailureOf = (error: unknown) =>
  error instanceof ForgeError ? (error as unknown as Record<symbol, unknown>)[localFailure] : undefined;
