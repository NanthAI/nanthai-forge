// SPDX-License-Identifier: Apache-2.0
/** Portable fetch instrumentation. The Node CLI supplies its async-local reader;
 * Convex/browser consumers have no observer and no Node runtime dependency. */
export type ExchangeMeasurements = {
  requests: number;
  rpcRequests: number;
  requestBodyBytes: number;
  responseBodyBytes: number;
};
let current: (() => ExchangeMeasurements | undefined) | undefined;
export function registerExchangeObserver(reader: () => ExchangeMeasurements | undefined) {
  current = reader;
}
export function observeExchangeRequest(url: string | URL | Request, init: RequestInit) {
  const value = current?.();
  if (!value) return;
  value.requests++;
  if (/\/api\/(query|mutation|action)$/.test(String(url))) value.rpcRequests++;
  const body = init.body;
  value.requestBodyBytes +=
    typeof body === 'string'
      ? new TextEncoder().encode(body).byteLength
      : body instanceof ArrayBuffer || ArrayBuffer.isView(body)
        ? body.byteLength
        : 0;
}
export function observeExchangeResponse(bytes: number) {
  const value = current?.();
  if (value) value.responseBodyBytes += bytes;
}
