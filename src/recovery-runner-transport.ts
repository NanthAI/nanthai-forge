// SPDX-License-Identifier: Apache-2.0
import { makeFunctionReference } from 'convex/server';
import { ConvexExchange } from './exchange-client.js';
import { recoveryTransport } from './recovery-transport.js';
import type { RecoveryRequest } from './recovery-protocol.js';
import type { RecoveryTransport } from './recovery-source.js';
import type { MainTransport } from './hosted-main-checkout.js';
import type { HostedMacRunner } from './recovery-runner.js';

export type RunnerRecoveryTransport = RecoveryTransport &
  MainTransport & {
    configuration(): Promise<unknown>;
    register(request: {
      operationId: string;
      authorityEpoch: number;
      configuration: HostedMacRunner;
    }): Promise<unknown>;
  };
/** Recovery only reads hosted data; registration uses the ordinary Mac worker API. */
export function runnerRecoveryTransport(request: RecoveryRequest): RunnerRecoveryTransport {
  const exchange = new ConvexExchange(
    request.url,
    process.env.FORGE_AUTH_TOKEN,
    request.projectId,
    request.operationId,
    null,
  );
  const scope = { projectId: request.projectId };
  return Object.assign(recoveryTransport(request), {
    current: () => exchange.current(),
    objects: (ids: string[]) => exchange.objects(ids),
    downloadToFile: (pin: { sha256: string; size: number }, path: string) =>
      exchange.downloadToFile(pin, path),
    configuration: async () =>
      JSON.parse(
        await exchange.client.query(makeFunctionReference<'query'>('projectHostedCheckDefinitions:current'), {
          ...scope,
          checkId: '',
        }),
      ).configuration,
    register: async (registration: unknown) =>
      JSON.parse(
        await exchange.client.mutation(
          makeFunctionReference<'mutation'>('projectHostedCheckWorker:register'),
          { ...scope, request: JSON.stringify(registration) },
        ),
      ),
  });
}
