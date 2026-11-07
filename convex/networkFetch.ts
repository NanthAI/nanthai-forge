// SPDX-License-Identifier: Apache-2.0
// Portable across the V8 and Node Convex runtimes: the shared transport uses
// only fetch, AbortSignal, setTimeout, performance and web streams.
import { networkFetch, networkTimeout, type NetworkOptions } from '../src/network-fetch';

/** Every external request from a Convex action goes through the shared deadline
 * transport (Issue aabe52a7). A caller's `networkTimeout(ms)` stays its total
 * budget; without one, headers get 30 s and the whole response 120 s, and a
 * transport that ignores its signal still rejects. Retries default to none: each
 * retry is a billed outbound call, and callers already own replay (retryR2Lag,
 * durable wakes, scheduled repair). Failures surface as NetworkTransportError
 * with code EXCHANGE_REQUEST_TIMEOUT or EXCHANGE_REQUEST_FAILED. */
export function convexFetch(
  input: string | URL | Request,
  init: RequestInit = {},
  options: NetworkOptions = {},
): Promise<Response> {
  return networkFetch(input, init, { retries: 0, ...options });
}

export { networkTimeout };
