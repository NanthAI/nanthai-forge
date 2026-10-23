// SPDX-License-Identifier: Apache-2.0
import { getFunctionName } from 'convex/server';

// JSON response-body estimates (including base64 for v.bytes), not provider billing.
export function responseBytes(value) {
  const encode = item => {
    if (item instanceof ArrayBuffer || ArrayBuffer.isView(item))
      return {
        $bytes: Buffer.from(
          item instanceof ArrayBuffer ? item : item.buffer,
          item.byteOffset ?? 0,
          item.byteLength,
        ).toString('base64'),
      };
    if (Array.isArray(item)) return item.map(encode);
    if (item && typeof item === 'object')
      return Object.fromEntries(
        Object.entries(item)
          .filter(([, v]) => v !== undefined)
          .map(([k, v]) => [k, encode(v)]),
      );
    return item;
  };
  return Buffer.byteLength(JSON.stringify(encode(value)) ?? 'null');
}
export function accountBytes(s) {
  let active;
  const add = (kind, name, bytes) => {
    if (!active) return;
    active[kind][name] = (active[kind][name] ?? 0) + bytes;
  };
  for (const method of ['runQuery', 'runMutation', 'runAction']) {
    const original = s.ctx[method];
    s.ctx[method] = async (ref, args) => {
      const value = await original(ref, args);
      add('internal', getFunctionName(ref), responseBytes(value));
      return value;
    };
  }
  for (const method of ['get', 'getUrl']) {
    const original = s.ctx.storage[method];
    s.ctx.storage[method] = async id => {
      const value = await original(id);
      if (value) add('storage', method, s.files.get(id)?.blob.size ?? 0);
      return value;
    };
  }
  return async (flow, run) => {
    active = { flow, functions: {}, internal: {}, storage: {} };
    const call = async (name, handler, args) => {
      const value = await handler(s.ctx, args);
      add('functions', name, responseBytes(value));
      return value;
    };
    try {
      await run(call);
      return {
        ...active,
        responseBytes: Object.values(active.functions).reduce((a, b) => a + b, 0),
        storageBytes: Object.values(active.storage).reduce((a, b) => a + b, 0),
      };
    } finally {
      active = undefined;
    }
  };
}
