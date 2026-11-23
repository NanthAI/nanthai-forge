// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { serialize, deserialize } from 'node:v8';
const clone = value => deserialize(serialize(value));
/** Scriptable transport for the future sealed provider. It runs no repository code,
 * uses synthetic records, and retains requests/replies for storage-boundary guards. */
export class SecretTestServer {
  rows = new Map();
  calls = [];
  rewrite = value => value;
  constructor(seed = 1) {
    this.seed = seed >>> 0;
  }
  bytes(length) {
    return Uint8Array.from({ length }, () => {
      this.seed ^= this.seed << 13;
      this.seed ^= this.seed >>> 17;
      this.seed ^= this.seed << 5;
      return this.seed & 255;
    });
  }
  async query(id, input = {}) {
    const reply = this.rewrite(clone(this.rows.get(id)), { id, input });
    this.calls.push(clone({ kind: 'query', id, input, reply }));
    return reply;
  }
  async mutation(id, input, expectedVersion) {
    const current = this.rows.get(id);
    const accepted = current?.version === expectedVersion;
    this.calls.push(clone({ kind: 'mutation', id, input, expectedVersion, accepted }));
    if (accepted) this.rows.set(id, clone(input));
    return { accepted };
  }
  dump() {
    return clone({ rows: [...this.rows], calls: this.calls });
  }
}

/** All negative verification cases must assert both a named error and unchanged trust.
 * The real verifier is deliberately supplied only after the encryption gate is met. */
export async function assertSecretReplyRefused(assert, { verify, server, request, pin, code }) {
  const before = clone(pin);
  const reply = await server.query('set', request);
  await assert.rejects(verify(reply, pin, request), error => error.code === code);
  assert.deepEqual(pin, before);
}
