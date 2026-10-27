// SPDX-License-Identifier: Apache-2.0
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { indexRepository } from '../dist/index.js';
import { RepositoryQuery } from '../dist/query.js';

const root = resolve(process.argv[2] ?? '');
assert.ok(process.argv[2], 'Pass an authorized materialized Edge source worktree; see docs/agents.md');
const manifest = JSON.parse(
  readFileSync(new URL('../evals/edge-runtime-host.json', import.meta.url), 'utf8'),
);
for (const file of manifest.files) {
  const bytes = readFileSync(resolve(root, file.path));
  const blob = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
  assert.equal(blob, file.sha, `Source differs from pinned upstream blob: ${file.path}`);
}
const first = indexRepository(root);
const second = indexRepository(root);
assert.equal(first.pack.id, second.pack.id, 'Repeated indexing should produce identical artifacts');
const pack = second.pack;
const texts = new Map(pack.source.files.map(f => [f.path, readFileSync(resolve(root, f.path), 'utf8')]));
for (const node of pack.nodes) {
  const text = texts.get(node.locator.file);
  const span = text.slice(node.locator.start.offset, node.locator.end.offset);
  assert.ok(span === node.name || span.slice(1, -1) === node.name, `Wrong symbol locator: ${node.id}`);
  const sourceDigest = createHash('sha256')
    .update(readFileSync(resolve(root, node.locator.file)))
    .digest('hex');
  assert.equal(node.locator.digest, sourceDigest);
}
const query = new RepositoryQuery(root);
const registry = query.inspect('LocalAdapterRegistry');
assert.equal(registry.total, 1);
assert.equal(registry.results[0].locator.file, 'runtime-host/src/adapter_registry.ts');
const imports = query.imports('runtime-host/src/adapter_registry.ts', 100);
assert.ok(imports.results.some(e => e.target === 'runtime-host/src/codex_app_server_operator.ts'));
const operator = query.inspect('CodexAppServerOperator');
assert.equal(operator.total, 1);
assert.ok(
  query
    .references(operator.results[0].id, 100)
    .results.some(r => r.locator.file === 'runtime-host/src/adapter_registry.ts'),
);
assert.equal(query.status().freshness, 'current');
console.log(
  JSON.stringify(
    {
      upstreamCommit: manifest.commit,
      scope: manifest.scope,
      materializedGitHead: pack.source.gitHead,
      sourceId: pack.source.id,
      analysisId: pack.id,
      pinnedBlobsVerified: manifest.files.length,
      indexedFiles: pack.source.files.length,
      symbols: pack.nodes.length,
      imports: pack.imports.length,
      references: pack.references.length,
      syntaxIssues: pack.issues.length,
      artifactBytes: statSync(resolve(root, '.forge/index.json')).size,
      sourceBytes: pack.source.files.reduce((n, f) => n + f.bytes, 0),
      firstIndexMs: first.elapsedMs,
      repeatIndexMs: second.elapsedMs,
      coverage: pack.analysis.coverage,
      checks: [
        'pinned blob identity',
        'repeat artifact identity',
        'all declaration source spans/digests',
        'registry declaration',
        'relative operator import',
        'cross-file operator references',
        'fresh query',
      ],
      limitations: [
        'A pinned runtime-host source projection, not the full Edge checkout.',
        'Both indexes rebuild; repeat timing is not an incremental cache benchmark.',
        'No model calls, MCP integration or authenticated local Runtime Host verification.',
      ],
    },
    null,
    2,
  ),
);
