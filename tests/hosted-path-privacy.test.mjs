// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { initNative } from '../dist/native-work.js';
import { WorkService } from '../dist/work.js';
import { parseWork } from '../dist/work-unified-types.js';
import { hostedPaths, hostedText } from '../dist/hosted-paths.js';
import { metadataRequest, applyHostedEvent } from '../dist/work-metadata.js';
import { mergeCompanion } from '../dist/native-companion.js';
import { moduleUrl } from './convex-module.mjs';
import { state, providers } from './hosted-fixture.mjs';
const zones = await import(moduleUrl('../convex/sourceZones.ts'));
const grants = await import(moduleUrl('../convex/agentGrants.ts'));
const saved = await import(moduleUrl('../convex/savedViews.ts'));
const interests = await import(moduleUrl('../convex/interests.ts'));
const account = await import(moduleUrl('../convex/accountActions.ts'));
const contributors = await import(moduleUrl('../convex/projectContributors.ts'));
const readers = await import(moduleUrl('../convex/projectReaders.ts'));
const actors = await import(moduleUrl('../convex/projectActorNames.ts'));
const paginationOpts = { cursor: null, numItems: 20 };
// forge-path-fixture: synthetic
const local = '/Users/synthetic/private-owner/.forge/work/lane-123';
const row = (id, values) => ({ _id: id, _creationTime: 1, ...values });

test('hosted metadata removes nested receipt paths, local links and Windows/home/workspace paths without modifying originals', () => {
  const original = {
    id: 'receipt',
    actor: 'owner',
    path: local,
    links: { local: 'http://localhost:123/owner', hosted: 'https://forge.example/project' },
    result: JSON.stringify({
      removed: [{ id: local, path: local }],
      note: `Clean ${local}; restore ~/private`,
    }),
    scope: ['src/kept.ts'],
    windows: 'C:\\Users\\synthetic\\repo',
    // forge-path-fixture: synthetic
    home: '/home/synthetic/repo',
    workspace: '.forge/work/check-123/runtime',
  };
  const before = structuredClone(original);
  const portable = hostedPaths(original);
  assert.deepEqual(original, before);
  assert.doesNotMatch(JSON.stringify(portable), /Users|synthetic|\.forge\/work|localhost/);
  assert.deepEqual(portable.scope, ['src/kept.ts']);
  assert.equal(portable.actor, 'owner');
  assert.equal(portable.links.hosted, original.links.hosted);
  assert.equal(portable.links.local, null);
  assert.equal(hostedText(hostedText(JSON.stringify(original))), hostedText(JSON.stringify(original)));
});

test('generic Work redaction changes recorded command digests and never replaces original local metadata', t => {
  const root = mkdtempSync(join(tmpdir(), 'forge-host-paths-'));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  writeFileSync(join(root, 'source.ts'), 'export const value = 1;\n');
  initNative(root);
  const service = new WorkService(root);
  const intent = service.execute(
    { action: 'intent', outcome: `Clean ${local}` },
    service.status().revision,
  ).result;
  const original = service.store.load();
  const portable = parseWork(hostedPaths(original));
  assert.equal(portable.schema, original.schema);
  const merged = mergeCompanion(portable, original, portable, true);
  assert.equal(merged.merged.intents[0].outcome, original.intents[0].outcome);
  assert.equal(merged.merged.intents[0].title, original.intents[0].title);
  const command = { action: 'note', intentId: intent.id, text: `Observed ${local}`, kind: 'comment' };
  const event = {
    id: randomUUID(),
    projectKey: randomUUID(),
    archiveSha256: 'a'.repeat(64),
    actor: 'owner',
    at: new Date().toISOString(),
    previousRevision: original.revision,
    command,
    request: metadataRequest(command),
  };
  applyHostedEvent(structuredClone(original), event);
  const redacted = hostedPaths(event);
  assert.notEqual(metadataRequest(redacted.command), redacted.request);
  assert.throws(
    () => applyHostedEvent(structuredClone(original), redacted),
    error => error.code === 'INVALID_WORK_JOURNAL',
  );
  assert.deepEqual(service.store.load(), original);
});

