// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { moduleUrl } from './convex-module.mjs';
import { landingFixture, api, code } from './hosted-landing-fixture.mjs';
import { agentFixture } from './hosted-agent-fixture.mjs';
import { syncFixture } from './hosted-sync-fixture.mjs';
import { saveBytes } from '../dist/hosted-save.js';
import { NativeSource } from '../dist/native-source.js';
import { buildComposePages } from '../dist/hosted-compose.js';
import { hostedQueueAhead } from '../dist/queue-ahead-hosted.js';
const startApi = await import(moduleUrl('../convex/projectHostedStart.ts'));

function phase(f, state, next) {
  const row = [...f.tables.projectHostedLandingRequests.values()].find(row => row.submissionId === state.id);
  const value = { ...JSON.parse(row.value), phase: next };
  f.patch('projectHostedLandingRequests', row._id, { phase: next, value: JSON.stringify(value) });
}

test('server status reacts to checking/terminal peers with bounded indexed reads and no scheduled work', async () => {
  const f = await landingFixture(),
    a = await f.enqueue(),
    b = await f.enqueue();
  let selected = (await f.status(b.id)).queueAheadSelection;
  assert.equal(selected.ahead[0].id, a.id);
  assert.equal(selected.ahead[0].status, 'queued');
  phase(f, a, 'checking');
  selected = (await f.status(b.id)).queueAheadSelection;
  assert.equal(selected.ahead[0].status, 'checking');
  const scheduled = f.metrics.scheduled;
  phase(f, a, 'terminal-failed');
  assert.equal((await f.status(b.id)).queueAheadSelection, null);
  assert.equal(f.metrics.scheduled, scheduled);
  await assert.rejects(
    f.call('revokedAhead', api.status, { projectId: f.projectId, submissionId: b.id }, 'outsider'),
    code('PROJECT_UNAVAILABLE'),
  );
});

test('hosted horizon is eight entries and never hydrates source or retained Work', async () => {
  const f = await landingFixture();
  for (let index = 0; index < 11; index++) await f.enqueue();
  const last = [...f.tables.projectHostedLandingRequests.values()].sort((a, b) => b.sequence - a.sequence)[0];
  const selected = (await f.status(last.submissionId)).queueAheadSelection;
  assert.equal(selected.ahead.length, 8);
  assert.equal(selected.more, true);
  const reads = f.counts.at(-1);
  assert(!reads.touched.includes('projectWorkRecords'));
  assert(!reads.touched.includes('projectObjects'));
  assert.equal(reads.writes, 0);
});

test('hosted preview uses verified bytes and native merge, caches composes, and never uploads source', async t => {
  const f = agentFixture(t),
    root = mkdtempSync(join(tmpdir(), 'forge-ahead-source-'));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const source = new NativeSource(root);
  const state = (text, parents) =>
    source.writeState(
      [{ path: 'shared.txt', mode: 'file', blob: source.put(Buffer.from(text)) }],
      parents,
      `Synthetic ${randomUUID()}`,
      '2026-01-01T00:00:00.000Z',
    );
  const main = state('base\n', []),
    a = state('ahead\n', [main]),
    mine = state('mine\n', [main]);
  const laneId = randomUUID();
  const pages = buildComposePages([
    {
      laneId,
      head: a,
      version: 0,
      sourceVersion: 0,
      lifecycleVersion: 0,
      state: { object: { sha256: a, size: source.object(a).length }, recipe: null },
    },
  ]);
  for (const file of readdirSync(source.directory))
    f.objects.set(file, readFileSync(join(source.directory, file)));
  for (const page of pages.pages) f.objects.set(page.pin.sha256, Buffer.from(saveBytes(page.value)));
  const selection = {
    main,
    mine,
    ahead: [{ id: randomUUID(), head: a, inputs: pages.manifest.root, status: 'checking' }],
    more: false,
  };
  const before = f.objects.size;
  let preview = await hostedQueueAhead(f.transport(), selection);
  assert(!existsSync(join(f.root, 'queue-ahead-objects')), 'advice never creates source files in the Lane');
  assert(
    existsSync(join(`${f.root}.forge-client`, 'queue-ahead-objects')),
    'verified advice objects stay in the private client cache',
  );
  assert.deepEqual(preview.conflicts[0].paths, ['shared.txt']);
  assert.equal(preview.conflicts[0].confidence, 'actionable');
  assert.equal(preview.conflicts[0].next.stackOn, laneId);
  assert.equal(preview.cost.composeCalls, 2);
  preview = await hostedQueueAhead(f.transport(), selection);
  assert.equal(preview.cost.composeCalls, 0);
  assert.equal(preview.cost.cacheHits, 1);
  assert.equal(f.objects.size, before);
  assert.deepEqual((await hostedQueueAhead(f.transport(), { ...selection, ahead: [] })).conflicts, []);
  f.allow(false);
  // Metadata authorization is performed by the containing status query, even on warm source caches.
  await assert.rejects(
    f.transport().query('projectHostedLanding:status', { submissionId: selection.ahead[0].id }),
  );
});

