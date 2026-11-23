// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { getFunctionName } from 'convex/server';
import { moduleUrl } from './convex-module.mjs';
import { job, state, providers } from './hosted-fixture.mjs';
import { setup as r2Setup } from './r2-harness.mjs';
import { fixture, git } from './helpers.mjs';
import { capture } from '../dist/snapshot.js';
import { analyze } from '../dist/analyze.js';
import { encodeHostedArtifact } from '../dist/hosted-artifact.js';
const hosted = await import(moduleUrl('../convex/hosted.ts'));
const lifecycle = await import(moduleUrl('../convex/lifecycle.ts'));
const downloads = await import(moduleUrl('../convex/lifecycleActions.ts'));
const store = await import(moduleUrl('../convex/deviceStore.ts'));
const access = await import(moduleUrl('../convex/access.ts'));
const refused = error => (error.data?.code ?? error.code) === 'AUTH_SCOPE_DENIED';
function device(s, projects) {
  const credentialId = randomUUID();
  s.tables.cliCredentials.set(credentialId, {
    _id: credentialId,
    _creationTime: 1,
    owner: 'owner',
    credentialId,
    scope: 'cli',
    issuedAt: 1,
    expiresAt: Date.now() + 600000,
    tokenHash: 'synthetic',
    revoked: false,
    name: 'Synthetic device',
    settings: { source: 'write', projects },
  });
  s.ctx.auth.getUserIdentity = async () => ({ subject: 'owner', forgeCredential: credentialId });
  const query = s.ctx.runQuery;
  s.ctx.runQuery = (ref, args) =>
    getFunctionName(ref) === 'deviceStore:authorize'
      ? store.authorize._handler(s.ctx, args)
      : query(ref, args);
}

test('selected-project devices receive the native out-of-scope refusal for imported source, graph, export and lifecycle', async () => {
  const s = state([job()]);
  device(s, { kind: 'project', projectId: 'selected-native-project' });
  const original = JSON.stringify(s.tables.imports.get('own'));
  for (const request of [
    () => hosted.read._handler(s.ctx, { id: 'own', endpoint: 'source?file=a.ts' }),
    () => hosted.read._handler(s.ctx, { id: 'own', endpoint: 'context?search=scope' }),
    () => downloads.snapshotInfo._handler(s.ctx, { id: 'own' }),
    () => downloads.downloadPart._handler(s.ctx, { id: 'own', offset: 0 }),
    () => lifecycle.trash._handler(s.ctx, { id: 'own' }),
    () => lifecycle.permanentlyDelete._handler(s.ctx, { id: 'own' }),
    () => downloads.restore._handler(s.ctx, { id: 'own' }),
    () => lifecycle.list._handler(s.ctx, { paginationOpts: { cursor: null, numItems: 20 } }),
    () => hosted.start._handler(s.ctx, { url: 'https://github.com/synthetic/repository' }),
  ])
    await assert.rejects(
      request(),
      error => refused(error) && /selected project only/.test(error.data?.message ?? error.message),
    );
  assert.equal(JSON.stringify(s.tables.imports.get('own')), original);
  assert.equal(s.files.size, 0);
});

test('all-project devices retain source, graph, export and lifecycle under the existing person and provider checks', async t => {
  const root = fixture(t, { 'a.ts': 'export const scopeControl = 7;\n' });
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'Synthetic source scope control']);
  const captured = capture(root),
    pack = analyze(captured);
  const { s } = await r2Setup(t);
  s.tables.imports.set('own', { ...job(), head: captured.source.gitHead });
  const blob = await encodeHostedArtifact({
    pack,
    content: Object.fromEntries(captured.content),
    documents: {},
    repository: {},
  });
  s.file('saved', blob);
  const cleanup = providers(undefined, true, captured.source.gitHead);
  t.after(cleanup);
  device(s, { kind: 'all' });
  for (const endpoint of ['files', 'source?file=a.ts', 'context?search=scopeControl'])
    assert.equal(typeof (await hosted.read._handler(s.ctx, { id: 'own', endpoint })), 'string');
  const part = await downloads.downloadPart._handler(s.ctx, { id: 'own', offset: 0 });
  assert(Buffer.from(part.data).equals(Buffer.from(await blob.arrayBuffer())));
  await lifecycle.trash._handler(s.ctx, { id: 'own' });
  assert.equal(s.tables.imports.get('own').removal, 'trash');
  await downloads.restore._handler(s.ctx, { id: 'own' });
  assert.equal(s.tables.imports.get('own').removal, undefined);
  s.tables.imports.get('own').owner = 'another-person';
  await assert.rejects(
    hosted.status._handler(s.ctx, { id: 'own' }),
    error => (error.data?.code ?? error.code) === 'GITHUB_UNAVAILABLE',
  );
});

test('the unstructured source gate uses the existing credential projection and adds no business reads at current and doubled import scale', async () => {
  for (const total of [300, 600]) {
    const s = state(Array.from({ length: total }, (_, i) => job(`import-${i}`)));
    const before = s.reads();
    const ctx = {
      ...s.ctx,
      forgeDevice: { settings: { projects: { kind: 'project', projectId: 'selected' } } },
    };
    await assert.rejects(access.currentAccess(ctx, 'import-0', 'owner'), refused);
    assert.equal(s.reads(), before);
  }
});
