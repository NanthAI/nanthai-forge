// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as wait } from 'node:timers/promises';
import { getFunctionName, makeFunctionReference } from 'convex/server';
import { coordinationClient } from '../dist/coordination-client.js';
import { ConvexExchange } from '../dist/exchange-client.js';
import { nativeOwner } from '../dist/native-source.js';
import { WorkStore } from '../dist/work-store.js';
import { hostProject } from '../dist/host-cli.js';
import { readHostState } from '../dist/host-binding.js';
import { boundCutoverPins, cutoverBoundProject } from '../dist/source-cutover-client.js';
import { deleteHostedProject } from '../dist/host-delete.js';
import { HostedAgentTransport } from '../dist/hosted-agent-transport.js';
import { cloneHostedProject } from '../dist/hosted-clone-cli.js';
import { HostedCheckoutDownloads } from '../dist/hosted-checkout-downloads.js';
import { recoverRunner } from '../dist/recovery-runner.js';
import { runDrillCheck } from './phase5-hosted-lifecycle-runner.mjs';
import { prepareDrillOwner } from './phase5-hosted-lifecycle-fixture.mjs';

export const drillDeployment = 'https://benevolent-wildebeest-974.convex.cloud';
export const dogfoodProject = 'mh7aafndrxmj8c2q0931zbjk2n8h4ffs';
export const callEstimate = {
  client: 400,
  serverInternalAllowance: 1000,
  total: 1400,
  sourceFiles: 1,
  note: 'Estimate for one tiny NEW project, including finite observation and normal deletion; provider billing is not measured.',
};
const parse = value => (typeof value === 'string' ? JSON.parse(value) : value);
export function measuredDrillClient(client, calls) {
  return Object.fromEntries(
    ['query', 'mutation', 'action'].map(kind => [
      kind,
      async (ref, args) => {
        assert.notEqual(args.projectId, dogfoodProject, 'the drill never addresses dogfood');
        assert(
          calls.length + callEstimate.serverInternalAllowance < 2000,
          'Q4 call estimate exceeds 2000; stop',
        );
        calls.push({ kind, name: getFunctionName(ref) });
        return client[kind](ref, args);
      },
    ]),
  );
}
export async function preflightHostedMachineDrill(client) {
  const result = await client.query(makeFunctionReference('projectBackups:list'), {
    paginationOpts: { cursor: null, numItems: 1 },
  });
  assert(Array.isArray(result.page), 'authenticated owner listing is unavailable');
  return { readOnly: true, authenticatedListing: true, estimate: callEstimate };
}

/** Never accepts an existing project ID. All writes use the project just created
 * by ordinary hosting; all raw provider replies stay out of the report/stdout. */
