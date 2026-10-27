import { enrichHostedQueueAhead } from './queue-ahead-hosted.js';
// SPDX-License-Identifier: Apache-2.0
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { observeHostedSubmissions } from './hosted-agent-submission-wait.js';
import { z } from 'zod';
import { HostedAgentTransport } from './hosted-agent-transport.js';
import { hostedLandingStateSchema } from './hosted-landing.js';
import { invariant } from './errors.js';
import type { RetainedBoundSubmission } from './hosted-agent-bound.js';
import type { WorkStore } from './work-store.js';

/** Selected hosted reads need neither the owner writer lock nor a live Mac
 * controller. Preparation before hosted admission remains visible as pending. */
export async function boundLandingStatus(
  store: WorkStore,
  input: unknown,
  native: () => Promise<{ revision: number; result: unknown }>,
  supplied?: HostedAgentTransport,
) {
  const { operationId } = z.object({ operationId: z.uuid() }).parse(input);
  const path = join(store.directory, 'hosted-submissions', `${operationId}.json`);
  if (!existsSync(path)) return native();
  let retained = JSON.parse(readFileSync(path, 'utf8')) as RetainedBoundSubmission;
  const seen = new Set([operationId]);
  while (retained.aliasOf) {
    invariant(!seen.has(retained.aliasOf), 'INVALID_WORK_STORE', 'Landing operation alias cycle.');
    seen.add(retained.aliasOf);
    retained = JSON.parse(
      readFileSync(join(store.directory, 'hosted-submissions', `${retained.aliasOf}.json`), 'utf8'),
    ) as RetainedBoundSubmission;
  }
  invariant(retained.address, 'INVALID_WORK_STORE', 'The original hosted project is unavailable.');
  if (retained.result) return { revision: store.revision(), result: retained.result };
  const transport = supplied ?? new HostedAgentTransport(store.root, retained.address);
  const submissions = [];
  for (const command of retained.hosted ?? []) {
    const page = await transport.query('projectHostedFinishObserve:page', {
      operationId: command.operationId,
      nextVersion: 0,
    });
    const parsed = z.object({ submission: hostedLandingStateSchema }).parse(page);
    const advice = (await enrichHostedQueueAhead(transport, page)) as { queueAhead?: unknown };
    submissions.push({
      ...parsed.submission,
      ...(advice.queueAhead ? { queueAhead: advice.queueAhead } : {}),
    });
  }
  const terminal =
    submissions.length > 0 && submissions.every(state => state.observation.state !== 'pending');
  const complete = terminal && submissions.every(state => state.observation.state === 'landed');
  return {
    revision: store.revision(),
    result: {
      operationId,
      transport: 'hosted',
      durable: submissions.length > 0,
      status: complete ? 'landed' : terminal ? 'terminal-failed' : (submissions[0]?.phase ?? 'preparing'),
      table: submissions.map(state => `${state.id}: ${state.observation.state}`).join('\n'),
      handle: {
        operationId:
          submissions.length === 1 ? submissions[0]!.operationId : String(retained.command.operationId),
        entryIds: submissions.map(state => state.id),
      },
      phase: complete ? 'landed' : terminal ? 'terminal-failed' : (submissions[0]?.phase ?? 'preparing'),
      terminal,
      complete,
      submissions,
    },
  };
}

/** Once admitted, wait only subscribes/reads the existing server-owned request. */
export async function watchBoundLanding(
  store: WorkStore,
  operationId: string,
  waitMs?: number,
  supplied?: HostedAgentTransport,
) {
  let retained = JSON.parse(
    readFileSync(join(store.directory, 'hosted-submissions', `${operationId}.json`), 'utf8'),
  ) as RetainedBoundSubmission;
  const seen = new Set([operationId]);
  while (retained.aliasOf) {
    invariant(!seen.has(retained.aliasOf), 'INVALID_WORK_STORE', 'Landing operation alias cycle.');
    seen.add(retained.aliasOf);
    retained = JSON.parse(
      readFileSync(join(store.directory, 'hosted-submissions', `${retained.aliasOf}.json`), 'utf8'),
    ) as RetainedBoundSubmission;
  }
  invariant(retained.address, 'INVALID_WORK_STORE', 'The original hosted project is unavailable.');
  let watchStatus: string | undefined;
  if (retained.hosted?.length) {
    const transport = supplied ?? new HostedAgentTransport(store.root, retained.address);
    const observed = await observeHostedSubmissions(transport, {
      operationIds: retained.hosted.map(command => command.operationId),
      timeoutSeconds: waitMs === undefined ? 60 : waitMs / 1000,
    });
    watchStatus = observed.result.status;
  }
  const current = await boundLandingStatus(
    store,
    { operationId },
    async () => {
      throw new Error('Original hosted landing is unavailable.');
    },
    supplied,
  );
  const result = current.result as { terminal?: boolean } & Record<string, unknown>;
  return watchStatus && !result.terminal
    ? { ...current, result: { ...result, status: watchStatus } }
    : current;
}
