// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, checkpoint, preparedCheckpoint, modules } from './project-exchange-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { AgentWorkflow } from '../dist/agent-workflow.js';
import { applyHostedEvent, parseWorkBytes } from '../dist/work-metadata.js';
import { NativeSource } from '../dist/native-source.js';
import { accountBytes } from './egress-accounting.mjs';
const index = await import(moduleUrl('../convex/projectWorkIndex.ts'));
const actions = await import(moduleUrl('../convex/projectWorkIndexActions.ts'));
const review = await import(moduleUrl('../convex/projectSourceReview.ts'));

test('local backend byte budgets: push, landing, Now/Work/Code and status loop', async t => {
  const s = fixture(),
    seed = await checkpoint(t, s),
    store = seed.store;
  const initial = store.load(),
    intentId = randomUUID();
  initial.intents.push({
    id: intentId,
    base: initial.nativeHead,
    outcome: 'Synthetic history',
    constraints: '',
    status: 'active',
    createdAt: '2026-01-01T00:00:00.000Z',
    notes: Array.from({ length: 1000 }, (_, i) => ({
      kind: 'comment',
      text: `Note ${i} ${'history '.repeat(100)}`,
      at: '2026-01-01T00:00:00.000Z',
    })),
  });
  initial.revision++;
  store.save(initial);
  const first = await preparedCheckpoint(s, store);
  let backupId = await modules.projectExchangeActions.publish._handler(s.ctx, first.input);
  await modules.projectWorkActions.initialize._handler(s.ctx, {
    projectId: 'project',
    backupId,
    operationId: randomUUID(),
  });
  await actions.ensure._handler(s.ctx, { projectId: 'project' });
  const measure = accountBytes(s),
    results = [];
  const push = async (flow, change) => {
    const data = store.load(),
      revision = data.revision;
    change(data);
    data.revision++;
    store.save(data);
    // Upload preparation is ingress and excluded; publication and source return are counted.
    const next = await preparedCheckpoint(s, store);
    next.input.previous = backupId;
    results.push(
      await measure(flow, async call => {
        const candidate = await call(
          'projectExchangeActions:publish',
          modules.projectExchangeActions.publish._handler,
          next.input,
        );
        let receipt;
        do {
          receipt = await call(
            'projectSourceReturn:returnSource',
            modules.projectSourceReturn.returnSource._handler,
            {
              projectId: 'project',
              backupId: candidate,
              expectedBackupId: backupId,
              revision,
              operationId: next.input.operationId,
              continuation: true,
            },
          );
        } while (receipt.pending);
        backupId = candidate;
        // Mirror the returned hosted revision before the next synthetic local edit.
        const reconciled = parseWorkBytes(
          readFileSync(join(store.directory, `exchange-${next.input.operationId}`, 'work.json')),
        );
        applyHostedEvent(reconciled, {
          projectKey: s.tables.hostedProjects.get('project').key,
          archiveSha256: s.tables.projectBackups.get(candidate).digest,
          id: receipt.operationId,
          request: receipt.request,
          previousRevision: receipt.previousRevision,
          actor: receipt.actor,
          at: receipt.at,
          command: JSON.parse(receipt.command),
        });
        store.save(reconciled);
      }),
    );
  };
  await push('push', data =>
    data.intents[0].notes.push({ kind: 'comment', text: 'One changed note', at: '2026-01-01T00:01:00.000Z' }),
  );
  await push('landing', data => {
    const base = data.nativeHead,
      at = '2026-01-01T00:02:00.000Z';
    writeFileSync(join(store.root, 'a.ts'), 'export const a = 2;\n');
    const source = new NativeSource(store.root);
    const head = source.writeState(source.capture(store.root, true), [base], 'Synthetic landing', at);
    const laneId = randomUUID(),
      viewId = randomUUID();
    data.lanes.push({
      id: laneId,
      intentId,
      name: 'Synthetic',
      base,
      head,
      assignment: '',
      target: '',
      state: 'completed',
      checkpoints: [{ head, parent: base, message: 'Synthetic', at }],
    });
    data.views.push({
      id: viewId,
      intentId,
      base,
      head,
      inputs: [{ laneId, head }],
      status: 'clean',
      details: 'Synthetic',
      at,
    });
    data.channelMoves.push({
      id: randomUUID(),
      channel: 'main',
      viewId,
      head,
      previous: base,
      at,
      status: 'accepted',
      provenance: 'user-declared-local',
    });
    data.nativeHead = head;
  });
  const open = async call => {
    const workspace = JSON.parse(
      await call('projectWorkIndex:workspace', index.workspace._handler, { projectId: 'project' }),
    );
    for (const collection of ['intents', 'lanes', 'views', 'runs', 'channelMoves'])
      await call('projectWorkIndex:records', index.records._handler, {
        projectId: 'project',
        generationId: workspace.generationId,
        collection,
        paginationOpts: { cursor: null, numItems: 20 },
      });
    const head = store.load().nativeHead;
    await call('projectSourceReview:read', review.read._handler, {
      projectId: 'project',
      backupId,
      base: head,
      head,
      file: 'a.ts',
    });
  };
  results.push(await measure('open Now/Work/Code', open));
  results.push(await measure('reopen Now/Work/Code', open));
  results.push(
    await measure('20 local status reads', async () => {
      const workflow = new AgentWorkflow(store.root);
      for (let i = 0; i < 20; i++) await workflow.dispatch({ action: 'status' });
    }),
  );
  for (const row of results) {
    console.log('EGRESS_BYTES', JSON.stringify(row));
    assert.ok(row.responseBytes < 100_000, `${row.flow} response does not return retained Work/source`);
    const budget = row.flow === 'push' ? 30_000 : row.flow === 'landing' ? 25_000 : 1_000;
    assert.ok(row.storageBytes < budget, `${row.flow} avoids multiplying retained metadata reads`);
  }
  assert.equal(results.at(-1).responseBytes + results.at(-1).storageBytes, 0);
});
