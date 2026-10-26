import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  discoverGithubSource,
  importGithubSourceFile,
  githubBlobEndpointBytes,
} from '../dist/github-project-source.js';
import { buildObjectRecipe, readObjectRecipe, objectChunkBytes } from '../dist/object-chunks.js';
import { digest } from '../dist/hash.js';

// Synthetic provider streams exercise real hashing/chunking at the provider's
// largest supported blob without retaining an entire repository in the fixture.
for (const [name, count, size] of [
  ['large files', 4, githubBlobEndpointBytes],
  ['small files', 1600, 256 * 1024],
]) {
  test(`400 MiB ${name} acquisition retains exact hashes with bounded physical objects`, async t => {
    const chunk = Buffer.alloc(64 * 1024, 0x5a),
      h = createHash('sha1').update(`blob ${size}\0`);
    for (let offset = 0; offset < size; offset += chunk.length)
      h.update(chunk.subarray(0, Math.min(chunk.length, size - offset)));
    const sha = h.digest('hex'),
      treeSha = 'b'.repeat(40);
    let fetched = 0,
      stored = 0,
      maxPhysical = 0;
    const physical = new Set();
    const request = async url => {
      if (new URL(url).pathname.includes('/git/trees/'))
        return Response.json({
          sha: treeSha,
          truncated: false,
          tree: Array.from({ length: count }, (_, i) => ({
            path: `file-${i}.bin`,
            sha,
            type: 'blob',
            mode: '100644',
            size,
          })),
        });
      let offset = 0;
      return new Response(
        new ReadableStream({
          pull(controller) {
            if (offset === size) {
              controller.close();
              return;
            }
            const value = chunk.subarray(0, Math.min(chunk.length, size - offset));
            offset += value.length;
            controller.enqueue(value);
          },
        }),
      );
    };
    let cursor = {
      schema: 1,
      repository: 'fixture/repo',
      commit: 'a'.repeat(40),
      pending: [{ path: '', sha: treeSha }],
      files: [],
      completed: 0,
      bytes: 0,
      totalBytes: 0,
    };
    cursor = await discoverGithubSource(cursor, undefined, request);
    assert.equal(cursor.totalBytes, 400 * 1024 * 1024);
    while (cursor.completed < count) {
      const next = await importGithubSourceFile(
        cursor,
        async bytes => {
          fetched += bytes.length;
          if (bytes.length <= objectChunkBytes) {
            physical.add(digest(bytes));
            maxPhysical = Math.max(maxPhysical, bytes.length);
            stored += bytes.length;
            return;
          }
          const built = buildObjectRecipe(bytes);
          for (const [hash, value] of built.objects) {
            assert.equal(digest(value), hash);
            assert.ok(value.length <= objectChunkBytes);
            physical.add(hash);
            maxPhysical = Math.max(maxPhysical, value.length);
          }
          for await (const value of readObjectRecipe(built.recipe, async pin =>
            built.objects.get(pin.sha256),
          ))
            stored += value.length;
        },
        undefined,
        request,
      );
      cursor = next.cursor;
    }
    assert.equal(cursor.completed, count);
    assert.equal(cursor.bytes, 400 * 1024 * 1024);
    assert.equal(stored, fetched);
    assert.ok(maxPhysical <= 1024 * 1024);
    t.diagnostic(
      JSON.stringify({
        logicalBytes: fetched,
        largestFile: size,
        files: count,
        maxPhysicalBytes: maxPhysical,
        uniquePhysicalObjects: physical.size,
        liveProvider: false,
      }),
    );
  });
}
