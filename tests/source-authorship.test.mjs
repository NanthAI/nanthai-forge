// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentAuthorship, recordTurnWork } from '../dist/agent-turn-work.js';
import { agentSlug } from '../dist/agent-slug-session.js';
import { agentFixture } from './hosted-agent-fixture.mjs';

function session(t) {
  const prior = process.env.XDG_STATE_HOME;
  const directory = mkdtempSync(join(tmpdir(), 'forge-authorship-'));
  process.env.XDG_STATE_HOME = directory;
  t.after(() => {
    if (prior === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = prior;
    rmSync(directory, { recursive: true, force: true });
  });
  const key = `fixture-${randomUUID()}`;
  return { env: { FORGE_AGENT_SESSION: key, CODEX_THREAD_ID: key }, key, run: agentSlug(key), directory };
}

test('a session declares model once and saves inherit it through Forge work-ledger updates', t => {
  const { env, key, run } = session(t);
  const first = agentAuthorship({ model: 'model-one', required: true, run }, env);
  assert.deepEqual(first, { authorship: { kind: 'agent' }, agentClient: 'codex:model-one', agentRun: run });
  recordTurnWork({ id: randomUUID(), kind: 'check', root: '/synthetic', input: {}, pid: null }, key);
  assert.deepEqual(agentAuthorship({ run }, env), first);
  assert.equal(agentAuthorship({ run, model: 'model-two' }, env).agentClient, 'codex:model-two');
  assert.equal(agentAuthorship({ run }, env).agentClient, 'codex:model-two');
  assert.equal(first.agentClient, 'codex:model-one', 'previous save labels stay immutable');
});

test(
  'a read-only state folder does not block the model declared on start or save',
  { skip: process.platform === 'win32' || process.getuid?.() === 0 },
  t => {
    const { env, run, directory } = session(t);
    chmodSync(directory, 0o500);
    try {
      for (const required of [true, false]) {
        const model = required ? 'start-model' : 'save-model';
        assert.deepEqual(agentAuthorship({ required, model, run }, env), {
          authorship: { kind: 'agent' },
          agentClient: `codex:${model}`,
          agentRun: run,
        });
      }
      assert.equal(existsSync(join(directory, 'forge')), false, 'no declaration could be persisted');
    } finally {
      chmodSync(directory, 0o700);
    }
  },
);

test('unknown is explicit, missing agent model is refused once, and a person is never asked', t => {
  const { env, run } = session(t);
  assert.throws(
    () => agentAuthorship({ required: true, run }, env),
    e => e.code === 'BAD_ARGUMENT' && /model/.test(e.message) && /FORGE_AGENT_MODEL/.test(e.message),
  );
  const unknown = agentAuthorship({ required: true, run, model: 'unknown' }, env);
  assert.deepEqual(unknown, {
    authorship: { kind: 'agent', declaration: 'unknown' },
    agentClient: 'codex',
    agentRun: run,
  });
  assert.deepEqual(agentAuthorship({ run }, env), unknown);
  assert.deepEqual(agentAuthorship({ required: true }, { FORGE_HUMAN: '1' }), {
    authorship: { kind: 'person' },
  });
});

test('FORGE_AGENT_MODEL satisfies start and no stamp input is trimmed or accepts trailer injection', t => {
  const { env, run } = session(t);
  assert.equal(
    agentAuthorship({ required: true, run }, { ...env, FORGE_AGENT_MODEL: 'model-one' }).agentClient,
    'codex:model-one',
  );
  for (const model of ['', ' model', 'model ', 'model\n', 'model\nCo-Authored-By: forged'])
    assert.throws(
      () => agentAuthorship({ model, run }, env),
      e => e.code === 'BAD_ARGUMENT' && /FORGE_AGENT_MODEL/.test(e.message),
    );
});

test('the writer sends start stamps only when the server advertises the reader-compatible contract', async t => {
  session(t);
  const legacy = agentFixture(t);
  const old = await legacy
    .transport()
    .dispatch('start', { outcome: 'Legacy server', model: 'model-one', open: false });
  assert.equal(legacy.calls.find(c => c.name === 'projectHostedStart:start').args.authorship, undefined);
  const modern = agentFixture(t);
  modern.caps.features = ['source-authorship-v1', 'agent-slug'];
  const transport = modern.transport(`session-${randomUUID()}`);
  const first = await transport.dispatch('start', {
    outcome: 'Declared builder',
    model: 'model-one',
    open: false,
  });
  const request = modern.calls.find(c => c.name === 'projectHostedStart:start').args;
  assert.equal(request.authorship.kind, 'agent');
  assert.match(request.agentClient, /:model-one$/);
  const retry = await transport.dispatch('start', {
    outcome: 'Declared builder',
    model: 'model-two',
    open: false,
    operationId: first.operationId,
  });
  assert.equal(retry.operationId, first.operationId);
  assert.deepEqual(
    retry.result,
    first.result,
    'client journal and server identity both reconcile after a model switch',
  );
});

test('receipt stamps reuse publication calls, reads and writes and retain only bounded metadata', async t => {
  const { acceptanceFixture } = await import('./hosted-acceptance-fixture.mjs');
  const samples = [];
  for (const authorship of [undefined, { kind: 'agent', declaration: 'unknown' }]) {
    const f = await acceptanceFixture();
    const prepared = await f.ready(null, authorship ? { authorship } : {});
    const before = f.counts.length;
    const result = await f.accept(prepared.state);
    const counts = f.counts.slice(before);
    samples.push({
      calls: counts.length,
      ...Object.fromEntries(
        ['ranges', 'documents', 'writes', 'readBytes', 'writeBytes'].map(k => [
          k,
          counts.reduce((n, c) => n + c[k], 0),
        ]),
      ),
      receiptBytes: Buffer.byteLength(JSON.stringify(result.receipt)),
    });
  }
  for (const key of ['calls', 'ranges', 'documents', 'writes'])
    assert.equal(samples[1][key], samples[0][key], `no additional publication ${key}`);
  const delta = Object.fromEntries(Object.keys(samples[0]).map(k => [k, samples[1][k] - samples[0][k]]));
  assert(
    delta.receiptBytes > 0 && delta.receiptBytes < 160,
    'only builder kind, missing-model state and server-owned actor',
  );
  t.diagnostic(
    `authorship publication fixture delta ${JSON.stringify(delta)}; source bytes remain in R2; this is deterministic I/O, not billed usage`,
  );
});

test('negotiated Lane selections and save results refuse person model/run combinations', async t => {
  const { hostedLaneSelectionSchema } = await import('../dist/hosted-lane.js');
  const { saveResultSchema } = await import('../dist/hosted-save.js');
  const f = agentFixture(t);
  const person = { ...f.lane, authorship: { kind: 'person' } };
  const saved = {
    schema: 1,
    operationId: randomUUID(),
    laneId: f.lane.laneId,
    saveId: randomUUID(),
    head: f.lane.head,
    version: 1,
    sourceVersion: 1,
    unchanged: false,
    at: '2026-01-01T00:00:00.000Z',
    authorship: { kind: 'person' },
  };
  assert(hostedLaneSelectionSchema.safeParse(person).success);
  assert(saveResultSchema.safeParse(saved).success);
  for (const stamp of [{ agentClient: 'fixture:model-one' }, { agentRun: 'quiet-otter' }]) {
    assert(!hostedLaneSelectionSchema.safeParse({ ...person, ...stamp }).success);
    assert(!saveResultSchema.safeParse({ ...saved, ...stamp }).success);
  }
});

test('declared save stamps add metadata bytes without adding source calls, DB reads or writes', async t => {
  const { saveFixture } = await import('./hosted-saves-fixture.mjs');
  const samples = [];
  for (const stamp of [
    {},
    { authorship: { kind: 'agent' }, agentClient: 'fixture:model-one', agentRun: 'quiet-otter' },
  ]) {
    const f = await saveFixture();
    const before = f.counts.length;
    const x = await f.prepare([f.change()], stamp);
    await f.stage(x);
    await f.submit(x);
    await f.publish(await f.work(x));
    const counts = f.counts.slice(before);
    samples.push({
      calls: counts.length,
      ...Object.fromEntries(
        ['ranges', 'documents', 'writes', 'readBytes', 'writeBytes'].map(k => [
          k,
          counts.reduce((n, c) => n + c[k], 0),
        ]),
      ),
    });
  }
  for (const key of ['calls', 'ranges', 'documents', 'writes'])
    assert.equal(samples[1][key], samples[0][key], `no additional save ${key}`);
  t.diagnostic(
    `authorship save fixture delta ${JSON.stringify(Object.fromEntries(Object.keys(samples[0]).map(k => [k, samples[1][k] - samples[0][k]])))}; deterministic I/O, not billed usage`,
  );
});

test('a restarted app resumes a retained start without asking for the original declaration again', async t => {
  session(t);
  const prior = process.env.FORGE_AGENT_MODEL;
  delete process.env.FORGE_AGENT_MODEL;
  t.after(() => {
    if (prior === undefined) delete process.env.FORGE_AGENT_MODEL;
    else process.env.FORGE_AGENT_MODEL = prior;
  });
  const s = agentFixture(t);
  s.caps.features = ['source-authorship-v1', 'agent-slug'];
  const operationId = randomUUID();
  const command = { operationId, outcome: 'Resume the retained start', open: false };
  const first = await s
    .transport(`initial-${randomUUID()}`)
    .dispatch('start', { ...command, model: 'model-one' });
  const replay = await s.transport(`restarted-${randomUUID()}`).dispatch('start', command);
  assert.deepEqual(replay.result, first.result);
  const starts = s.calls.filter(c => c.name === 'projectHostedStart:start');
  assert.deepEqual(starts.at(-1).args, starts[0].args);
  assert.match(starts.at(-1).args.agentClient, /:model-one$/);
});

test('an explicitly declared model survives unavailable app detection without guessing a harness', async t => {
  session(t);
  const { readAuthorship } = await import('../dist/work-actor-types.js');
  const fallbackSession = `unknown-app-${randomUUID()}`;
  assert.deepEqual(agentAuthorship({ required: true, fallbackSession }, {}), {
    authorship: { kind: 'person' },
  });
  const stamp = agentAuthorship({ required: true, fallbackSession, model: 'model-one' }, {});
  assert.equal(stamp.authorship.kind, 'agent');
  assert.equal(stamp.agentClient, 'agent:model-one');
  assert.equal(readAuthorship(stamp).app, undefined);
  assert.equal(readAuthorship(stamp).model, 'model-one');
  assert(stamp.agentRun);
  assert.deepEqual(
    agentAuthorship({ fallbackSession }, {}),
    { authorship: { kind: 'person' } },
    'an undetected app declaration applies only to its command',
  );
  assert.deepEqual(agentAuthorship({ fallbackSession, run: stamp.agentRun }, { FORGE_HUMAN: '1' }), {
    authorship: { kind: 'person' },
  });
});

test('a later plain command in the same shell stays a person after a one-off environment model', t => {
  const { directory } = session(t);
  const fallbackSession = `plain-shell-${randomUUID()}`;
  assert.equal(
    agentAuthorship({ required: true, fallbackSession }, { FORGE_AGENT_MODEL: 'model-one' }).agentClient,
    'agent:model-one',
  );
  assert.deepEqual(agentAuthorship({ required: true, fallbackSession }, {}), {
    authorship: { kind: 'person' },
  });
  assert.equal(existsSync(join(directory, 'forge')), false, 'no shell declaration is persisted');
});
