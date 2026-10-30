// SPDX-License-Identifier: Apache-2.0
import { useMemo, useState } from 'react';
import { useConvex } from 'convex/react';
import { api } from '../../../convex/_generated/api';
import type { Id } from '../../../convex/_generated/dataModel';
import { hostedMainV2Schema, type HostedMainV2 } from '../../../src/hosted-main';
import { invariant } from '../../../src/errors';
import { PendingWrite } from '../pending-write';
import { hostedError } from '../snapshot';

type Main = Pick<HostedMainV2, 'head' | 'receipt' | 'authority'>;
type Start = { intentId: string; main: Main };
export type FixAnswerIO = {
  main: () => Promise<Main>;
  start: (request: Start & { operationId: string }) => Promise<string>;
  close: (request: { intentId: string; operationId: string }) => Promise<unknown>;
};

/** Discovery and writes stay pinned across unknown replies; concurrent clicks share one attempt. */
export class FixAnswers {
  private starts = new Map<string, { command: Start; write: PendingWrite<Start, string> }>();
  private closes = new Map<string, PendingWrite<string, unknown>>();
  private running = new Map<string, Promise<unknown>>();
  constructor(private io: FixAnswerIO) {}
  private once<T>(key: string, run: () => Promise<T>): Promise<T> {
    const previous = this.running.get(key);
    if (previous) return previous as Promise<T>;
    const attempt = run().finally(() => this.running.delete(key));
    this.running.set(key, attempt);
    return attempt;
  }
  startFix(intentId: string): Promise<string> {
    return this.once(`start:${intentId}`, async () => {
      let retained = this.starts.get(intentId);
      if (!retained) {
        const command = { intentId, main: await this.io.main() };
        retained = {
          command,
          write: new PendingWrite(async ({ operationId, command }) => {
            const result = JSON.parse(await this.io.start({ operationId, ...command }));
            invariant(
              result?.schema === 1 &&
                result.operationId === operationId &&
                result.intentId === command.intentId &&
                result.lane?.intentId === command.intentId &&
                typeof result.lane?.laneId === 'string' &&
                /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(result.lane.laneId),
              'BAD_ARGUMENT',
              'The fix did not return its Lane.',
            );
            return result.lane.laneId;
          }),
        };
        this.starts.set(intentId, retained);
      }
      const laneId = await retained.write.send(retained.command);
      this.starts.delete(intentId);
      return laneId;
    });
  }
  closeFix(intentId: string): Promise<void> {
    return this.once(`close:${intentId}`, async () => {
      let write = this.closes.get(intentId);
      if (!write) {
        write = new PendingWrite(({ operationId, command }) =>
          this.io.close({ operationId, intentId: command }),
        );
        this.closes.set(intentId, write);
      }
      await write.send(intentId);
      this.closes.delete(intentId);
    });
  }
}

/** Mounting this hook performs no reads; main is queried only when Start a fix is clicked. */
export function useFixAnswers(projectId: Id<'hostedProjects'>) {
  const client = useConvex();
  const actions = useMemo(
    () =>
      new FixAnswers({
        main: async () =>
          hostedMainV2Schema.parse(
            JSON.parse(await client.query(api.projectHostedChannels.current, { projectId })),
          ),
        start: ({ operationId, intentId, main }) =>
          client.mutation(api.projectHostedStart.start, {
            projectId,
            operationId,
            noticeVersion: 1,
            authorityEpoch: main.authority.epoch,
            expectedMain: { head: main.head, receiptId: main.receipt.id },
            intent: { kind: 'existing', intentId },
          }),
        close: ({ operationId, intentId }) =>
          client.mutation(api.projectWorkCommand.command, {
            projectId,
            operationId,
            command: JSON.stringify({ action: 'intent-status', intentId, status: 'abandoned' }),
          }),
      }),
    [client, projectId],
  );
  const [busy, setBusy] = useState(''),
    [error, setError] = useState('');
  async function run<T>(key: string, action: () => Promise<T>) {
    setBusy(key);
    setError('');
    try {
      return await action();
    } catch (error) {
      setError(hostedError(error));
      return null;
    } finally {
      setBusy('');
    }
  }
  return {
    busy,
    error,
    startFix: (intentId: string) => run(`start-fix:${intentId}`, () => actions.startFix(intentId)),
    closeFix: (intentId: string) =>
      run(`close-fix:${intentId}`, async () => {
        await actions.closeFix(intentId);
        return true;
      }),
  };
}
