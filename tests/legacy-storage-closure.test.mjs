// SPDX-License-Identifier: Apache-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectBody, closeBodies, catalogDigest } from '../scripts/lib/legacy-storage-closure.mjs';
import {
  readBodyProof,
  requireBodyProof,
  withBodyCoverage,
} from '../scripts/lib/legacy-storage-reference-proof.mjs';
import { deletionPlan } from '../scripts/lib/legacy-storage-cleanup.mjs';
const hash = b => createHash('sha256').update(b).digest('hex');
const metrics = () => ({ convexBytes: 0, r2Bytes: 0, convexGets: 0, r2Gets: 0, metadataQueries: 0 });
const config = {
  R2_ACCOUNT_ID: 'synthetic',
  R2_BUCKET: 'bucket',
  R2_ACCESS_KEY_ID: 'synthetic',
  R2_SECRET_ACCESS_KEY: 'synthetic',
};
function streamed(bytes, length = 1) {
  let offset = 0;
  return new Response(
    new ReadableStream({
      pull(c) {
        if (offset >= bytes.length) c.close();
        else {
          c.enqueue(bytes.subarray(offset, offset + length));
          offset += length;
        }
      },
    }),
  );
}
test('full-digest inspection follows plain and gzip refs across single-byte stream boundaries without buffering bodies', async () => {
  const id = 'kg' + 'a'.repeat(30),
    ref = 'r2source:' + 'b'.repeat(64) + ':123';
  const raw = Buffer.from(JSON.stringify({ text: 'x'.repeat(600), id, ref }));
  for (const bytes of [raw, gzipSync(raw)]) {
    const m = metrics();
    const result = await inspectBody(
      streamed(bytes),
      { bytes: bytes.length, sha256: hash(bytes) },
      new Set([id]),
      m,
      'convex',
    );
    assert.deepEqual(result, { storageRefs: [id], durableRefs: [ref] });
    assert.equal(m.convexBytes, bytes.length);
    await assert.rejects(
      inspectBody(
        streamed(bytes),
        { bytes: bytes.length, sha256: 'f'.repeat(64) },
        new Set([id]),
        metrics(),
        'r2',
      ),
      /CLOSURE_DIGEST_MISMATCH/,
    );
  }
  const bytes = Buffer.from('plain');
  assert.deepEqual(
    await inspectBody(
      streamed(bytes),
      { bytes: bytes.length, sha256: hash(bytes) },
      new Set(),
      metrics(),
      'r2',
    ),
    { storageRefs: [], durableRefs: [] },
  );
});
test('recursive closure reuses immutable proofs, protects nested owned/retained files and binds the current root set', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'forge-closure-'));
  try {
    const first = 'kg' + 'a'.repeat(30),
      second = 'kg' + 'b'.repeat(30);
    const leaf = Buffer.from('{"done":true}'),
      section = Buffer.from(JSON.stringify({ next: second }));
    const root = Buffer.from(JSON.stringify({ section: first })),
      rootRef = `r2source:${hash(root)}:${root.length}`;
    const files = [
      {
        storageId: first,
        sha256: hash(section),
        bytes: section.length,
        references: [
          {
            storageId: first,
            table: 'projectObjects',
            field: 'storageId',
            project: 'project',
            document: 'owner',
            location: 'r2',
            committed: true,
            digest: hash(section),
            size: section.length,
            r2Key: 'v1/p/project/o/' + hash(section),
          },
        ],
        matchingCopies: [{ key: 'v1/p/project/o/' + hash(section), size: section.length }],
      },
      { storageId: second, sha256: hash(leaf), bytes: leaf.length, references: [], matchingCopies: [] },
    ];
    const audit = { files, deployment: 'dev:synthetic', coverage: { fullyPaged: true } };
    const scan = { references: [], durableReferences: [{ project: 'project', ref: rootRef }] };
    let queries = 0,
      gets = 0;
    const reader = {
      page: async source => {
        queries++;
        const ctx = {
          db: {
            system: {
              get: async id => {
                const f = files.find(f => f.storageId === id);
                return { sha256: f.sha256, size: f.bytes };
              },
            },
          },
          storage: { getUrl: async id => 'https://synthetic/' + id },
        };
        return new (Object.getPrototypeOf(async function () {}).constructor)('ctx', source)(ctx);
      },
    };
    const fetcher = async url => {
      gets++;
      return new Response(String(url).includes(first) ? section : String(url).includes(second) ? leaf : root);
    };
    const out = join(dir, 'proof.json');
    const proof = await closeBodies(audit, scan, reader, config, out, { fetcher });
    assert.equal(proof.complete, true);
    assert.equal(queries, 2);
    assert.equal(gets, 3);
    assert.deepEqual(
      proof.references.map(r => r.storageId),
      [first, second],
    );
    const read = await readBodyProof(out, audit);
    requireBodyProof(read);
    assert.equal(read.catalogDigest, catalogDigest(files));
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      throw new Error('cached body refetched');
    };
    let covered;
    try {
      covered = await withBodyCoverage(audit, scan, reader, config, out);
    } finally {
      globalThis.fetch = originalFetch;
    }
    assert.equal(queries, 2);
    assert.equal(covered.bodyCoverage.complete, true);
    const verification = {
      complete: true,
      deployment: audit.deployment,
      results: [
        {
          storageId: first,
          sha256: files[0].sha256,
          bytes: section.length,
          fullDigest: true,
          keys: [files[0].matchingCopies[0].key],
        },
      ],
    };
    assert.equal(deletionPlan(audit, verification).pins.length, 1);
    const plan = deletionPlan(audit, verification, covered);
    assert.equal(plan.pins.length, 0);
    assert.equal(plan.excluded[0].code, 'REFERENCE_REMAINS');
    const empty = await closeBodies(audit, { references: [], durableReferences: [] }, reader, config, out, {
      fetcher,
    });
    assert.notEqual(empty.rootDigest, proof.rootDigest);
    assert.deepEqual(empty.references, []);
    const changed = { ...audit, files: [{ ...files[0], bytes: section.length + 1 }, files[1]] };
    await assert.rejects(readBodyProof(out, changed), /CLEANUP_BODY_PROOF_INVALID/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test('missing durable bodies fail coverage and apply before any provider calls or pause attempt', async () => {
  const { cleanup } = await import('../scripts/legacy-storage-cleanup.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'forge-closure-missing-'));
  try {
    const audit = { files: [], deployment: 'dev:synthetic', coverage: { fullyPaged: true } },
      raw = JSON.stringify(audit);
    const proof = await closeBodies(
      audit,
      {
        references: [],
        durableReferences: [{ project: 'deleted-project', ref: 'r2source:' + 'a'.repeat(64) + ':1' }],
      },
      {},
      config,
      join(dir, 'proof.json'),
      { fetcher: async () => new Response(null, { status: 404 }) },
    );
    assert.equal(proof.complete, false);
    assert.equal(proof.failures[0].code, 'CLOSURE_BODY_MISSING');
    assert.throws(() => requireBodyProof(proof), /CLEANUP_BODY_COVERAGE_REQUIRED/);
    await writeFile(join(dir, 'audit.json'), raw);
    await writeFile(
      join(dir, 'verification.json'),
      JSON.stringify({ complete: true, deployment: audit.deployment, auditSha256: hash(raw), results: [] }),
    );
    let calls = 0;
    const io = new Proxy(
      {},
      {
        get() {
          calls++;
          throw new Error('provider called');
        },
      },
    );
    await assert.rejects(
      cleanup(
        {
          mode: 'apply',
          deployment: audit.deployment,
          audit: join(dir, 'audit.json'),
          verification: join(dir, 'verification.json'),
          bodyCoverage: join(dir, 'proof.json'),
          out: join(dir, 'run'),
          leadGo: 'synthetic go',
        },
        io,
      ),
      /CLEANUP_BODY_COVERAGE_REQUIRED/,
    );
    assert.equal(calls, 0);
    const changed = JSON.parse(await readFile(join(dir, 'proof.json')));
    changed.references.push({ storageId: 'tampered' });
    await writeFile(join(dir, 'proof.json'), JSON.stringify(changed));
    await assert.rejects(readBodyProof(join(dir, 'proof.json'), audit), /CLEANUP_BODY_PROOF_INVALID/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
