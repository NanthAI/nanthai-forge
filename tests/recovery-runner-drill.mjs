// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { runnerRecoveryFixture } from './recovery-runner-fixture.mjs';
import { lanesFixture } from './hosted-lanes-fixture.mjs';
import { checksFixture } from './hosted-checks-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { recoverRunner } from '../dist/recovery-runner.js';
import { executeHostedMacCheck } from '../dist/hosted-mac-execute.js';
import { nativeOwner } from '../dist/native-source.js';
import { WorkStore } from '../dist/work-store.js';
import { WorkService } from '../dist/work.js';
import { outputRootObject } from '../dist/hosted-check-output.js';

const worker = await import(moduleUrl('../convex/projectHostedCheckWorker.ts'));
const records = await import(moduleUrl('../convex/projectHostedRecords.ts'));
const outputStore = await import(moduleUrl('../convex/projectHostedOutputStore.ts'));
const landing = await import(moduleUrl('../convex/projectHostedLanding.ts'));

/** One real harmless process; all hosted IO uses local fakes, no credentials. */
export async function recoveryRunnerDrill(t) {
  const times = {},
    measure = async (name, fn) => {
      const start = performance.now();
      const result = await fn();
      times[name] = Math.round(performance.now() - start);
      return result;
    };
  const recovered = await measure('fixture', () => runnerRecoveryFixture(t));
  const s = lanesFixture(),
    projectId = recovered.request.projectId;
  // The check backend is a local indexed fake for this same project and State.
  s.tables.hostedProjects.set(projectId, {
    _id: projectId,
    owner: 'owner',
    visibility: 'private',
    sourceAuthority: { mode: 'server', epoch: 1 },
  });
  recovered.selection.authority.epoch = 1;
  const state = { sha256: recovered.head, size: recovered.source.object(recovered.head).length };
  s.insert('projectHostedStates', {
    projectId,
    head: state.sha256,
    size: state.size,
    input: 'fixture',
    jobId: randomUUID(),
    output: 'fixture',
  });
  const candidate = JSON.parse(
    recovered.tables.projectHostedRecordBodies.find(row => JSON.parse(row.value).kind === 'candidate').value,
  );
  candidate.base = { head: recovered.head, receiptId: recovered.selection.hostedMain.receipt.id };
  s.insert('projectHostedChannels', {
    projectId,
    operationId: randomUUID(),
    name: 'main',
    selection: JSON.stringify(recovered.selection.hostedMain),
  });
  await s.call(
    'seedRecoveredCandidate',
    { _handler: records.writeHostedRecord },
    { projectId, actor: 'owner', authorityEpoch: 1, expectedVersion: null, record: candidate },
  );
  const f = await checksFixture({ store: s, projectId, state, candidate });
  f.put(recovered.source.object(recovered.head));
  s.tables._scheduled_functions = new Map();
  f.decorateContext(ctx => {
    ctx.db.system = { get: ctx.db.get };
    ctx.scheduler = {
      runAfter: async (_delay, _ref, args) =>
        ctx.db.insert('_scheduled_functions', { args: [args], state: { kind: 'pending' } }),
      cancel: async id => ctx.db.patch(id, { state: { kind: 'canceled' } }),
    };
  });
  const configuration = recovered.configuration;
  const configured = await f.configure({ kind: 'runner', configuration }, f.configuration.digest);
  const definition = await f.configure(
    {
      kind: 'definition',
      checkId: f.checkId,
      command: {
        name: 'route-b-drill',
        executable: process.execPath,
        args: [
          '-e',
          'const fs = require("node:fs"); if (fs.readFileSync("source.ts", "utf8") !== "accepted only on hosted\\n") process.exit(1);',
        ],
        environmentLabel: 'Synthetic recovered machine',
      },
    },
    f.definition.digest,
  );
  const secret = 'synthetic-route-b-collector';
  const saved = Object.fromEntries(
    ['FORGE_HOSTED_CHECK_KEY_ID', 'FORGE_HOSTED_CHECK_KEY_SYNTHETIC'].map(name => [name, process.env[name]]),
  );
  process.env.FORGE_HOSTED_CHECK_KEY_ID = 'SYNTHETIC';
  process.env.FORGE_HOSTED_CHECK_KEY_SYNTHETIC = secret;
  try {
    recovered.transport.register = async request =>
      JSON.parse(
        await f.call('registerRecoveredRunner', worker.register, {
          projectId,
          request: JSON.stringify(request),
        }),
      );
    const result = await measure('recover', () =>
      recoverRunner(recovered.target, recovered.request, recovered.transport),
    );
    Object.assign(times, result.timings);
    assert.equal(nativeOwner(recovered.target), null);
    assert(!existsSync(join(recovered.target, '.forge/native.json')));
    assert.equal(readFileSync(join(recovered.target, 'source.ts'), 'utf8'), 'accepted only on hosted\n');
    // The production native Work constructor cannot turn this cache into an
    // accepting owner; no native marker or local repository exists.
    await measure('cannotAccept', async () => {
      assert.throws(() => new WorkService(recovered.target));
      assert.throws(() => new WorkStore(recovered.target));
    });
    const submission = await measure('enqueue', async () =>
      JSON.parse(
        await s.call('recoveredLanding', landing.enqueue, {
          projectId,
          request: JSON.stringify({
            operationId: randomUUID(),
            authorityEpoch: 1,
            channel: 'main',
            expectedMain: candidate.base,
            candidateId: candidate.id,
            expectedHead: recovered.head,
            agent: true,
            check: {
              kind: 'request',
              checkId: f.checkId,
              expectedDefinition: definition.digest,
              expectedConfiguration: configured.digest,
              expectedEnvironment: configuration.environmentFingerprint,
            },
          }),
        }),
      ),
    );
    const selectedLanding = JSON.parse(
      await s.call('recoveredLandingStatus', landing.status, { projectId, submissionId: submission.id }),
    );
    const queued = { id: selectedLanding.attempt.check.runId };
    const address = {
      projectId,
      machineId: configuration.machineId,
      sessionId: recovered.request.operationId,
    };
    const control = async command =>
      JSON.parse(
        await f.call('controlRecoveredCheck', worker.control, {
          ...address,
          runId: queued.id,
          command: JSON.stringify(command),
        }),
      );
    const claim = (await control({ kind: 'claim', owner: address.sessionId, leaseMs: 60000 })).run;
    const output = new Map();
    await measure('check', () =>
      executeHostedMacCheck(
        claim,
        new AbortController().signal,
        async command => (await control(command)).run,
        {
          objects: recovered.transport.objects,
          downloadToFile: recovered.transport.downloadToFile,
          upload: async (_pin, bytes) => f.put(bytes),
          callback: async (callback, signature) =>
            JSON.parse(
              await f.call('recoveredCheckCallback', worker.callback, {
                projectId,
                callback: JSON.stringify(callback),
                signature,
              }),
            ),
          output: {
            prepare: async message => {
              const object =
                message.body.kind === 'chunk'
                  ? message.body.chunk.object
                  : outputRootObject(message.body.root);
              return {
                object,
                target: { kind: 'r2', url: `https://synthetic.invalid/${object.sha256}`, headers: {} },
              };
            },
            put: async (url, _headers, bytes) => {
              output.set(url, Buffer.from(bytes));
              return { status: 200 };
            },
            commit: (message, signature) =>
              f.run(
                'recoveredCheckOutput',
                (ctx, input) => outputStore.commitHostedOutput(ctx, input, () => secret),
                { projectId, message, signature },
              ),
          },
        },
        secret,
      ),
    );
    assert.equal((await f.status(queued.id)).status, 'passed');
    assert.equal(selectedLanding.attempt.check.runId, queued.id);
    assert.equal(
      s.tables.projectHostedAcceptances.size,
      0,
      'The recovered runner supplies evidence; it never accepts.',
    );
    assert.equal(
      result.coverage.hosted.counts.projectHostedLandingRequests,
      recovered.tables.projectHostedLandingRequests.length,
    );
    return {
      timingsMs: times,
      role: result.role,
      check: 'passed',
      localAcceptance: false,
      checkForHostedLanding: true,
      hostedOnlyMain: result.coverage.main.head,
      retainedLandingRequests: result.coverage.hosted.counts.projectHostedLandingRequests,
      pendingLandingsPreserved: recovered.tables.projectHostedLandingRequests.filter(
        row => row.phase === 'checking',
      ).length,
      completionReceiptsPreserved: result.coverage.hosted.counts.projectHostedAcceptancePlans,
      metric53: { fixtureDroppedLandings: 0, live: 'unmeasured' },
    };
  } finally {
    for (const [name, value] of Object.entries(saved))
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const cleanup = [];
  try {
    console.log(JSON.stringify(await recoveryRunnerDrill({ after: fn => cleanup.push(fn) }), null, 2));
  } finally {
    for (const fn of cleanup.reverse()) await fn();
  }
}
