// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
const FORGE_ERROR = Symbol.for('nanthai.forge.ForgeError');

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
    Object.defineProperty(this, FORGE_ERROR, { value: true, enumerable: false });
  }
  /** Recognise ForgeError across bundled CLI chunks and unbundled dist/ siblings (Item 3f76a3df). */
  static [Symbol.hasInstance](instance: unknown): boolean {
    return (
      Function.prototype[Symbol.hasInstance].call(this, instance) ||
      (this === ForgeError &&
        typeof instance === 'object' &&
        instance !== null &&
        (instance as Record<symbol, unknown>)[FORGE_ERROR] === true)
    );
  }
}
export function invariant(condition: unknown, code: string, message: string): asserts condition {
  if (!condition) throw new ForgeError(code, message);
}

/** Structured payload of a ConvexError, including across bundled and unbundled copies (Item 3f76a3df). */
export function convexErrorData(error: unknown): Record<string, unknown> | undefined {
  const raw = error as { name?: unknown; data?: unknown } | null;
  return raw?.name === 'ConvexError' && raw.data && typeof raw.data === 'object'
    ? (raw.data as Record<string, unknown>)
    : undefined;
}

const localFailure = Symbol.for('nanthai.forge.localFailure');
/** Attach the local error behind a coded failure: the CLI logs its stack, never its message in a reply. */
export function withLocalFailure<T extends ForgeError>(failure: T, error: unknown): T {
  Object.defineProperty(failure, localFailure, { value: error, enumerable: false });
  return failure;
}
export const localFailureOf = (error: unknown) =>
  error instanceof ForgeError ? (error as unknown as Record<symbol, unknown>)[localFailure] : undefined;
