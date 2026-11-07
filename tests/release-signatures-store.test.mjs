// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { moduleUrl } from './convex-module.mjs';

const store = await import(moduleUrl('../convex/projectReleaseSignatures.ts'));
const head = 'b'.repeat(64);
const signature = n => ({ keyId: String(n).repeat(16).slice(0, 16), signature: `${'A'.repeat(85)}${n}==` });

/** Minimal in-memory db: projects plus the one indexed table, counting index reads. */
function context(subject) {
  const rows = [],
    projects = new Map([
      ['project', { _id: 'project', owner: 'owner', visibility: 'private', name: 'p', key: 'p' }],
      ['public', { _id: 'public', owner: 'owner', visibility: 'public', name: 'q', key: 'q' }],
    ]);
  const reads = { index: 0 };
  const db = {
    get: async id => projects.get(id) ?? null,
    normalizeId: () => null,
    insert: async (table, value) => {
      assert.equal(table, 'projectReleaseSignatures');
      rows.push(value);
      return `row${rows.length}`;
    },
    query: table => ({
      withIndex: (name, range) => {
        const eq = {};
        const q = { eq: (field, value) => ((eq[field] = value), q) };
        range(q);
        const match = () =>
          table === 'projectReleaseSignatures'
            ? rows.filter(row => Object.entries(eq).every(([k, v]) => row[k] === v))
            : [];
        return {
          take: async n => {
            assert.equal(name, 'by_project_and_head');
            reads.index++;
            return match().slice(0, n);
          },
          unique: async () => null,
        };
      },
    }),
  };
  return {
    rows,
    reads,
    ctx: { db, auth: { getUserIdentity: async () => (subject ? { subject } : null) } },
  };
}
const put = (s, projectId, signed) =>
  store.put._handler(s.ctx, { projectId, head, ...signed }).then(JSON.parse);
const read = (s, projectId) => store.forState._handler(s.ctx, { projectId, head }).then(JSON.parse);

test('release signatures: owner-only, insert-only and bounded per State, one indexed read per call', async () => {
  const s = context('owner');
  assert.deepEqual(await put(s, 'project', signature(1)), { head, keyId: signature(1).keyId, stored: true });
  assert.equal(s.reads.index, 1);
  // An identical repeat is a no-op; another signature from the same key is refused.
  assert.equal((await put(s, 'project', signature(1))).stored, false);
  await assert.rejects(
    put(s, 'project', { ...signature(1), signature: signature(2).signature }),
    /RELEASE_SIGNATURE_EXISTS/,
  );
  for (const n of [2, 3, 4]) assert.equal((await put(s, 'project', signature(n))).stored, true);
  await assert.rejects(put(s, 'project', signature(5)), /RELEASE_SIGNATURE_LIMIT/);
  assert.equal(s.rows.length, 4);
  assert.deepEqual(await read(s, 'project'), { head, signatures: [1, 2, 3, 4].map(signature) });
  // Malformed input never reaches the table.
  await assert.rejects(put(s, 'project', { keyId: 'x', signature: 'y' }), /BAD_ARGUMENT/);
  await assert.rejects(
    store.put._handler(s.ctx, { projectId: 'project', head: 'short', ...signature(6) }),
    /BAD_ARGUMENT/,
  );
  assert.equal(s.rows.length, 4);
});

test('release signatures: others cannot write; private reads need access, public reads do not', async () => {
  const s = context('someone-else');
  await assert.rejects(put(s, 'project', signature(1)), /PROJECT_UNAVAILABLE/);
  await assert.rejects(put(s, 'public', signature(1)), /PROJECT_UNAVAILABLE/);
  assert.equal(s.rows.length, 0);
  await assert.rejects(read(s, 'project'), /PROJECT_UNAVAILABLE/);
  assert.deepEqual(await read(s, 'public'), { head, signatures: [] });
  const anonymous = context(null);
  await assert.rejects(read(anonymous, 'public'), /PROJECT_UNAVAILABLE/);
});