test('server start stackOn retains the queued parent pin; failed-parent sync applies only the child delta', async () => {
  const s = await syncFixture();
  const parentHead = s.state([s.baseFile, s.hidden, s.file('parent.txt', 'parent')], [s.baseline.sha256]);
  const parent = await s.lane(parentHead);
  const entryId = randomUUID();
  const started = JSON.parse(
    await s.call('stackStart', startApi.start, {
      projectId: s.projectId,
      operationId: randomUUID(),
      authorityEpoch: 1,
      expectedMain: { head: s.main.head, receiptId: s.main.receipt.id },
      stackOn: parent.laneId,
      stackEntry: entryId,
      initialHead: parent.head,
      intent: { kind: 'new', outcome: 'Stacked child' },
    }),
  );
  assert.equal(started.lane.head, parent.head);
  assert.equal(started.lane.stack.entryId, entryId);
  const child = await s.save({ ...started.lane, state: { object: parentHead, recipe: null } }, [
    s.baseFile,
    s.hidden,
    s.file('parent.txt', 'parent'),
    s.file('child.txt', 'child'),
  ]);
  // A canonical terminal request is sufficient; sync does not hydrate its source history.
  const operationId = randomUUID(),
    attemptId = randomUUID();
  const state = {
    schema: 1,
    projectId: s.projectId,
    id: entryId,
    operationId,
    actor: 'owner',
    at: '2026-01-01T00:00:00.000Z',
    sequence: 1,
    version: 1,
    firstAttemptId: attemptId,
    attemptId,
    request: {
      operationId,
      authorityEpoch: 1,
      channel: 'main',
      expectedMain: { head: s.main.head, receiptId: s.main.receipt.id },
      candidateId: randomUUID(),
      expectedHead: parent.head,
      agent: false,
      check: null,
    },
    phase: 'terminal-failed',
    observation: { state: 'terminal-failed', pendingReason: null, cause: 'check-failed' },
    error: { code: 'CHECK_FAILED', message: 'Synthetic check failure' },
  };
  s.insert('projectHostedLandingRequests', {
    projectId: s.projectId,
    channel: 'main',
    submissionId: entryId,
    operationId,
    actor: 'owner',
    sequence: 1,
    runnable: false,
    phase: state.phase,
    runId: null,
    attemptId,
    value: JSON.stringify(state),
  });
  const result = await s.execute(
    s.request('sync', {
      laneId: child.laneId,
      expected: s.pins(child),
      target: { kind: 'main', head: s.main.head, receiptId: s.main.receipt.id },
    }),
  );
  const lane = result.terminal.outcome.result.lane;
  assert.equal(lane.stack.detached, true);
  const files = JSON.parse(s.objects.get(lane.head)).files;
  assert(files.some(file => file.path === 'child.txt'));
  assert(!files.some(file => file.path === 'parent.txt'));
});
