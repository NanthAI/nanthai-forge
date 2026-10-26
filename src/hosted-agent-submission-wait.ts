// SPDX-License-Identifier: Apache-2.0
import { makeFunctionReference } from 'convex/server';
import { z } from 'zod';
import { hostedFinishSchema } from './hosted-finish.js';
import { hostedLandingStateSchema } from './hosted-landing.js';
import { sourceAuthoritySchema } from './hosted-source-authority.js';
import { HostedSubmissionWaitCursor } from './hosted-submission-wait-cursor.js';
import { digest } from './hash.js';
import { ForgeError, invariant } from './errors.js';
import { hostedActionError } from './hosted-action-error.js';
import { hostedRunSubscription, type HostedRunSubscription } from './hosted-agent-observe.js';
import type { HostedAgentTransport } from './hosted-agent-transport.js';

export const hostedSubmissionWaitSchema = z
  .object({
    operationIds: z.array(z.uuid()).min(1),
    cursor: z.string().nullable().optional(),
    until: z.enum(['terminal', 'any-change']).default('terminal'),
    timeoutSeconds: z.number().nonnegative().finite().default(600),
  })
  .strict();
const eventSchema = z.object({
  submission: hostedLandingStateSchema,
  pendingAttempt: hostedFinishSchema.shape.pending,
});
const pageSchema = z.object({
  projectId: z.string(),
  operationId: z.uuid(),
  canonicalOperationId: z.uuid().optional(),
  authority: sourceAuthoritySchema,
  submission: hostedLandingStateSchema,
  pendingAttempt: hostedFinishSchema.shape.pending,
  events: z.array(eventSchema),
  nextVersion: z.number().int().nonnegative(),
  isDone: z.boolean(),
  resnapshot: z.boolean(),
});
const decode = (value: unknown) => (typeof value === 'string' ? JSON.parse(value) : value);
/** Durable submission versions plus S05 selection-scoped deduplication. Live
 * queries are hints: register then reread to close the initial lost-wake window. */