function cleanupFixture() {
  const f = state();
  const common = {
    owner: 'owner',
    importId: 'own',
    name: 'Retained',
    operationId: 'op',
    sourceId: 'source-pin',
    gitHead: 'git-pin',
    files: ['private/file.ts'],
  };
  f.tables.sourceZones.set('zone', row('zone', { ...common, revision: 1, enabled: true }));
  f.tables.agentGrants.set(
    'agent',
    row('agent', { ...common, tools: ['describe'], expiresAt: 9999999999999, revoked: false }),
  );
  f.tables.savedViews.set(
    'view',
    row('view', {
      ...common,
      route: {
        view: 'source',
        state: 'source-pin',
        file: 'private/file.ts',
        line: 17,
        symbol: 'private-symbol',
      },
    }),
  );
  f.tables.projectInterests.set(
    'interest',
    row('interest', {
      owner: 'owner',
      importId: 'own',
      repository: 'private/repo',
      ref: 'private-ref',
      seenHead: 'git-pin',
      starred: true,
      watching: true,
      active: true,
      revision: 1,
    }),
  );
  return f;
}
async function lists(f) {
  return [
    await zones.list._handler(f.ctx, { importId: 'own', paginationOpts }),
    await grants.list._handler(f.ctx, { paginationOpts }),
    await saved.list._handler(f.ctx, { paginationOpts }),
    await interests.list._handler(f.ctx, { paginationOpts }),
    { page: [await interests.current._handler(f.ctx, { importId: 'own' })] },
    ...(await Promise.all(
      ['agent', 'view', 'interest'].map(kind => account.inventory._handler(f.ctx, { kind, paginationOpts })),
    )),
  ];
}
test('all DOC-5 cleanup rows keep identity while revoked GitHub access hides paths, refs and locations; no stored rewrite', async t => {
  let revoked = false;
  t.after(providers(() => revoked));
  const f = cleanupFixture();
  const before = structuredClone(f.tables);
  const accessible = await lists(f);
  assert.match(JSON.stringify(accessible), /private\/file.ts/);
  revoked = true;
  for (const result of await lists(f)) {
    assert.equal(result.page.length, 1);
    assert.ok(result.page[0].id || result.page[0]._id);
    assert.doesNotMatch(
      JSON.stringify(result),
      /private\/file|private-symbol|private-ref|source-pin|git-pin/,
    );
  }
  assert.deepEqual(f.tables, before);
  await saved.remove._handler(f.ctx, { id: 'view' });
  assert.equal(f.tables.savedViews.size, 0, 'cleanup remains usable without provider access');
});

test('removed Forge grant and access changed during provider calls hide personal saved locations', async t => {
  t.after(providers());
  const f = cleanupFixture();
  f.tables.imports.get('own').owner = 'another-owner';
  const grant = row('reader', { importId: 'own', reader: 'owner' });
  f.tables.importReaders.set('reader', grant);
  assert.match(JSON.stringify(await saved.list._handler(f.ctx, { paginationOpts })), /private\/file/);
  f.tables.importReaders.clear();
  assert.doesNotMatch(JSON.stringify(await lists(f)), /private\/file|private-symbol|private-ref/);
  f.tables.importReaders.set('reader', grant);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (...args) => {
    const response = await originalFetch(...args);
    f.tables.importReaders.clear();
    return response;
  };
  assert.doesNotMatch(
    JSON.stringify(await saved.list._handler(f.ctx, { paginationOpts })),
    /private\/file|private-symbol/,
  );
});

