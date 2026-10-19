import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync, gunzipSync } from 'node:zlib';
import { encodeHostedArtifact, decodeHostedArtifact } from '../dist/hosted-artifact.js';
import { graphIdentity, identity } from '../dist/hash.js';
import { analyze } from '../dist/analyze.js';
import { capture } from '../dist/snapshot.js';
import { fixture } from './helpers.mjs';

test('streamed graph hashing preserves schema-1 identities, order and Unicode', async t => {
  const root = fixture(t, {
    'a.ts': '\uFEFFexport const greeting = "こんにちは";\n',
    'b.ts': 'import { greeting } from "./a"; export const result = greeting;',
  });
  const { id, ...body } = analyze(capture(root));
  assert.equal(graphIdentity(body), identity(body));
  assert.equal(id, identity(body));
  const reordered = Object.fromEntries(Object.entries(body).reverse());
  assert.equal(graphIdentity(reordered), identity(reordered));
  assert.notEqual(graphIdentity(reordered), id);
  assert.notEqual(graphIdentity({ ...body, references: [] }), id);
  const artifact = { pack: { id, ...body } };
  const compressed = await encodeHostedArtifact(artifact);
  assert.equal(
    gunzipSync(Buffer.from(await compressed.arrayBuffer())).toString('utf8'),
    JSON.stringify(artifact),
  );
});

test('hosted gzip storage preserves bytes and reads existing JSON artifacts', async () => {
  const artifact = {
    content: { 'a.ts': '\uFEFFexport const greeting = "こんにちは";\n'.repeat(10000) },
    documents: JSON.parse('{"LICENSE":"Original terms","__proto__":{"notice":"Preserved data key"}}'),
  };
  const compressed = await encodeHostedArtifact(artifact);
  const plain = new Blob([JSON.stringify(artifact)], { type: 'application/json' });
  assert.equal(compressed.type, 'application/gzip');
  assert.ok(compressed.size < plain.size);
  assert.deepEqual(await decodeHostedArtifact(compressed), artifact);
  assert.deepEqual(await decodeHostedArtifact(plain), artifact);
  await assert.rejects(decodeHostedArtifact(new Blob(['corrupt'], { type: 'application/gzip' })), {
    code: 'INVALID_ARTIFACT',
  });
  await assert.rejects(decodeHostedArtifact(new Blob(['{'], { type: 'application/json' })), {
    code: 'INVALID_ARTIFACT',
  });
  await assert.rejects(decodeHostedArtifact(new Blob(['{}{}'], { type: 'application/json' })), {
    code: 'INVALID_ARTIFACT',
  });
  await assert.rejects(decodeHostedArtifact(new Blob([])), { code: 'INVALID_ARTIFACT' });
});

test('hosted storage rejects oversized compressed expansion at the approved artifact budget', async () => {
  await assert.rejects(encodeHostedArtifact({ documents: { LICENSE: 'x'.repeat(128 * 1024 * 1024) } }), {
    code: 'ARTIFACT_LIMIT',
  });
  const bytes = gzipSync(Buffer.alloc(128 * 1024 * 1024 + 1, 32));
  await assert.rejects(decodeHostedArtifact(new Blob([bytes], { type: 'application/gzip' })), {
    code: 'INVALID_ARTIFACT',
  });
});
