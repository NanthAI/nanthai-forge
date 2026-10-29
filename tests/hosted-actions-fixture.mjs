// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { checksFixture } from './hosted-checks-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { digest } from '../dist/hash.js';
import { checkPin } from '../dist/hosted-check.js';
import { hostedActionsRuntime } from '../dist/hosted-actions.js';
const actions = await import(moduleUrl('../convex/projectHostedActions.ts'));
const records = await import(moduleUrl('../convex/projectHostedRecords.ts'));
export async function actionsFixture(files = []) {
  const s = await checksFixture(),
    bytes = new Map();
  const put = value => {
    const b = Buffer.from(value),
      pin = s.put(b);
    bytes.set(pin.sha256, b);
    return pin;
  };
  const state = put(
    JSON.stringify({
      schema: 1,
      kind: 'forge-source-state',
      parents: [],
      files: files.map(f => ({ path: f.path, blob: put(f.bytes).sha256, mode: f.mode ?? 'file' })),
      message: 'synthetic hosted actions source',
      at: '2026-01-01T00:00:00.000Z',
    }),
  );
  s.insert('projectHostedStates', {
    projectId: s.projectId,
    head: state.sha256,
    size: state.size,
    input: 'a'.repeat(64),
    jobId: randomUUID(),
    output: 'b'.repeat(64),
  });
  const candidate = {
    ...s.candidate,
    id: randomUUID(),
    version: 0,
    result: { status: 'clean', head: state.sha256 },
  };
  await s.run('actionsCandidate', records.writeHostedRecord, {
    ...s.auth,
    expectedVersion: null,
    record: candidate,
  });
  const runner = {
    provider: 'github-actions',
    repository: 'synthetic/project',
    installationId: 'installation-1',
    runsOn: 'blacksmith-4vcpu-ubuntu-2404',
    runtime: hostedActionsRuntime,
    environmentFingerprint: s.runner.environmentFingerprint,
    credential: { secretId: 'synthetic-installation-reference', version: 1, operation: 'github-actions' },
  };
  await s.bindRepository(s.projectId, { repository: runner.repository, repoId: 42 });
  const configuration = await s.configure({ kind: 'runner', configuration: runner }, s.configuration.digest);
  const run = await s.enqueue(
    s.selection({
      expectedConfiguration: configuration.digest,
      expectedHead: state.sha256,
      candidateId: candidate.id,
    }),
  );
  const selection = { scope: 'full', reason: 'synthetic exact command', tests: [] };
  const recipePins = {
    head: state.sha256,
    definition: run.check.definition,
    selection,
    groups: [],
    standard: true,
    interaction: false,
    command: ['node', 'scripts/forge-check.mjs'],
  };
  const recipe = { pin: checkPin(recipePins), ...recipePins };
  const p = await s.prepare(run.id, 1, {
    runtime: runner.runtime,
    lockfile: digest(files.find(f => f.path === 'package-lock.json')?.bytes ?? ''),
    selection: put(JSON.stringify(selection)),
    manifest: put(JSON.stringify(recipe)),
  });
  // H10 reserves before invoking a provider.
  await s.control(run.id, { kind: 'reserve', owner: p.owner, token: p.token });
  const input = await s.status(run.id);
  let now = Date.now();
  const scheduled = [];
  const scheduler = {
    runAfter: async (delay, reference, args) => {
      scheduled.push({ delay, reference, args });
      return `synthetic-task-${scheduled.length}`;
    },
  };
  s.decorateContext(ctx => {
    ctx.scheduler = scheduler;
  });
  const commands = [],
    metrics = { reads: 0, readBytes: 0, uploads: 0, uploadBytes: 0 };
  const store = {
    control: async command => {
      commands.push(structuredClone(command));
      return s.run(
        'actionsControl',
        (ctx, args) => actions.controlHostedActions({ ...ctx, scheduler }, args, now),
        {
          projectId: s.projectId,
          runId: run.id,
          command,
        },
      );
    },
  };
  const transport = {
    async describe(sha256) {
      assert(bytes.has(sha256));
      return { object: { sha256, size: bytes.get(sha256).length }, recipe: null };
    },
    async read(pin) {
      metrics.reads++;
      metrics.readBytes += pin.size;
      return (async function* () {
        const b = bytes.get(pin.sha256);
        assert(b);
        for (let i = 0; i < b.length; i += 8192) yield b.subarray(i, i + 8192);
      })();
    },
    async upload(pin, chunks) {
      metrics.uploads++;
      const parts = [];
      for await (const chunk of chunks) parts.push(chunk);
      const b = Buffer.concat(parts);
      assert.equal(digest(b), pin.sha256);
      assert.equal(b.length, pin.size);
      metrics.uploadBytes += b.length;
      put(b);
    },
  };
  const exported = { commit: '1'.repeat(40), bundle: put('synthetic-export-bundle') };
  return {
    ...s,
    put,
    input,
    recipe,
    runner,
    configuration,
    store,
    transport,
    bytes,
    commands,
    scheduled,
    scheduler,
    metrics,
    exported,
    now: () => now,
    advance: (ms = 120000) => {
      now += ms;
    },
    mapping: () => JSON.parse([...s.tables.projectHostedActionsExports.values()][0].value),
  };
}
