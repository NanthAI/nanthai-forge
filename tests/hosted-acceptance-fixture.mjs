// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { landingFixture, control, store as landingStore, pins } from './hosted-landing-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { buildComposePages } from '../dist/hosted-compose.js';
import { canonicalPayload } from '../dist/hosted-source-operation.js';
export const api = await import(moduleUrl('../convex/projectHostedAcceptance.ts'));
export const publish = await import(moduleUrl('../convex/projectHostedAcceptancePublish.ts'));
export const completion = await import(moduleUrl('../convex/projectHostedAcceptanceCompletion.ts'));
export const store = await import(moduleUrl('../convex/projectHostedAcceptanceStore.ts'));
export const records = await import(moduleUrl('../convex/projectHostedRecords.ts'));
const schema = (await import(moduleUrl('../convex/schema.ts'))).default;
export { control, landingStore, pins };
export const maxima = {};
export async function acceptanceFixture(source = null) {
  const f = await landingFixture(source);
  await f.bindRepository(f.projectId, { repository: 'synthetic/checks', repoId: 43 });
  const transaction = async (name, fn, args, actor = 'owner') => {
    try {
      return await f.transaction(name, fn, args, actor);
    } finally {
      for (const c of f.counts.filter(c => c.name === name)) {
        const final = name === 'acceptancePublish' || name === 'acceptanceAccept';
        assert(
          c.ranges <= (final ? 100 : 1600) && c.documents <= (final ? 100 : 1600),
          `${name}: bounded reads`,
        );
        assert(c.readBytes < 2 * 1024 * 1024 && c.writeBytes < 512 * 1024, `${name}: bounded metadata`);
        assert(
          !c.touched.some(t =>
            [
              'projectWorkRecords',
              'projectBackups',
              'projectWorkGenerations',
              'projectWorkEvents',
              'projectHostedCheckShards',
            ].includes(t),
          ),
        );
        if (final) assert(!c.touched.includes('projectHostedAcceptancePages'), 'no final fan-in reads');
        const max = (maxima[name] ??= { ranges: 0, documents: 0, readBytes: 0, writes: 0, writeBytes: 0 });
        for (const k of Object.keys(max)) max[k] = Math.max(max[k], c[k]);
      }
      for (const [table, rows] of Object.entries(f.tables)) {
        if (!table.startsWith('projectHostedAcceptance')) continue;
        const fields = schema.tables[table].export().documentType.value;
        for (const row of rows.values()) {
          assert(
            Object.keys(row).every(k => ['_id', '_creationTime'].includes(k) || k in fields),
            `${table}: fields`,
          );
          for (const [key, field] of Object.entries(fields))
            assert(field.optional || key in row, `${table}.${key}`);
        }
      }
    }
  };
  const run = (name, fn, args) => transaction(name, { _handler: fn }, args);
  const lane = async (overrides = {}) => {
    const record = {
      kind: 'lane',
      id: randomUUID(),
      version: 0,
      intentId: randomUUID(),
      actor: 'owner',
      base: { head: f.main.head, receiptId: f.main.receipt.id },
      head: f.state.sha256,
      sourceVersion: 0,
      lifecycleVersion: 0,
      state: 'active',
      authorityEpoch: 1,
      at: '2026-01-01T00:00:00.000Z',
      ...overrides,
    };
    await run('acceptanceSeed', records.writeHostedRecord, { ...f.auth, expectedVersion: null, record });
    return {
      laneId: record.id,
      head: record.head,
      version: record.version,
      sourceVersion: record.sourceVersion,
      lifecycleVersion: record.lifecycleVersion,
      state: { object: { sha256: record.head, size: f.state.size }, recipe: null },
    };
  };
  const makeCandidate = async (lanes = [], dependencies = [], overrides = {}) => {
    const inputs = buildComposePages(lanes),
      deps = buildComposePages(dependencies);
    for (const page of [...inputs.pages, ...deps.pages]) f.put(canonicalPayload(page.value));
    const candidate = await f.candidate({
      inputs: inputs.manifest.root,
      dependencies: deps.manifest.root,
      ...overrides,
    });
    return { candidate, pages: { inputs: inputs.pages, dependencies: deps.pages } };
  };
  const select = s => ({ projectId: f.projectId, submissionId: s.id, attemptId: s.attemptId });
  const stage = async (s, pages) => {
    const input = select(s);
    await transaction('acceptancePrepare', api.prepare, input);
    for (const kind of ['inputs', 'dependencies'])
      for (const [index, page] of pages[kind].entries())
        await transaction('acceptanceStage', api.stage, {
          ...input,
          kind,
          index,
          page: JSON.stringify(page.value),
        });
  };
  const ready = async (item = null, request = {}) => {
    item ??= await makeCandidate();
    const r = f.request({
      candidateId: item.candidate.id,
      expectedHead: item.candidate.result.head,
      agent: false,
      ...request,
    });
    const s = await f.enqueue(r);
    await f.drain();
    await stage(s, item.pages);
    return { request: r, state: (await f.status(s.id)).request, item };
  };
  const claim = s =>
    run('acceptanceClaim', (ctx, args) => control.claimReadyLanding(ctx, args, Date.now()), {
      ...select(s),
      channel: 'main',
      owner: randomUUID(),
    });
  const accept = (s, actor = 'owner') =>
    transaction('acceptanceAccept', api.accept, select(s), actor).then(JSON.parse);
  const commit = c => run('acceptancePublish', publish.publishAcceptance, c);
  const readLane = id =>
    run('acceptanceLaneRead', records.readHostedRecord, { ...f.auth, kind: 'lane', key: id }).then(r =>
      JSON.parse(r.value),
    );
  const changeLane = async (id, change) => {
    const previous = await readLane(id);
    await run('acceptanceLaneWrite', records.writeHostedRecord, {
      ...f.auth,
      expectedVersion: previous.version,
      record: { ...previous, ...change, version: previous.version + 1 },
    });
    return readLane(id);
  };
  const materialize = receiptId =>
    run('acceptanceComplete', completion.completeAcceptedHeads, { projectId: f.projectId, receiptId });
  const main = () => JSON.parse(f.tables.projectHostedChannels.get(f.mainId).selection);
  return {
    ...f,
    transaction,
    runAcceptance: run,
    lane,
    makeCandidate,
    select,
    stageAcceptance: stage,
    ready,
    claimAcceptance: claim,
    accept,
    commit,
    readLane,
    changeLane,
    materialize,
    currentMain: main,
  };
}
