// SPDX-License-Identifier: Apache-2.0
import { makeFunctionReference } from 'convex/server';
import type { HostedWorkTransport } from './hosted-work-client.js';

type Progress = {
  operationId: string;
  state: 'pending' | 'building' | 'completed';
  generationId: string | null;
  revision: number;
  batches: number;
};

/** The server owns retries and batch pins; the client never invents a replacement operation. */
export async function runHostedIntentMigration(
  client: HostedWorkTransport,
  projectId: string,
  request: { operationId: string; dryRun: boolean },
  progress?: (line: string) => void,
): Promise<unknown> {
  const input = { projectId, operationId: request.operationId };
  if (request.dryRun)
    return JSON.parse(
      (await client.action(makeFunctionReference('projectIntentMigrationActions:preview'), {
        projectId,
      })) as string,
    );
  const prefix = `Intent migration ${request.operationId}`;
  let previous = '';
  async function observe() {
    const status = (await client.query(
      makeFunctionReference('projectIntentMigration:progress'),
      input,
    )) as Progress;
    const line =
      `${prefix}: ${status.state}; revision ${status.revision}; ${status.batches} staged batches` +
      (status.generationId ? `; generation ${status.generationId}` : '') +
      (status.operationId !== request.operationId ? `; published operation ${status.operationId}` : '');
    if (line !== previous) progress?.(line);
    previous = line;
  }
  progress?.(`${prefix}: resume with this same operationId if interrupted.`);
  // Read retained progress before resuming a possibly interrupted action.
  if (progress) await observe();
  const result = client.action(makeFunctionReference('projectIntentMigrationActions:migrate'), input).then(
    value => ({ ok: true as const, value }),
    error => ({ ok: false as const, error }),
  );
  if (progress) {
    while (true) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const next = await Promise.race([
        result,
        new Promise<null>(resolve => {
          timer = setTimeout(() => resolve(null), 1000);
        }),
      ]);
      clearTimeout(timer);
      if (next !== null) break;
      try {
        await observe();
      } catch {
        progress(`${prefix}: progress unavailable; awaiting the original request result.`);
        break;
      }
    }
  }
  const completed = await result;
  if (!completed.ok) {
    progress?.(`${prefix}: no successful result received; resume with the same operationId.`);
    throw completed.error;
  }
  progress?.(`${prefix}: completed; generation ${completed.value}.`);
  return { operationId: request.operationId, generationId: completed.value };
}