export async function observeHostedSubmissions(
  transport: HostedAgentTransport,
  input: unknown,
  signal?: AbortSignal,
  emit: (value: unknown) => void = () => {},
  subscribe: () => HostedRunSubscription = () => hostedRunSubscription(transport.address),
) {
  const command = hostedSubmissionWaitSchema.parse(input);
  const operations = [...new Set(command.operationIds)];
  const discovery = await transport.dispatch('capabilities', {});
  const actor = z.object({ actor: z.string() }).parse(discovery.result).actor;
  const cursor = new HostedSubmissionWaitCursor(transport.address, actor, operations, command.cursor);
  const canonicalOperations = new Map<string, string>();
  const current = new Map<string, z.infer<typeof eventSchema>>();
  const sourceTerminal = new Map<string, boolean>();
  const terminal = () =>
    current.size === operations.length &&
    [...current.entries()].every(
      ([id, e]) => e.submission.observation.state !== 'pending' || sourceTerminal.get(id),
    );
  let client: HostedRunSubscription | undefined;
  let wake = () => {};
  let fail: (error: unknown) => void = () => {};
  const inputSubscriptions = new Map<string, () => void>();
  const unsubscribes: (() => void)[] = [];
  const readInputs = async (operationId: string) => {
    const observed = current.get(operationId)!;
    const selected = observed.submission;
    if (selected.preparing) return;
    for (const [key, unsubscribe] of inputSubscriptions) {
      if (key.startsWith(`${operationId}:`) && !key.startsWith(`${operationId}:${selected.attemptId}:`)) {
        unsubscribe();
        inputSubscriptions.delete(key);
      }
    }
    if (!selected.request.finish || observed.pendingAttempt) {
      sourceTerminal.set(operationId, false);
      return;
    }
    let index: number | null = 0,
      allTerminal = true,
      count = 0;
    do {
      const args = {
        projectId: transport.address.projectId,
        submissionId: selected.id,
        attemptId: selected.attemptId,
        index,
      };
      const key = `${operationId}:${selected.attemptId}:${index}`;
      if (client && !inputSubscriptions.has(key)) {
        const close = client.onUpdate(
          makeFunctionReference<'query'>('projectHostedFinish:inputs'),
          args,
          () => wake(),
          error => fail(hostedActionError(error, 'submission input observation')),
        );
        let active = true;
        const unsubscribe = () => {
          if (active) {
            active = false;
            close();
          }
        };
        inputSubscriptions.set(key, unsubscribe);
        unsubscribes.push(unsubscribe);
      }
      const page = z
        .object({
          entries: z.array(
            z
              .object({
                submissionId: z.uuid(),
                operationId: z.uuid(),
                laneId: z.uuid(),
                attemptId: z.uuid(),
                terminal: z.boolean(),
                complete: z.boolean(),
              })
              .passthrough(),
          ),
          staged: z.boolean(),
          nextIndex: z.number().int().nonnegative().nullable(),
        })
        .parse(await transport.query('projectHostedFinish:inputs', args));
      if (stopped) return;
      if (!page.staged) {
        allTerminal = false;
        break;
      }
      for (const entry of page.entries) {
        invariant(
          entry.submissionId === selected.id &&
            entry.operationId === selected.operationId &&
            entry.attemptId === selected.attemptId,
          'HOSTED_PROTOCOL_INVALID',
          'Input observation differs from the selected submission/attempt.',
        );
        count++;
        allTerminal &&= entry.terminal;
        const key = `input:${entry.submissionId}:${entry.attemptId}:${entry.laneId}`,
          hash = digest(JSON.stringify(entry));
        if (cursor.seen.seen.get(key) !== hash) {
          cursor.seen.seen.set(key, hash);
          changed = true;
          emit({ type: 'submission-input', ...entry, cursor: cursor.encode() });
        }
      }
      invariant(
        page.nextIndex === null || page.nextIndex > index!,
        'HOSTED_PROTOCOL_INVALID',
        'Input page did not advance.',
      );
      index = page.nextIndex;
    } while (index !== null && !stopped);
    sourceTerminal.set(operationId, count > 0 && allTerminal);
  };
  let changed = false,
    baseline = command.cursor == null,
    stopped = false,
    resnapshot = false;
  const publish = (operationId: string, event: z.infer<typeof eventSchema>, snapshot: boolean) => {
    const state = event.submission;
    invariant(
      state.projectId === transport.address.projectId &&
        state.operationId === (canonicalOperations.get(operationId) ?? operationId),
      'HOSTED_PROTOCOL_INVALID',
      'Submission observation differs from the selected project/operation.',
    );
    const key = `submission:${state.id}`;
    const hash = digest(JSON.stringify(event));
    if (cursor.seen.seen.get(key) === hash) return;
    cursor.seen.seen.set(key, hash);
    changed = true;
    emit({
      type: 'submission',
      id: state.id,
      operationId,
      version: state.version,
      ...event,
      ...(snapshot ? { resnapshot: true } : {}),
      terminal: state.observation.state !== 'pending',
      ok: state.observation.state === 'landed',
      cursor: cursor.encode(),
    });
  };
  const drain = async (operationId: string) => {
    for (;;) {
      if (stopped) return;
      const nextVersion = cursor.versions.get(operationId) ?? 0;
      const page = pageSchema.parse(
        decode(await transport.query('projectHostedFinishObserve:page', { operationId, nextVersion })),
      );
      invariant(
        page.projectId === transport.address.projectId &&
          page.operationId === operationId &&
          page.submission.projectId === page.projectId &&
          page.submission.operationId === (page.canonicalOperationId ?? operationId),
        'HOSTED_PROTOCOL_INVALID',
        'Submission page differs from the selected project/operation.',
      );
      if (stopped) return;
      canonicalOperations.set(operationId, page.canonicalOperationId ?? operationId);
      const authority = JSON.stringify(page.authority);
      if (cursor.authority && cursor.authority !== authority) {
        cursor.authority = authority;
        resnapshot = true;
        sourceTerminal.clear();
        // Resnapshot under fresh authority. Retained version identities remain
        // offsets only; every replay/page still rechecks access at the server.
        continue;
      }
      cursor.authority = authority;
      resnapshot ||= page.resnapshot;
      for (const event of page.events) {
        invariant(
          event.submission.version >= nextVersion && event.submission.version < page.nextVersion,
          'HOSTED_PROTOCOL_INVALID',
          'Submission page has an invalid version range.',
        );
        cursor.versions.set(operationId, event.submission.version + 1);
        publish(operationId, event, page.resnapshot);
      }
      cursor.versions.set(operationId, page.nextVersion);
      current.set(
        operationId,
        page.isDone
          ? { submission: page.submission, pendingAttempt: page.pendingAttempt }
          : page.events.at(-1)!,
      );
      if (page.isDone) {
        await readInputs(operationId);
        return;
      }
      invariant(
        page.nextVersion > nextVersion,
        'HOSTED_PROTOCOL_INVALID',
        'Submission page did not advance.',
      );
    }
  };
  const result = (status: 'terminal' | 'changed' | 'timeout' | 'cancelled') => ({
    ...discovery,
    action: 'observe' as const,
    result: {
      status,
      successful: terminal() && [...current.values()].every(e => e.submission.observation.state === 'landed'),
      submissions: [...current.values()],
      resnapshot,
      cursor: cursor.encode(),
    },
  });
  let timer: ReturnType<typeof setTimeout> | undefined, stop: (() => void) | undefined;
  try {
    for (const operation of operations) await drain(operation);
    if (terminal()) return result('terminal');
    if (!baseline && changed && command.until === 'any-change') return result('changed');
    if (signal?.aborted) return result('cancelled');
    if (!command.timeoutSeconds) return result('timeout');
    baseline = false;
    changed = false;
    client = subscribe();
    return await new Promise<ReturnType<typeof result>>((resolve, reject) => {
      fail = reject;
      let queue = Promise.resolve();
      const refresh = () => {
        queue = queue
          .then(async () => {
            if (stopped) return;
            for (const operation of operations) await drain(operation);
            if (stopped) return;
            if (terminal()) resolve(result('terminal'));
            else if (!baseline && changed && command.until === 'any-change') resolve(result('changed'));
            changed = false;
          })
          .catch(reject);
      };
      wake = refresh;
      const end = performance.now() + command.timeoutSeconds * 1000;
      const expire = () => {
        const remaining = end - performance.now();
        if (remaining <= 0) resolve(result('timeout'));
        else timer = setTimeout(expire, Math.min(remaining, 2_147_483_647));
      };
      expire();
      stop = () => resolve(result('cancelled'));
      signal?.addEventListener('abort', stop, { once: true });
      if (signal?.aborted) {
        stop();
        return;
      }
      for (const operationId of operations) {
        unsubscribes.push(
          client!.onUpdate(
            makeFunctionReference<'query'>('projectHostedFinishObserve:page'),
            {
              projectId: transport.address.projectId,
              operationId,
              nextVersion: cursor.versions.get(operationId) ?? 0,
            },
            () => refresh(),
            error => reject(hostedActionError(error, 'submission observation')),
          ),
        );
      }
      refresh();
    });
  } catch (error) {
    if (error instanceof z.ZodError || error instanceof SyntaxError)
      throw new ForgeError('HOSTED_PROTOCOL_INVALID', 'Hosted submission observation is invalid.');
    throw hostedActionError(error, 'submission observation');
  } finally {
    stopped = true;
    if (timer) clearTimeout(timer);
    if (stop) signal?.removeEventListener('abort', stop);
    try {
      for (const unsubscribe of unsubscribes) unsubscribe();
    } finally {
      await client?.close();
    }
  }
}