test('former members keep server-retained identity/name and get a label; current readers and unknown imported actors do not', async () => {
  const f = state([]);
  f.tables.hostedProjects.set('p', row('p', { owner: 'owner', name: 'Project', key: 'p' }));
  f.tables.projectActorNames.set(
    'name',
    row('name', { projectId: 'p', actor: 'person', displayName: 'Alex' }),
  );
  f.tables.projectContributors.set('member', row('member', { projectId: 'p', contributor: 'person' }));
  const event = { id: 'action', actor: 'person', at: 123, summary: local };
  assert.equal((await actors.withActorName(f.ctx, 'p', event)).actorFormerMember, undefined);
  await contributors.remove._handler(f.ctx, { projectId: 'p', contributor: 'person' });
  const former = await actors.withActorName(f.ctx, 'p', event);
  assert.equal(former.actor, 'person');
  assert.equal(former.actorDisplayName, 'Alex');
  assert.equal(former.actorFormerMember, true);
  assert.equal(former.at, 123);
  assert.doesNotMatch(former.summary, /Users/);
  const summary = JSON.parse(await actors.actorSummary(f.ctx, 'p', JSON.stringify(event)));
  assert.equal(summary.actorFormerMember, true);
  f.tables.projectReaders.set('reader', row('reader', { projectId: 'p', reader: 'person' }));
  assert.equal((await actors.withActorName(f.ctx, 'p', event)).actorFormerMember, undefined);
  assert.equal((await actors.withActorName(f.ctx, 'p', { actor: 'unknown' })).actorFormerMember, undefined);
  await readers.set._handler(f.ctx, {
    projectId: 'p',
    owner: 'owner',
    reader: 'person',
    present: false,
    operationId: randomUUID(),
  });
  assert.equal((await actors.withActorName(f.ctx, 'p', event)).actorFormerMember, true);
  f.tables.projectActorNames.set(
    'unrelated',
    row('unrelated', { projectId: 'p', actor: 'unknown', displayName: 'Private' }),
  );
  const forged = { actor: 'unknown', actorDisplayName: 'Forged', actorFormerMember: true };
  assert.deepEqual(await actors.withActorName(f.ctx, 'p', forged), { actor: 'unknown' });
  assert.deepEqual(JSON.parse(await actors.actorSummary(f.ctx, 'p', JSON.stringify(forged))), {
    actor: 'unknown',
  });
  f.tables.projectActorNames.set(
    'other-project',
    row('other-project', {
      projectId: 'other',
      actor: 'unknown',
      displayName: 'Other project member',
      wasMember: true,
    }),
  );
  assert.deepEqual(await actors.withActorName(f.ctx, 'p', forged), { actor: 'unknown' });
  f.caller('stranger');
  await assert.rejects(
    actors.withActorName(f.ctx, 'p', event),
    error => error.code === 'PROJECT_UNAVAILABLE',
  );
});

test('legacy indexed payload redaction spans parts without rewriting records or changing their identities', async () => {
  const { hostedRecordValue } = await import(moduleUrl('../convex/hostedRecordValue.ts'));
  const f = state([]);
  const text = JSON.stringify({
    id: 'lane',
    actor: 'person',
    captureCoverage: {
      included: 1,
      excludedCount: 1,
      excluded: [{ path: local, reason: `Ignored ${local}` }],
    },
    links: { local: 'http://localhost:1/path', hosted: 'https://forge.example/p' },
    path: local,
  });
  const cut = text.indexOf('/Users') + 3;
  const parts = [text.slice(0, cut), text.slice(cut)];
  parts.forEach((value, position) =>
    f.tables.projectWorkRecords.set(
      `part-${position}`,
      row(`part-${position}`, {
        generationId: 'g',
        collection: 'lanes:payload',
        parent: 'lane-payload',
        key: `key-${position}`,
        position,
        value,
      }),
    ),
  );
  const before = structuredClone(f.tables.projectWorkRecords);
  const memo = new Map();
  const result = await Promise.all(
    [...before.values()].map(part => hostedRecordValue(f.ctx, 'g', part, memo)),
  );
  const portable = JSON.parse(result.join(''));
  assert.equal(portable.id, 'lane');
  assert.equal(portable.actor, 'person');
  assert.doesNotMatch(JSON.stringify(portable), /Users|synthetic|localhost/);
  assert.equal(portable.links.hosted, 'https://forge.example/p');
  assert.deepEqual(f.tables.projectWorkRecords, before);
});

test('payloads stored in many parts assemble without a nested paginated query', async () => {
  const { hostedRecordValue } = await import(moduleUrl('../convex/hostedRecordValue.ts'));
  const f = state([]);
  const parts = Array.from({ length: 250 }, (_, position) => `${position},`);
  // Insert out of order: assembly must follow position, not insertion.
  [...parts.keys()].reverse().forEach(position =>
    f.tables.projectWorkRecords.set(
      `part-${position}`,
      row(`part-${position}`, {
        generationId: 'g',
        collection: 'lanes:payload',
        parent: 'many',
        key: `key-${position}`,
        position,
        value: parts[position],
      }),
    ),
  );
  // Callers are paginated queries; Convex rejects a second paginate() in the same query.
  const query = f.ctx.db.query.bind(f.ctx.db);
  f.ctx.db.query = table => {
    const built = query(table);
    const withIndex = built.withIndex.bind(built);
    built.withIndex = (...args) => {
      const indexed = withIndex(...args);
      indexed.paginate = () => {
        throw new Error('This query function ran multiple paginated queries.');
      };
      return indexed;
    };
    return built;
  };
  const memo = new Map();
  const values = await Promise.all(
    parts.map((_, position) =>
      hostedRecordValue(
        f.ctx,
        'g',
        { collection: 'lanes:payload', parent: 'many', key: `key-${position}`, value: '' },
        memo,
      ),
    ),
  );
  assert.equal(values.join(''), parts.join(''));
});
