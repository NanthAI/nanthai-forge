// SPDX-License-Identifier: Apache-2.0
import { ZodError } from 'zod';
import { ForgeError } from './errors.js';
/** Decode only already-acquired, hash-verified metadata here. Never put an
 * asynchronous byte/RPC read inside a deterministic validation boundary. */
export function sourceValidation<T>(code: string, parse: () => T): T {
  try {
    return parse();
  } catch (error) {
    if (!(error instanceof SyntaxError || error instanceof ZodError)) throw error;
    throw new ForgeError(code, 'Source metadata encoding is invalid.');
  }
}
