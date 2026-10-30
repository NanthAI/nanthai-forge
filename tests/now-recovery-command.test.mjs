// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setup } from './hosted-planning-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
const commands = await import(moduleUrl('../convex/projectWorkCommand.ts'));
const records = await import(moduleUrl('../convex/projectHostedRecords.ts'));
const schema = (await import(moduleUrl('../convex/schema.ts'))).default;
const index = await import(moduleUrl('../convex/projectWorkIndex.ts'));
const at = '2026-10-14T10:00:00.000Z',
  head = 'a'.repeat(64);

async function fixture(t, scale = 0) {
  const s = await setup(t);
  for (const table of Object.keys(schema.tables)) s.tables[table] ??= new Map();
  const created = await s.send({
    action: 'intent',
    outcome: 'Restore bytes',
    constraints: '',
    base: s.preview.head,
  });
  const intentId = created.operationId;
  const notice = {
    state: 'reverted',
    auditRunId: randomUUID(),
    receiptId: randomUUID(),
    head,
    previousHead: head,
    failed: [{ file: 'tests/bytes.test.mjs' }],
    summary: 'Synthetic failed audit',
    undo: 'nforge undo',
  };
  const project = s.tables.hostedProjects.get(s.projectId);
  project.sourceAuthority = { mode: 'server', epoch: 1 };
  project.needsFix = { [intentId]: JSON.stringify(notice) };
  await records.writeHostedRecord(s.ctx, {
    projectId: s.projectId,
    actor: 'owner',
    authorityEpoch: 1,
    expectedVersion: null,
    record: {
      kind: 'intent',
      id: intentId,
      version: 0,
      at,
      outcome: 'Restore bytes',
      constraints: '',
      creatorAccountId: 'owner',
      assigneeAccountIds: [],
      base: { head, receiptId: 'main' },
      status: 'active',
      needsFix: notice,
    },
  });
  for (let i = 0; i < scale; i++)
    await records.writeHostedRecord(s.ctx, {
      projectId: s.projectId,
      actor: 'owner',
      authorityEpoch: 1,
      expectedVersion: null,
      record: {
        kind: 'intent',
        id: randomUUID(),
        version: 0,
        at,
        outcome: `Unrelated ${i}`,
        constraints: '',
        creatorAccountId: 'owner',
        assigneeAccountIds: [],
        base: { head, receiptId: 'main' },
        status: 'active',
      },
    });
  return {
    ...s,
    intentId,
    notice,
    close: {
      projectId: s.projectId,
      operationId: randomUUID(),
      command: JSON.stringify({ action: 'intent-status', intentId, status: 'abandoned' }),
    },
  };
}
const readIntent = async s =>
  JSON.parse(
    (
      await records.readHostedRecord(s.ctx, {
        projectId: s.projectId,
        actor: 'owner',
        kind: 'intent',
        key: s.intentId,
      })
    ).value,
  );

test('Now Close updates the canonical recovery Intent and Work, clears the workspace notice, and replays once', async t => {
  const s = await fixture(t, 599);
  let reads = 0,
    writes = 0;
  const originalGet = s.ctx.db.get,
    originalQuery = s.ctx.db.query;
  s.ctx.db.get = async (...args) => {
    reads++;
    return originalGet(...args);
  };
  const wrap = query =>
    new Proxy(query, {
      get(target, key) {
        const fn = target[key];
        if (typeof fn !== 'function') return fn;
        return (...args) => {
          const result = fn.apply(target, args);
          if (['unique', 'first', 'take', 'collect', 'paginate'].includes(key))
            return Promise.resolve(result).then(value => {
              reads += Math.max(
                1,
                Array.isArray(value) ? value.length : (value?.page?.length ?? (value ? 1 : 0)),
              );
              return value;
            });
          return result && typeof result === 'object' ? wrap(result) : result;
        };
      },
    });
  s.ctx.db.query = (...args) => wrap(originalQuery(...args));
  for (const name of ['insert', 'replace', 'patch', 'delete']) {
    const fn = s.ctx.db[name];
    s.ctx.db[name] = async (...args) => {
      writes++;
      return fn(...args);
    };
  }
  const started = performance.now();
  const result = await commands.command._handler(s.ctx, s.close);
  const measured = {
    closeFunctionCalls: 1,
    canonicalIntents: 600,
    documentReads: reads,
    documentWrites: writes,
    wallMs: performance.now() - started,
    peakRSS: process.resourceUsage().maxRSS,
  };
  assert.ok(reads <= 60, `Close read ${reads} documents`);
  assert.ok(writes <= 24, `Close wrote ${writes} documents`);
  const intent = await readIntent(s);
  assert.equal(intent.status, 'abandoned');
  assert.equal(intent.needsFix, undefined);
  assert.equal(intent.version, 1);
  assert.equal(s.tables.hostedProjects.get(s.projectId).needsFix, undefined);
  const workspace = JSON.parse(await index.workspace._handler(s.ctx, { projectId: s.projectId }));
  assert.equal(workspace.needsFix, undefined);
  const detail = await index.detail._handler(s.ctx, {
    projectId: s.projectId,
    collection: 'intents',
    id: s.intentId,
  });
  assert.equal(JSON.parse(detail.value).status, 'abandoned');
  assert.equal((await commands.command._handler(s.ctx, s.close))._id, result._id);
  assert.equal((await readIntent(s)).version, 1);
  t.diagnostic(JSON.stringify(measured));
});

test('replaying an old Close cannot clear a newer recovery notice; revoked access writes nothing', async t => {
  const s = await fixture(t);
  await commands.command._handler(s.ctx, s.close);
  const closed = await readIntent(s),
    newer = { ...s.notice, auditRunId: randomUUID() };
  await records.writeHostedRecord(s.ctx, {
    projectId: s.projectId,
    actor: 'owner',
    authorityEpoch: 1,
    expectedVersion: 1,
    record: { ...closed, version: 2, status: 'active', needsFix: newer },
  });
  s.tables.hostedProjects.get(s.projectId).needsFix = { [s.intentId]: JSON.stringify(newer) };
  await commands.command._handler(s.ctx, s.close);
  assert.equal((await readIntent(s)).needsFix.auditRunId, newer.auditRunId);
  s.caller('revoked');
  await assert.rejects(
    commands.command._handler(s.ctx, { ...s.close, operationId: randomUUID() }),
    error => error.data?.code === 'PROJECT_UNAVAILABLE',
  );
  assert.equal(s.tables.hostedProjects.get(s.projectId).needsFix[s.intentId], JSON.stringify(newer));
});
