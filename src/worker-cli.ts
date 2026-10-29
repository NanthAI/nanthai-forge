import { CUTOVER_CLI_VERSION } from './cutover-version.js';
// SPDX-License-Identifier: Apache-2.0
import { deliverMacCallback } from './hosted-mac-delivery.js';
import { randomUUID } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { makeFunctionReference } from 'convex/server';
import { z } from 'zod';
import { ConvexExchange } from './exchange-client.js';
import { hostedRunSubscription } from './hosted-agent-observe.js';
import { checkEnvironment } from './check-environment.js';
import { hostedMacRuntime } from './hosted-mac-lease.js';
import { hostedCheckRunSchema, hostedMachineRunnerSchema } from './hosted-check.js';
import { runHostedMacWorker } from './hosted-mac-worker.js';
import { executeHostedMacCheck } from './hosted-mac-execute.js';
import { invariant } from './errors.js';
import { canonicalPayload } from './hosted-source-operation.js';
import type { OutputTransport } from './hosted-output-transfer.js';

/** The collector key comes from FORGE_HOSTED_CHECK_KEY_<id>, or from an owner-only
 * file named by FORGE_HOSTED_CHECK_KEY_FILE so it never sits in a service definition or
 * shell history. The child check environment drops both names. */
export function hostedCheckKey(keyId: string, env: NodeJS.ProcessEnv = process.env) {
  const direct = env[`FORGE_HOSTED_CHECK_KEY_${keyId}`];
  if (direct) return direct;
  const path = env.FORGE_HOSTED_CHECK_KEY_FILE;
  invariant(
    path,
    'RUNNER_UNAVAILABLE',
    `Configure this fixed collector’s signing key: set FORGE_HOSTED_CHECK_KEY_FILE to a chmod 600 file holding key ${keyId}.`,
  );
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    invariant(false, 'RUNNER_UNAVAILABLE', 'The collector key file could not be read.');
  }
  invariant(
    stat.isFile() &&
      (stat.mode & 0o077) === 0 &&
      (typeof process.getuid !== 'function' || stat.uid === process.getuid()),
    'RUNNER_UNAVAILABLE',
    'The collector key file must be a regular file you own with mode 600.',
  );
  const key = readFileSync(path, 'utf8').trim();
  invariant(key, 'RUNNER_UNAVAILABLE', 'The collector key file is empty.');
  return key;
}
/** Preserve the selected wire format (including legacy Mac), labels and digest.
 * Never guess a different environment or downgrade a self-hosted registration. */
