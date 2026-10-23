// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { moduleUrl } from './convex-module.mjs';
import { fixture } from './project-exchange-fixture.mjs';
import { workSchema } from '../dist/work-types.js';
import { workDigest } from '../dist/work-metadata.js';
import { materializeWork } from '../dist/work-hosted-index.js';
const { storeReturnJson } = await import(moduleUrl('../convex/projectSourceReturnCursor.ts'));
const { readCandidateRecords, hydrateIntents, projectIntentRecords } = await import(
  moduleUrl('../convex/projectSourceReturnRecords.ts')
);

test('durable Intent pages preserve exact hashing, duplicate lookup and projected payloads including opaque fields', async () => {
  const s = fixture(),
    head = 'a'.repeat(64);
  s.tables.projectWorkGenerations.set('partition', { _id: 'partition', projectId: 'project' });
  const data = workSchema.parse({
    schema: 19,
    revision: 18,
    nativeHead: head,
    intents: [],
    lanes: [],
    views: [],
  });
  data.intents.push({
    id: randomUUID(),
    base: head,
    outcome: 'First 🙂',
    constraints: '',
    status: 'completed',
    createdAt: 'now',
    notes: Array.from({ length: 400 }, () => ({
      kind: 'comment',
      at: 'now',
      text: 'é漢字\\\"\n🙂'.repeat(100),
    })),
    lifecycle: [{ from: 'active', to: 'completed', at: 'later' }],
    external: {
      repository: 'example/project',
      number: 1,
      url: 'https://example.invalid',
      author: { id: 1, login: 'synthetic' },
      observations: [
        {
          at: 'now',
          head,
          base: head,
          headRef: 'feature',
          baseRef: 'main',
          title: 'Synthetic',
          author: { id: 1, login: 'synthetic' },
          prState: 'open',
          merged: false,
          acceptance: 'unconfirmed',
          details: '',
        },
      ],
    },
    opaque: { nested: ['🙂', { b: 2, a: 1 }] },
    creatorAccountId: 'owner',
    assigneeAccountIds: ['owner', 'peer'],
  });
  // Preserve the first Array.find match when candidate history contains duplicates.
  data.intents.push({
    ...data.intents[0],
    notes: [{ kind: 'comment', at: 'later', text: 'duplicate differs' }],
  });
  data.intents.push({
    ...data.intents[0],
    id: randomUUID(),
    base: 'b'.repeat(64),
    status: 'active',
    external: undefined,
    notes: [],
    lifecycle: [],
  });
  data.intents[1].external = {
    ...data.intents[1].external,
    observations: [
      {
        ...data.intents[1].external.observations[0],
        native: {
          base: 'c'.repeat(64),
          head: 'd'.repeat(64),
          projection: {
            state: 'e'.repeat(64),
            head,
            format: 'sha256',
            bundle: 'f'.repeat(64),
            mapping: '1'.repeat(64),
          },
        },
      },
    ],
  };
  data[1] = { numericProperty: ['🙂', null] };
  data.extension = [{ b: 2, a: 1 }, ['opaque', true]];
  const manifest = {
    schema: 1,
    kind: 'forge-native-work-backup',
    id: randomUUID(),
    head,
    revision: 18,
    files: [head, ...['b', 'c', 'd', 'e'].map(c => c.repeat(64))].map(sha256 => ({
      path: `objects/${sha256}`,
      sha256,
      size: 0,
    })),
    unavailable: [],
    coverage: 'Synthetic',
  };
  const snapshot = {
    data,
    manifest,
    backup: { transport: 'objects' },
    originalWorkDigest: 'does not substitute for parsed Work digest',
  };
  const id = await storeReturnJson(s.ctx, snapshot);
  const { candidate, records } = await readCandidateRecords(s.ctx, 'project', 'owner', 'partition', id);
  assert.equal(records.digest, workDigest(data));
  assert.equal(candidate.data.intents[0].notes.length, 0);
  assert.equal(
    candidate.data.intents[0].opaque,
    undefined,
    'opaque payload is paged, not retained in context',
  );
  const hydrated = await hydrateIntents(s.ctx, 'project', 'owner', records, new Set([data.intents[0].id]));
  assert.deepEqual(hydrated, [data.intents[0]]);
  const rows = [];
  do {
    await projectIntentRecords(s.ctx, 'project', 'owner', records, candidate.data, async batch => {
      rows.push(...batch);
    });
  } while (records.projected < records.refs.length);
  const projected = new Set([
    'intents',
    'intents:payload',
    'notes',
    'notes:payload',
    'lifecycle',
    'lifecycle:payload',
    'intentAuthorities',
    'githubRepositories',
  ]);
  const expected = materializeWork(data, manifest, [], 'objects', new Map(), true).entries.filter(row =>
    projected.has(row.collection),
  );
  const key = row => JSON.stringify([row.collection, row.key, row.position, row.value]);
  assert.deepEqual(rows.map(key).sort(), expected.map(key).sort());
  const { prepareFullReturnRows } = await import(moduleUrl('../convex/projectSourceReturnRows.ts'));
  const { storeReturnMetadata, readReturnMetadata } = await import(
    moduleUrl('../convex/projectSourceReturnMetadata.ts')
  );
  records.output = [await storeReturnMetadata(s.ctx, 'project', 'owner', 'partition', rows)];
  records.counts = {};
  for (const row of rows) records.counts[row.collection] = (records.counts[row.collection] ?? 0) + 1;
  const cursor = { snapshot: candidate, final: { projectId: 'project', owner: 'owner' }, rows: [] };
  await prepareFullReturnRows(s.ctx, cursor, 'partition', records);
  const actual = (
    await Promise.all(cursor.outputRefs.map(ref => readReturnMetadata(s.ctx, 'project', 'owner', ref)))
  ).flat();
  assert.deepEqual(
    actual.map(key).sort(),
    materializeWork(data, manifest, [], 'objects', new Map(), true).entries.map(key).sort(),
  );
  assert.equal(cursor.metadata.defaultIntentId, data.intents.at(-1).id);
});
