// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { batchesFixture, states, synthetic } from './hosted-landing-batches-fixture.mjs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { initialSourceStep } from '../dist/hosted-source-step.js';
import { buildComposePages } from '../dist/hosted-compose.js';
import { saveBytes } from '../dist/hosted-save.js';
import { digest } from '../dist/hash.js';
const prior = Object.fromEntries(Object.keys(synthetic).map(k => [k, process.env[k]]));
test.before(() => Object.assign(process.env, synthetic));
test.after(() => {
  for (const [k, v] of Object.entries(prior)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

test('600 Intents and 575 retained receipts do not change bounded four-member landing costs', async t => {
  const f = await batchesFixture(t);
  const template = [...f.tables.projectHostedRecords.values()].find(r => r.kind === 'intent');
  for (let i = 0; i < 600; i++) {
    const key = randomUUID();
    const id = f.insert('projectHostedRecords', {
      ...template,
      _id: undefined,
      _creationTime: undefined,
      key,
    });
    f.insert('projectHostedRecordHeads', {
      projectId: f.projectId,
      kind: 'intent',
      key,
      version: 0,
      parent: 'owner',
      status: 'active',
      recordId: id,
    });
  }
  for (let i = 0; i < 575; i++)
    f.insert('projectHostedAcceptances', {
      projectId: f.projectId,
      receiptId: randomUUID(),
      submissionId: randomUUID(),
      attemptId: randomUUID(),
      sequence: i + 100,
      value: '{"synthetic":"unrelated history must not be read"}',
    });
  // Older queued members of in-flight batches must not hide this new burst.
  // Their bodies are intentionally unreadable: the eligible index excludes them.
  for (let i = 0; i < 575; i++)
    f.insert('projectHostedLandingRequests', {
      projectId: f.projectId,
      channel: 'main',
      submissionId: randomUUID(),
      operationId: randomUUID(),
      actor: 'owner',
      sequence: i - 600,
      runnable: false,
      phase: 'queued',
      batchable: false,
      runId: null,
      attemptId: randomUUID(),
      value: '{"unrelated":"batched history must not be read"}',
    });
  const admissions = f.counts.filter(c => c.name === 'finishEnqueue');
  const before = f.counts.length,
    start = performance.now();
  await f.drain();
  await f.passChecks();
  await f.drain();
  const counts = f.counts.slice(before),
    costs = {
      transactions: counts.length,
      documentsRead: counts.reduce((sum, c) => sum + c.documents, 0),
      documentsWritten: counts.reduce((sum, c) => sum + c.writes, 0),
      maxReadBytes: Math.max(...counts.map(c => c.readBytes)),
      maxWriteBytes: Math.max(...counts.map(c => c.writeBytes)),
      wallMs: performance.now() - start,
    };
  assert(f.entries.every(entry => states(f).find(s => s.id === entry.state.id)?.phase === 'landed'));
  assert.equal(f.runs().length, 1);
  assert(costs.transactions < 150, JSON.stringify(costs));
  assert(costs.documentsRead < 4000, JSON.stringify(costs));
  assert(costs.documentsWritten < 1300, JSON.stringify(costs));
  assert.equal(f.pending().length, 0, 'zero idle work');
  const solo = await batchesFixture(t, { count: 1 });
  const soloBefore = solo.counts.length;
  await solo.drain();
  await solo.passChecks();
  await solo.drain();
  const soloCounts = solo.counts.slice(soloBefore);
  const soloCosts = {
    transactions: soloCounts.length,
    documentsRead: soloCounts.reduce((sum, c) => sum + c.documents, 0),
    documentsWritten: soloCounts.reduce((sum, c) => sum + c.writes, 0),
  };
  t.diagnostic(
    JSON.stringify({
      members: 4,
      intents: 600,
      retainedReceipts: 575,
      ...costs,
      perBatchedLandingCalls: costs.transactions / 4,
      includingAdmission: {
        calls: costs.transactions + admissions.length,
        reads: costs.documentsRead + admissions.reduce((sum, c) => sum + c.documents, 0),
        writes: costs.documentsWritten + admissions.reduce((sum, c) => sum + c.writes, 0),
      },
      solo: soloCosts,
      fourSoloCalls: soloCosts.transactions * 4,
      soloCallsIncludingAdmission:
        soloCosts.transactions + solo.counts.filter(c => c.name === 'finishEnqueue').length,
    }),
  );
});

test('eight-member stacked compose on a 3k-file fixture has bounded action memory and metadata windows', async t => {
  const objects = new Map(),
    metrics = [];
  const put = value => {
    const bytes = Buffer.from(value),
      pin = { sha256: digest(bytes), size: bytes.length };
    objects.set(pin.sha256, bytes);
    return pin;
  };
  const json = value => put(saveBytes(value)),
    at = '2026-10-29T13:18:00.000Z';
  const file = (path, bytes) => ({ path, mode: 'file', blob: put(bytes).sha256 });
  const files = Array.from({ length: 3000 }, (_, i) =>
    file(`src/${String(i).padStart(5, '0')}`, `file ${i}`),
  );
  const state = (files, parents = []) =>
    json({ schema: 1, kind: 'forge-source-state', files, parents, message: 'fixture', at });
  const base = state(files),
    members = Array.from({ length: 8 }, (_, i) => {
      const head = state([...files, file(`member-${i}`, `member ${i}`)], [base.sha256]);
      return { candidateId: randomUUID(), head: head.sha256, state: { object: head, recipe: null } };
    });
  const inputs = buildComposePages([]),
    dependencies = buildComposePages(members);
  for (const p of [...inputs.pages, ...dependencies.pages]) json(p.value);
  const input = json({
    schema: 1,
    kind: 'forge-hosted-compose-input',
    base: { head: base.sha256, receiptId: 'main' },
    main: { object: base, recipe: null },
    inputs: inputs.manifest,
    dependencies: dependencies.manifest,
    batch: { members: members.map(m => m.candidateId) },
    algorithm: 'forge-native-compose-v1',
    message: 'stack',
    at,
  });
  let windows = 0,
    documents = 0,
    cursor = initialSourceStep(input);
  const step = async cursor => {
    const child = spawn(
      process.execPath,
      [fileURLToPath(new URL('./hosted-landing-batches-source-child.mjs', import.meta.url))],
      { env: { PATH: '/usr/local/bin:/usr/bin:/bin' }, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    const out = [],
      errors = [];
    child.stdout.on('data', b => out.push(b));
    child.stderr.on('data', b => errors.push(b));
    const ended = new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('exit', code => (code === 0 ? resolve() : reject(Error(Buffer.concat(errors).toString()))));
    });
    child.stdin.end(
      JSON.stringify({ cursor, entries: [...objects].map(([id, b]) => [id, b.toString('base64')]) }),
    );
    await ended;
    const response = JSON.parse(Buffer.concat(out).toString());
    for (const [id, b] of response.uploads) objects.set(id, Buffer.from(b, 'base64'));
    windows += response.windows;
    documents += response.documents;
    return response.result;
  };
  const started = performance.now();
  while (cursor.phase !== 'done') {
    assert(metrics.length < 32, 'finite source continuation budget');
    const before = structuredClone(cursor),
      result = await step(cursor);
    assert.deepEqual(cursor, before, 'replay input stays immutable');
    cursor = result.cursor;
    metrics.push(result.metrics);
  }
  const result = JSON.parse(objects.get(cursor.output.sha256));
  assert.equal(result.result.state.sha256, cursor.head);
  assert.deepEqual(result.dropped, []);
  assert.equal(JSON.parse(objects.get(cursor.head)).files.length, 3008);
  const measured = {
    members: 8,
    files: 3000,
    actions: metrics.length,
    metadataWindows: windows,
    documents,
    peakRssBytes: Math.max(...metrics.map(m => m.maxRssBytes)),
    maxActionBytes: Math.max(...metrics.map(m => m.bytes)),
    wallMs: performance.now() - started,
  };
  assert(measured.peakRssBytes < 400 * 1024 * 1024, JSON.stringify(measured));
  assert(measured.metadataWindows < 120 && measured.documents < 800, JSON.stringify(measured));
  t.diagnostic(JSON.stringify(measured));
});
