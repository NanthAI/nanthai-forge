// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { lanesFixture } from './hosted-lanes-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { digest } from '../dist/hash.js';
import { checkPin } from '../dist/hosted-check.js';
import { signHostedCheckCallback } from '../dist/hosted-check-evidence.js';
export const definitions = await import(moduleUrl('../convex/projectHostedCheckDefinitions.ts'));
export const checks = await import(moduleUrl('../convex/projectHostedChecks.ts'));
export const read = await import(moduleUrl('../convex/projectHostedCheckRead.ts'));
export const internalApi = await import(moduleUrl('../convex/projectHostedCheckApi.ts'));
const records = await import(moduleUrl('../convex/projectHostedRecords.ts'));
const callbacks = await import(moduleUrl('../convex/projectHostedCheckCallbacks.ts'));
const schema = (await import(moduleUrl('../convex/schema.ts'))).default;
export const code = value => error => (error.data?.code ?? error.code) === value;
export const maxima = {};
const callbackKey = 'synthetic-check-collector-only';
export const command = {
  name: 'verify',
  executable: 'node',
  args: ['scripts/forge-check.mjs'],
  environmentLabel: 'clean',
};
export async function checksFixture(source = null) {
  const s = source?.store ?? lanesFixture();
  const traffic = { acceptedCalls: 0, acceptedArgumentBytes: 0 };
  const projectId =
    source?.projectId ??
    s.insert('hostedProjects', {
      owner: 'owner',
      visibility: 'private',
      sourceAuthority: { mode: 'server', epoch: 1 },
    });
  const auth = { projectId, actor: 'owner', authorityEpoch: 1 };
  const call = async (name, fn, args, actor = 'owner') => {
    try {
      const result = await s.call(name, fn, args, actor);
      traffic.acceptedCalls++;
      traffic.acceptedArgumentBytes += Buffer.byteLength(JSON.stringify(args));
      return result;
    } finally {
      for (const c of s.counts.filter(c => c.name === name)) {
        assert(c.ranges <= 40 && c.documents <= (name.endsWith('Page') ? 110 : 40), `${name}: bounded reads`);
        assert(c.readBytes < 256 * 1024 && c.writeBytes < 128 * 1024, `${name}: bounded metadata`);
        assert(
          !c.touched.some(table =>
            [
              'projectWorkRecords',
              'projectBackups',
              'projectWorkGenerations',
              'projectWorkEvents',
              'projectHostedChannels',
            ].includes(table),
          ),
          `${name}: no Work/history reads`,
        );
        if (name === 'checkStatus' || name === 'checkEvidence' || name === 'checkComplete')
          assert(!c.touched.includes('projectHostedCheckShards'), `${name}: no shard scan`);
        const max = (maxima[name] ??= { ranges: 0, documents: 0, readBytes: 0, writes: 0, writeBytes: 0 });
        for (const k of Object.keys(max)) max[k] = Math.max(max[k], c[k]);
      }
      // Catch undeclared fields that an ordinary indexed fake cannot catch.
      for (const [table, rows] of Object.entries(s.tables)) {
        if (!table.startsWith('projectHostedCheck')) continue;
        const fields = schema.tables[table].export().documentType.value;
        for (const row of rows.values()) {
          assert(
            Object.keys(row).every(k => ['_id', '_creationTime'].includes(k) || k in fields),
            `${table}: schema fields`,
          );
          for (const [key, field] of Object.entries(fields))
            assert(field.optional || key in row, `${table}.${key}: required`);
        }
      }
    }
  };
  const run = (name, fn, args) => call(name, { _handler: fn }, args);
  const put = value => {
    const bytes = Buffer.from(value),
      pin = { sha256: digest(bytes), size: bytes.length };
    if (![...s.tables.projectObjects.values()].some(r => r.digest === pin.sha256))
      s.insert('projectObjects', {
        projectId,
        digest: pin.sha256,
        size: pin.size,
        removed: false,
        nonce: randomUUID(),
        location: 'r2',
        r2Committed: true,
        r2Key: `synthetic/${pin.sha256}`,
      });
    return pin;
  };
  const state =
    source?.state ??
    put(
      JSON.stringify({
        schema: 1,
        kind: 'forge-source-state',
        parents: [],
        files: [],
        message: 'synthetic check source',
        at: '2026-01-01T00:00:00.000Z',
      }),
    );
  if (!source)
    s.insert('projectHostedStates', {
      projectId,
      head: state.sha256,
      size: state.size,
      input: 'a'.repeat(64),
      jobId: randomUUID(),
      output: 'b'.repeat(64),
    });
  const candidate = source?.candidate ?? {
    kind: 'candidate',
    id: randomUUID(),
    version: 0,
    at: '2026-01-01T00:00:00.000Z',
    intentId: randomUUID(),
    base: { head: state.sha256, receiptId: 'main-0' },
    inputs: put('synthetic-inputs'),
    dependencies: put('synthetic-dependencies'),
    algorithm: 'native@fixture',
    result: { status: 'clean', head: state.sha256 },
  };
  if (!source)
    await run('seedCandidate', records.writeHostedRecord, {
      ...auth,
      expectedVersion: null,
      record: candidate,
    });
  const checkId = randomUUID();
  const runner = {
    provider: 'modal',
    app: 'synthetic-app',
    function: 'check',
    runtime: 'c'.repeat(64),
    environmentFingerprint: 'd'.repeat(64),
    credential: { secretId: 'synthetic-use-reference', version: 1, operation: 'modal-check' },
  };
  const configure = (change, expected = null, operationId = randomUUID(), actor = 'owner') =>
    call(
      'checkConfigure',
      definitions.configure,
      { projectId, request: JSON.stringify({ operationId, authorityEpoch: 1, expected, change }) },
      actor,
    ).then(JSON.parse);
  let definition = await configure({ kind: 'definition', checkId, command });
  let configuration = await configure({ kind: 'runner', configuration: runner });
  const selection = overrides => ({
    operationId: randomUUID(),
    authorityEpoch: 1,
    candidateId: candidate.id,
    expectedHead: state.sha256,
    checkId,
    expectedDefinition: definition.digest,
    expectedConfiguration: configuration.digest,
    expectedEnvironment: runner.environmentFingerprint,
    ...overrides,
  });
  const enqueue = async (request, actor = 'owner') => {
    const prior = process.env.FORGE_HOSTED_CHECK_KEY_ID;
    process.env.FORGE_HOSTED_CHECK_KEY_ID = 'SYNTHETIC';
    try {
      return JSON.parse(
        await call('checkEnqueue', checks.enqueue, { projectId, request: JSON.stringify(request) }, actor),
      );
    } finally {
      if (prior === undefined) delete process.env.FORGE_HOSTED_CHECK_KEY_ID;
      else process.env.FORGE_HOSTED_CHECK_KEY_ID = prior;
    }
  };
  const status = (id, actor = 'owner') =>
    call('checkStatus', read.status, { projectId, runId: id }, actor).then(JSON.parse);
  const control = (id, command) =>
    call('checkControl', internalApi.control, {
      projectId,
      runId: id,
      command: JSON.stringify(command),
    }).then(JSON.parse);
  const prepare = async (id, shardCount = 2, overrides = {}) => {
    const owner = randomUUID(),
      claim = await control(id, { kind: 'claim', owner, leaseMs: 60000 });
    const plan = {
      head: claim.run.request.expectedHead,
      definition: claim.run.check.definition,
      runtime: runner.runtime,
      environmentFingerprint: runner.environmentFingerprint,
      lockfile: digest('synthetic-package-lock'),
      selection: put('synthetic-test-selection'),
      manifest: put('synthetic-full-check-plan'),
      shardCount,
      ...overrides,
    };
    const next = await control(id, { kind: 'prepare', owner, token: claim.run.lease.token, plan });
    return { ...next, owner, token: claim.run.lease.token };
  };
  const activate = async (id, shardCount = 2) => {
    const p = await prepare(id, shardCount);
    await control(id, { kind: 'reserve', owner: p.owner, token: p.token });
    return (
      await control(id, {
        kind: 'observe',
        owner: p.owner,
        token: p.token,
        result: { status: 'accepted', executionId: 'synthetic-provider-execution' },
      })
    ).run;
  };
  const body = (r, result, overrides = {}) => ({
    schema: 1,
    eventId: randomUUID(),
    projectId,
    runId: r.id,
    operationId: r.request.operationId,
    authorityEpoch: 1,
    fence: r.fence,
    provider: 'modal',
    executionId: r.executionId ?? 'synthetic-provider-execution',
    head: r.request.expectedHead,
    definition: r.check.definition,
    configuration: r.request.expectedConfiguration,
    environmentFingerprint: r.request.expectedEnvironment,
    runtime: r.plan.runtime,
    planDigest: r.planDigest,
    lockfile: r.plan.lockfile,
    selection: r.plan.selection,
    result,
    ...overrides,
  });
  const callback = (body, signature = signHostedCheckCallback(body, callbackKey)) =>
    run(
      body.result.kind === 'complete' ? 'checkComplete' : 'checkShard',
      (ctx, input) => callbacks.receiveHostedCheckCallback(ctx, input, () => callbackKey),
      { projectId, callback: body, signature },
    );
  const shard = (r, index, status = 'passed', overrides = {}) =>
    body(r, {
      kind: 'shard',
      shard: {
        index,
        attempt: 0,
        executionId: `synthetic-shard-${index}`,
        status,
        exitCode: status === 'passed' ? 0 : status === 'failed' ? 1 : null,
        output: null,
        ...overrides,
      },
    });
  const complete = (r, status = 'passed', overrides = {}) =>
    body(r, {
      kind: 'complete',
      status,
      exitCode: status === 'passed' ? 0 : status === 'failed' ? 1 : null,
      output: null,
      cost: { status: 'unknown' },
      ...overrides,
    });
  const pass = async r => {
    for (let i = 0; i < r.plan.shardCount; i++) await callback(shard(r, i));
    return callback(complete(r));
  };
  const evidence = r =>
    run('checkEvidence', read.requireHostedCheckEvidence, {
      projectId,
      runId: r.id,
      actor: 'owner',
      candidateId: r.request.candidateId,
      head: r.request.expectedHead,
      checkId: r.check.id,
      definition: r.check.definition,
      configuration: r.request.expectedConfiguration,
      environment: r.request.expectedEnvironment,
      authorityEpoch: 1,
    });
  const cancel = (id, actor = 'owner', operationId = randomUUID()) =>
    call(
      'checkCancel',
      checks.cancel,
      { projectId, request: JSON.stringify({ runId: id, authorityEpoch: 1, operationId }) },
      actor,
    ).then(JSON.parse);
  return {
    ...s,
    traffic,
    call,
    run,
    projectId,
    auth,
    candidate,
    state,
    runner,
    checkId,
    put,
    selection,
    enqueue,
    configure,
    definition,
    configuration,
    status,
    control,
    prepare,
    activate,
    body,
    callback,
    sign: body => signHostedCheckCallback(body, callbackKey),
    shard,
    complete,
    pass,
    evidence,
    cancel,
    checkPin,
  };
}