export async function liveHostedMachineDrill(directory) {
  directory = resolve(directory);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const reportPath = join(directory, 'report.json');
  assert(
    !existsSync(reportPath),
    'Use a fresh drill directory; retain the previous report and operation journals.',
  );
  const calls = [];
  const client = measuredDrillClient(coordinationClient(drillDeployment), calls);
  const report = {
    synthetic: false,
    deployment: drillDeployment,
    estimate: callEstimate,
    steps: [],
    result: 'running',
    cleanup: 'not-created',
    calls,
  };
  const save = () => writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  const step = async (name, action) => {
    const start = performance.now();
    try {
      const result = await action();
      report.steps.push({ name, status: 'passed', wallMs: Math.round(performance.now() - start) });
      save();
      return result;
    } catch (error) {
      report.steps.push({
        name,
        status: 'failed',
        wallMs: Math.round(performance.now() - start),
        code: error.data?.code ?? error.code ?? 'DRILL_FAILED',
      });
      save();
      throw error;
    }
  };
  const owner = join(directory, 'seed-owner');
  let project;
  const exchange = (projectId, operationId = randomUUID()) => {
    assert.notEqual(projectId, dogfoodProject);
    const result = new ConvexExchange(drillDeployment, undefined, projectId, operationId, null);
    result.client = client;
    return result;
  };
  try {
    report.preflight = await step('read-only preflight', () => preflightHostedMachineDrill(client));
    await step('prepare local synthetic accepted main', () => prepareDrillOwner(owner));
    project = await step('create and seed NEW scratch hosted project', () =>
      hostProject(
        owner,
        {
          deployment: drillDeployment,
          name: `Q4 scratch lifecycle ${randomUUID()}`,
          visibility: 'private',
          deferBackfill: true,
        },
        { client, exchange },
      ),
    );
    report.projectId = project.projectId;
    report.projectUrl = project.projectUrl;
    report.cleanup = 'pending';
    const store = new WorkStore(owner);
    const pins = await boundCutoverPins(store, client);
    const cutover = { operationId: randomUUID(), mode: 'server', pins };
    await step('read-only scratch cutover preflight', () =>
      cutoverBoundProject(store, cutover, true, client),
    );
    await step('scratch switches to one hosted authority', () =>
      cutoverBoundProject(store, cutover, false, client),
    );
    const address = { url: drillDeployment, projectId: project.projectId };
    const firstRoot = join(directory, 'first-mac');
    const agent = root => new HostedAgentTransport(root, address, exchange(project.projectId));
    const first = agent(firstRoot);
    const started = await step('start hosted Lane', () =>
      first.dispatch('start', { operationId: randomUUID(), outcome: 'Q4 disposable machine lifecycle' }),
    );
    const laneId = started.result.lane.laneId;
    report.laneId = laneId;
    await first.dispatch('open', { operationId: randomUUID(), laneId });
    writeFileSync(join(firstRoot, 'q4.txt'), 'Q4 saved before Mac offline\n');
    const saved = await step('save hosted Lane', () =>
      first.dispatch('save', { operationId: randomUUID(), laneId, message: 'Q4 saved source' }),
    );
    // Finite active-drill observation, never a background observer or poller.
    const until = async (read, done) => {
      for (let i = 0; i < 80; i++) {
        const value = await read();
        if (done(value)) return value;
        await wait(500);
      }
      throw Object.assign(Error('drill observation unfinished'), { code: 'DRILL_INCOMPLETE' });
    };
    await until(
      () => first.dispatch('observe', { kind: 'save', operationId: saved.operationId }),
      value => !!value.result.terminal,
    );
    renameSync(firstRoot, join(directory, 'offline-mac'));
    const secondRoot = join(directory, 'replacement-mac');
    const second = agent(secondRoot);
    await step('Mac offline; resume saved Lane from fresh root', async () => {
      await second.dispatch('open', { operationId: randomUUID(), laneId });
      assert.equal(readFileSync(join(secondRoot, 'q4.txt'), 'utf8'), 'Q4 saved before Mac offline\n');
      assert.equal(nativeOwner(secondRoot), null);
    });
    const check = await step('configure scratch harmless check', () =>
      second.dispatch('configure-check', {
        operationId: randomUUID(),
        command: {
          name: 'verify',
          executable: process.execPath,
          args: [
            '-e',
            'if(require("node:fs").readFileSync("q4.txt","utf8")!=="Q4 saved before Mac offline\\n")process.exit(1)',
          ],
          environmentLabel: 'Q4 scratch only',
        },
      }),
    );
    const machineId = randomUUID();
    await second.dispatch('configure-runner', {
      operationId: randomUUID(),
      provider: 'self-hosted',
      machineId,
    });
    // The scratch-only policy was seeded by hostProject. Never change the
    // dogfood policy, configure a real repository, or select a paid provider.
    const finished = await step('finish submits durable desired landing', () =>
      second.dispatch('finish', {
        operationId: randomUUID(),
        laneId,
        message: 'Q4 scratch finish',
        accept: true,
        check: { checkId: check.result.key },
      }),
    );
    report.finishOperationId = finished.operationId;
    await step('independent collector completes exact hosted check', () =>
      runDrillCheck(client, exchange(project.projectId), address, machineId, until),
    );
    const terminal = await step('reconnect observes accepted terminal result', () =>
      until(
        () => second.dispatch('observe', { operationId: finished.operationId }),
        value => ['landed', 'terminal-failed'].includes(value.result.submission?.phase),
      ),
    );
    assert.equal(terminal.result.submission.phase, 'landed');
    report.receiptId = terminal.result.submission.acceptance.receiptId;
    await step('clone accepted main from another root', async () => {
      const ex = exchange(project.projectId),
        downloads = new HostedCheckoutDownloads(ex);
      const cloned = await cloneHostedProject(join(directory, 'fresh-clone'), address, {
        current: () => ex.current(),
        objects: ids => downloads.objects(ids),
        downloadToFile: (pin, path) => downloads.downloadToFile(pin, path),
        downloadFiles: files => downloads.downloadFiles(files),
      });
      report.acceptedHead = cloned.head;
    });
    const disposable = agent(join(directory, 'cancel-mac'));
    const pending = await disposable.dispatch('start', {
      operationId: randomUUID(),
      outcome: 'Q4 cancelled scratch work',
    });
    const cancelLane = pending.result.lane.laneId;
    const cancelOpened = await disposable.dispatch('open', { operationId: randomUUID(), laneId: cancelLane });
    const cancelRoot = cancelOpened.result.root;
    writeFileSync(join(cancelRoot, 'q4-cancel.txt'), 'Disposable unaccepted Q4 source\n');
    const cancelSave = await agent(cancelRoot).dispatch('save', {
      operationId: randomUUID(),
      laneId: cancelLane,
      message: 'Q4 cancel source',
    });
    await until(
      () => disposable.dispatch('observe', { kind: 'save', operationId: cancelSave.operationId }),
      value => !!value.result.terminal,
    );
    const ending = await agent(cancelRoot).dispatch('finish', {
      operationId: randomUUID(),
      laneId: cancelLane,
      message: 'Q4 cancel target',
      accept: true,
    });
    await step('cancel and abandon disposable work', async () => {
      const cancellation = await disposable.dispatch('cancel', {
        operationId: randomUUID(),
        submissionId: ending.result.submission?.id ?? ending.result.id,
      });
      assert.equal(cancellation.result.phase, 'terminal-failed', 'cancellation has not raced an acceptance');
      await disposable.dispatch('abandon', {
        operationId: randomUUID(),
        laneId: cancelLane,
        reason: 'Q4 disposable work',
      });
    });
    await step('recover clean runner/cache root', async () => {
      const request = { operationId: randomUUID(), ...address };
      const ex = exchange(project.projectId, request.operationId);
      const query = async (name, args) =>
        parse(await client.query(makeFunctionReference(name), { projectId: project.projectId, ...args }));
      const transport = Object.assign(ex, {
        prepare: () => query('projectRecovery:prepare', { operationId: request.operationId }),
        hostedPage: (selection, table, cursor) =>
          query('projectRecoveryHosted:page', { selection: JSON.stringify(selection), table, cursor }),
        configuration: async () =>
          (await query('projectHostedCheckDefinitions:current', { checkId: '' })).configuration,
        register: async registration =>
          parse(
            await client.mutation(makeFunctionReference('projectHostedCheckWorker:register'), {
              projectId: project.projectId,
              request: JSON.stringify(registration),
            }),
          ),
        reconnect: () => assert.fail('server recovery cannot restore native acceptance authority'),
      });
      const result = await recoverRunner(join(directory, 'recovered'), request, transport);
      assert.equal(result.coverage.main.head, report.acceptedHead);
      assert.equal(result.coverage.main.receipt.id, report.receiptId);
    });
    report.result = 'passed';
  } catch (error) {
    report.result = 'failed';
    report.errorCode =
      error.data?.code ??
      error.code ??
      (error instanceof assert.AssertionError ? 'ASSERTION_FAILED' : 'DRILL_FAILED');
    report.unrun = [
      'later steps after the last passed step',
      'physical 30-minute sleep',
      'physical 10-minute Wi-Fi loss',
    ];
  } finally {
    if (existsSync(owner)) {
      const state = readHostState(new WorkStore(owner));
      project ??= state.binding ?? state.hosting;
    }
    if (project?.projectId) {
      report.projectId = project.projectId;
      assert.notEqual(project.projectId, dogfoodProject);
      try {
        const slug = new URL(project.projectUrl).pathname.split('/').filter(Boolean).at(-1);
        const deleted = await deleteHostedProject(
          owner,
          {
            projectId: project.projectId,
            confirm: slug,
            deployment: drillDeployment,
            allowBoundProject: true,
          },
          { client, pollAttempts: 40, pollIntervalMs: 500 },
        );
        report.cleanup = deleted.purgeComplete ? 'deleted' : 'retained';
      } catch (error) {
        report.cleanup = 'retained';
        report.cleanupErrorCode = error.data?.code ?? error.code ?? 'DELETE_FAILED';
      }
    }
    report.observedClientCalls = calls.length;
    report.totalFunctionCalls = null;
    report.callCoverage =
      'client invocations only; server internal actions and scheduler calls are not exposed by the client';
    save();
  }
  return {
    result: report.result,
    reportPath,
    projectId: report.projectId,
    cleanup: report.cleanup,
    observedClientCalls: calls.length,
    errorCode: report.errorCode,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length === 2) {
      const calls = [];
      console.log(
        JSON.stringify(
          await preflightHostedMachineDrill(measuredDrillClient(coordinationClient(drillDeployment), calls)),
        ),
      );
    } else {
      assert.equal(process.argv[2], '--live');
      assert.equal(process.argv.length, 4);
      const result = await liveHostedMachineDrill(process.argv[3]);
      console.log(JSON.stringify(result));
      if (result.result !== 'passed') process.exitCode = 1;
    }
  } catch (error) {
    console.log(JSON.stringify({ result: 'failed', code: error.data?.code ?? error.code ?? 'DRILL_FAILED' }));
    process.exitCode = 1;
  }
}
