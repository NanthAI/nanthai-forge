// SPDX-License-Identifier: Apache-2.0
/** Convex refuses a value that breaks its fixed shape limits (more than 1024 object fields,
 * 8192 array elements, a value or document too large, nesting too deep). The same request
 * fails the same way on every retry, so it is a deterministic refusal, never an outage
 * (Issue 0c457ae4: a runner retried one such result for 30 minutes). */
const limitMessage =
  /Object has too many fields|Array length is too long|Value is too large|nested too deeply|maximum (?:number|length|size|depth) \d/i;
export function convexValueLimit(error: unknown): boolean {
  const message = (error as { message?: unknown } | null)?.message;
  return typeof message === 'string' && limitMessage.test(message);
}
