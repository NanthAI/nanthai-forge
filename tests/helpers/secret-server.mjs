// SPDX-License-Identifier: Apache-2.0
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
    const reply = this.rewrite(structuredClone(this.rows.get(id)), { id, input });
    this.calls.push(structuredClone({ kind: 'query', id, input, reply }));
    return reply;
  }
  async mutation(id, input, expectedVersion) {
    const current = this.rows.get(id);
    const accepted = current?.version === expectedVersion;
    this.calls.push(structuredClone({ kind: 'mutation', id, input, expectedVersion, accepted }));
    if (accepted) this.rows.set(id, structuredClone(input));
    return { accepted };
  }
  dump() {
    return structuredClone({ rows: [...this.rows], calls: this.calls });
  }
}

/** All negative verification cases must assert both a named error and unchanged trust.
 * The real verifier is deliberately supplied only after the encryption gate is met. */
export async function assertSecretReplyRefused(assert, { verify, server, request, pin, code }) {
  const before = structuredClone(pin);
  const reply = await server.query('set', request);
  await assert.rejects(verify(reply, pin, request), error => error.code === code);
  assert.deepEqual(pin, before);
}
