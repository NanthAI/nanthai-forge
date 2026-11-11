// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import { seedTicket } from './landing-ticket-fixture.mjs';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { landingFixture } from './hosted-landing-fixture.mjs';
import { moduleUrl, moduleSource } from './convex-module.mjs';
import { queueStatusPage, rankQueueStatus } from '../dist/hosted-queue-status.js';
const observe = await import(moduleUrl('../convex/projectHostedFinishObserve.ts'));
const projections = await import(moduleUrl('../convex/projectFinishReadProjection.ts'));
const source = await import(
  `data:text/javascript;base64,${Buffer.from(moduleSource('../convex/projectHostedFinishObserve.ts').replace('finishQuery as query', 'query').replace('const ctx = finishReadReader(rawCtx);', 'const ctx = rawCtx;').replace("finishReadReader(rawCtx, 'owner')", 'rawCtx')).toString('base64')}`
);

test('selected observer reads stay bounded with 10/575/1150 queued submissions and large controller metadata', async t => {
  const costs = [];
  for (const size of [10, 575, 1150]) {
    const f = await landingFixture();
    const first = await f.enqueue();
    const template = [...f.tables.projectHostedLandingRequests.values()].find(
      r => r.submissionId === first.id,
    );
    const attempt = (await f.status(first.id)).attempt;
    const keys = [];
    f.tables.projectHostedLandingQueueStatus.clear();
    let last;
    for (let index = 0; index < size; index++) {
      const id = index ? randomUUID() : first.id;
      const operationId = index ? randomUUID() : first.operationId;
      const attemptId = index ? randomUUID() : first.attemptId;
      const state = {
        ...first,
        id,
        operationId,
        attemptId,
        firstAttemptId: attemptId,
        sequence: index + 1,
        request: { ...first.request, operationId },
      };
      if (index) {
        const row = {
          ...Object.fromEntries(Object.entries(template).filter(([key]) => !key.startsWith('_'))),
          submissionId: id,
          operationId,
          attemptId,
          sequence: index + 1,
          value: JSON.stringify(state),
          batchSelection: 'synthetic-controller-only'.repeat(1000),
        };
        const sourceId = seedTicket(f, row);
        f.insert(
          'projectFinishReadRows',
          projections.finishReadProjection(
            'projectHostedLandingRequests',
            f.tables.projectHostedLandingRequests.get(sourceId),
          ),
        );
        f.insert(
          'projectFinishReadRows',
          projections.finishPeerProjection(f.tables.projectHostedLandingRequests.get(sourceId)),
        );
        const pins = {
          projectId: f.projectId,
          submissionId: id,
          attemptId,
          number: 0,
          value: JSON.stringify({ ...attempt, id: attemptId, submissionId: id, operationId }),
        };
        const pinsId = f.insert('projectHostedLandingAttempts', pins);
        f.insert(
          'projectFinishReadRows',
          projections.finishReadProjection('projectHostedLandingAttempts', { ...pins, _id: pinsId }),
        );
      }
      keys.push({ id, sequence: index + 1, actor: 'owner', priority: 'normal', phase: 'queued' });
      last = state;
    }
    const pages = new Map();
    for (const key of rankQueueStatus(keys).order) {
      const page = queueStatusPage(key.sequence);
      if (!pages.has(page)) pages.set(page, []);
      pages.get(page).push(key);
    }
    for (const [page, entries] of pages)
      f.insert('projectHostedLandingQueueStatus', {
        projectId: f.projectId,
        page,
        value: JSON.stringify(entries),
      });
    f.patch('projectHostedLandingQueues', f.queue()._id, {
      status: {
        total: size,
        groups: size,
        horizon: keys.slice(0, 8).map(key => key.id),
        lastProgressAt: first.at,
      },
    });
    const args = { projectId: f.projectId, operationId: last.operationId, nextVersion: 0 };
    const before = JSON.parse(await f.call('scaleSourcePage', source.page, args));
    const old = f.counts.at(-1);
    const after = JSON.parse(await f.call('scaleProjectedPage', observe.page, args));
    const current = f.counts.at(-1);
    assert.deepEqual(after, before);
    assert.equal(after.queue.position, size);
    assert.equal(after.queueAheadSelection.ahead.length, 8);
    assert(current.documents <= 34, 'one directory page and at most eight peer/pin pairs');
    assert(current.readBytes <= 50000, 'bytes are bounded by the existing 128-key directory page');
    assert(current.readBytes <= old.readBytes / 2, 'large control bodies are not reread');
    costs.push({
      size,
      sourceBytes: old.readBytes,
      readBytes: current.readBytes,
      documents: current.documents,
    });
  }
  assert.equal(costs[0].documents, costs[2].documents, 'no scan of the growing queue');
  t.diagnostic(JSON.stringify(costs));
});
