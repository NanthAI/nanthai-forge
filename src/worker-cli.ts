import { CUTOVER_CLI_VERSION } from './cutover-version.js';
// SPDX-License-Identifier: Apache-2.0
import { deliverMacCallback } from './hosted-mac-delivery.js';
import { randomUUID } from 'node:crypto';
import { makeFunctionReference } from 'convex/server';
import { z } from 'zod';
import { ConvexExchange } from './exchange-client.js';
import { hostedRunSubscription } from './hosted-agent-observe.js';
import { checkEnvironment } from './check-environment.js';
import { hostedMacRuntime } from './hosted-mac-lease.js';
import { hostedCheckRunSchema, hostedMacRunnerSchema } from './hosted-check.js';
import { runHostedMacWorker } from './hosted-mac-worker.js';
import { executeHostedMacCheck } from './hosted-mac-execute.js';
import { invariant } from './errors.js';
import { canonicalPayload } from './hosted-source-operation.js';
import type { OutputTransport } from './hosted-output-transfer.js';

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
  const configuration = hostedMacRunnerSchema.parse({
    provider: 'mac',
    machineId,
    runtime: hostedMacRuntime,
    environmentFingerprint: checkEnvironment().fingerprint,
  });
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
    key = process.env[`FORGE_HOSTED_CHECK_KEY_${keyId}`];
  invariant(key, 'RUNNER_UNAVAILABLE', 'Configure this fixed collector’s existing signing key.');
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
    process.stderr.write(`Mac runner registered: ${machineId}; waiting for hosted work.\n`);
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