export function workerConfiguration(value: unknown, machineId: string) {
  const configuration = hostedMachineRunnerSchema.parse(value);
  const environment = checkEnvironment();
  invariant(
    configuration.machineId === machineId &&
      configuration.runtime === hostedMacRuntime &&
      configuration.environmentFingerprint === environment.fingerprint &&
      (configuration.provider === 'mac' ||
        !configuration.platform ||
        (configuration.platform.os === process.platform && configuration.platform.arch === process.arch)),
    'EVIDENCE_CHANGED',
    'Run configure-runner in this worker’s exact environment and use its machine identity.',
  );
  return configuration;
}
export async function workerCli(args: string[]) {
  invariant(
    args.length === 3 && args[0] && args[1] && args[2],
    'BAD_ARGUMENT',
    'Use worker DEPLOYMENT_URL PROJECT_ID MACHINE_UUID.',
  );
  const [url, projectId, machineId] = args as [string, string, string];
  const sessionId = randomUUID();
  invariant(z.uuid().safeParse(machineId).success, 'BAD_ARGUMENT', 'Use a machine UUID.');
  const exchange = new ConvexExchange(url, process.env.FORGE_AUTH_TOKEN, projectId, sessionId, null);
  const address = { projectId, machineId, sessionId };
  const mutation = async (name: string, value: Record<string, unknown>) =>
    JSON.parse(
      await deliverMacCallback(() =>
        exchange.client.mutation(makeFunctionReference<'mutation', Record<string, unknown>, string>(name), {
          projectId,
          ...value,
        }),
      ),
    );
  const current = JSON.parse(
    await exchange.client.query(
      makeFunctionReference<'query', { projectId: string; checkId: string }, string>(
        'projectHostedCheckDefinitions:current',
      ),
      { projectId, checkId: '' },
    ),
  );
  const configuration = workerConfiguration(current.configuration, machineId);
  const capabilities: { authority: { epoch: number } } = JSON.parse(
    await exchange.client.query(
      makeFunctionReference<'query', { projectId: string; clientVersion: string }, string>(
        'projectHostedAgent:capabilities',
      ),
      { projectId, clientVersion: CUTOVER_CLI_VERSION },
    ),
  );
  const registered = await mutation('projectHostedCheckWorker:register', {
    request: canonicalPayload({
      operationId: sessionId,
      authorityEpoch: capabilities.authority.epoch,
      configuration,
    }),
  });
  const keyId: string = registered.result.keyId,
    key = hostedCheckKey(keyId);
  const subscriptions = hostedRunSubscription({ url, projectId });
  const stop = new AbortController();
  const abort = () => stop.abort();
  process.once('SIGINT', abort);
  process.once('SIGTERM', abort);
  const outputArgs = (message: unknown, signature: string) => ({
    message: canonicalPayload(message),
    signature,
  });
  const output: OutputTransport = {
    prepareBatch: entries =>
      mutation('projectHostedOutputBatch:workerPrepare', {
        entries: entries.map(({ message, signature }) => outputArgs(message, signature)),
      }),
    commitBatch: async entries =>
      JSON.parse(
        await exchange.client.action(
          makeFunctionReference<'action', Record<string, unknown>, string>(
            'projectHostedOutputBatch:workerCommit',
          ),
          { projectId, entries: entries.map(({ message, signature }) => outputArgs(message, signature)) },
        ),
      ),
    prepare: (message, signature) =>
      mutation('projectHostedOutputApi:workerPrepare', outputArgs(message, signature)),
    commit: async (message, signature) =>
      JSON.parse(
        await exchange.client.action(
          makeFunctionReference<'action', Record<string, unknown>, string>(
            'projectHostedOutputApi:workerCommit',
          ),
          { projectId, ...outputArgs(message, signature) },
        ),
      ),
    put: async (target, headers, bytes) => {
      const response = await fetch(target, {
        method: 'PUT',
        headers,
        body: bytes as BodyInit,
        redirect: 'error',
        signal: AbortSignal.timeout(30_000),
      });
      return { status: response.status };
    },
  };
  try {
    process.stderr.write(
      `Self-hosted runner registered: ${machineId} (${process.platform}/${process.arch}); waiting for hosted work.\n`,
    );
    await runHostedMacWorker(
      {
        sessionId,
        key,
        work: (update, error) =>
          subscriptions.onUpdate(
            makeFunctionReference<'query'>('projectHostedCheckWorker:work'),
            address,
            value => {
              try {
                update(z.array(z.uuid()).parse(JSON.parse(String(value))));
              } catch (failure) {
                error(failure as Error);
              }
            },
            error,
          ),
        watch: (runId, update, error) =>
          subscriptions.onUpdate(
            makeFunctionReference<'query'>('projectHostedCheckRead:status'),
            { projectId, runId },
            value => {
              try {
                update(hostedCheckRunSchema.parse(JSON.parse(String(value))));
              } catch (failure) {
                error(failure as Error);
              }
            },
            error,
          ),
        control: (runId, command) =>
          mutation('projectHostedCheckWorker:control', {
            ...address,
            runId,
            command: canonicalPayload(command),
          }),
        heartbeat: (callback, signature) =>
          mutation('projectHostedCheckWorker:heartbeat', { callback: canonicalPayload(callback), signature }),
        execute: (run, signal, control) =>
          executeHostedMacCheck(
            run,
            signal,
            control,
            {
              objects: ids => exchange.objects(ids),
              downloadToFile: (pin, path) => exchange.downloadToFile(pin, path),
              upload: (pin, bytes) => exchange.upload(pin, bytes),
              callback: (callback, signature) =>
                mutation('projectHostedCheckWorker:callback', {
                  callback: canonicalPayload(callback),
                  signature,
                }),
              output,
            },
            key,
          ),
        close: () => subscriptions.close(),
      },
      stop.signal,
    );
  } finally {
    process.removeListener('SIGINT', abort);
    process.removeListener('SIGTERM', abort);
  }
}
