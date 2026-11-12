// SPDX-License-Identifier: Apache-2.0
import { hasLandingCapsule } from './landing-capsule-client.js';
import { isNetworkPending } from './network-continuation.js';
import { observedConflictRecovery } from './hosted-observed-conflict.js';
import { makeFunctionReference } from 'convex/server';
import { z } from 'zod';
import { retryHostedObservation } from './hosted-observation-retry.js';
import { hostedFinishSchema } from './hosted-finish.js';
import { hostedLandingStateSchema } from './hosted-landing.js';
import { sourceAuthoritySchema } from './hosted-source-authority.js';
import { HostedSubmissionWaitCursor } from './hosted-submission-wait-cursor.js';
import { digest } from './hash.js';
import { ForgeError, invariant } from './errors.js';
import { hostedActionError } from './hosted-action-error.js';
import { hostedRunSubscription, type HostedRunSubscription } from './hosted-agent-observe.js';
import type { HostedAgentTransport } from './hosted-agent-transport.js';
import { landingRedriver } from './hosted-landing-redrive.js';
import { rememberLandedOperations } from './landed-operations.js';
import { boardWaker, type BoardDelivery, type BoardWaitOption } from './hosted-board-wait.js';
import {
  parseHostedOutcome,
  replyIssuePaths,
  safeParseHostedResponse,
  type ReplySkew,
} from './hosted-response.js';
import { stableSubmissionPageSchema } from './hosted-landing-stable.js';
import { contractSkew, replySkewError, replySkewSide } from './hosted-reply-skew.js';
import { hostedRecoveryCommand } from './hosted-agent-resolution.js';
import { syncRequiredAdvice, syncRequiredContinuation } from './hosted-would-conflict.js';

export const hostedSubmissionWaitSchema = z
  .object({
    operationIds: z.array(z.uuid()).min(1),
    cursor: z.string().nullable().optional(),
    until: z.enum(['terminal', 'any-change', 'acceptance']).default('terminal'),
    timeoutSeconds: z.number().nonnegative().finite().default(600),
  })
  .strict();
const eventSchema = z.object({
  submission: hostedLandingStateSchema,
  providerDelay: z.string().optional(),
  pendingAttempt: hostedFinishSchema.shape.pending,
  queue: z.unknown().optional(),
  queueAheadSelection: z.unknown().optional(),
  wouldConflict: z.unknown().optional(),
  orderWait: z.unknown().optional(),
  reservation: z.unknown().optional(),
  recovery: z.unknown().optional(),
  conflict: z.unknown().optional(),
});
const pageSchema = eventSchema.extend({
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
  queue: z.unknown().optional(),
  queueAheadSelection: z.unknown().optional(),
  wouldConflict: z.unknown().optional(),
  orderWait: z.unknown().optional(),
  reservation: z.unknown().optional(),
  recovery: z.unknown().optional(),
  conflict: z.unknown().optional(),
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
  /** Wait delivery: the caller's own Lane. A note to it ends the wait early (status "message"). */
  board?: BoardWaitOption,
) {
  const command = hostedSubmissionWaitSchema.parse(input);
  const current = new Map<string, z.infer<typeof eventSchema>>();
  let cursor = command.cursor ?? null,
    resnapshot = false,
    active = true;
  const pending = (status: 'timeout' | 'cancelled') => ({
    schema: 1 as const,
    transport: 'hosted' as const,
    action: 'observe' as const,
    operationId: null,
    resolved: null,
    result: {
      status,
      inProgress: true,
      successful: false,
      submissions: [...current.values()],
      resnapshot,
      cursor,
    },
  });
  try {
    const response = await retryHostedObservation({
      timeoutSeconds: command.timeoutSeconds,
      signal,
      emit,
      pending,
      attempt: (timeoutSeconds, signal) =>
        observeHostedSubmissionsOnce(
          transport,
          { ...command, cursor, timeoutSeconds },
          signal,
          value => {
            if (!active) return;
            const event = value as {
              type?: string;
              operationId?: string;
              cursor?: string;
              resnapshot?: boolean;
            } & z.infer<typeof eventSchema>;
            if (event.cursor) cursor = event.cursor;
            resnapshot ||= Boolean(event.resnapshot);
            if (event.type === 'submission' && event.operationId) {
              // Keep one cursor for the whole selection, never one growing
              // cursor per operation (which would retain quadratic metadata).
              const {
                submission,
                providerDelay,
                pendingAttempt,
                queue,
                wouldConflict,
                orderWait,
                reservation,
                queueAheadSelection,
                recovery,
                conflict,
              } = event;
              current.set(event.operationId, {
                submission,
                ...(providerDelay ? { providerDelay } : {}),
                pendingAttempt,
                ...(recovery ? { recovery } : {}),
                ...(conflict ? { conflict } : {}),
                ...(queue ? { queue } : {}),
                ...(wouldConflict ? { wouldConflict } : {}),
                ...(orderWait ? { orderWait } : {}),
                ...(reservation ? { reservation } : {}),
                ...(queueAheadSelection !== undefined ? { queueAheadSelection } : {}),
              });
            }
            emit(value);
          },
          subscribe,
          current,
          board,
        ),
    });
    const entry = response.result.submissions.length === 1 ? response.result.submissions[0] : undefined;
    // A sync-required stop names the one recovery (the same Lane's land --save), not another wait.
    const sync =
      response.result.status === 'sync-required'
        ? response.result.submissions
            .map(e => ({ e, advice: syncRequiredAdvice(e.wouldConflict, e.submission) }))
            .find(found => found.advice)
        : undefined;
    return {
      ...response,
      result: {
        ...response.result,
        ...(sync ? syncRequiredContinuation(transport.root, sync.advice!) : {}),
        ...(entry?.recovery ? { recovery: entry.recovery } : {}),
        ...(entry?.conflict ? { conflict: entry.conflict } : {}),
        ...(['timeout', 'message'].includes(response.result.status) ? { inProgress: true } : {}),
      },
    };
  } finally {
    active = false;
  }
}
async function observeHostedSubmissionsOnce(
  transport: HostedAgentTransport,
  input: unknown,
  signal: AbortSignal,
  emit: (value: unknown) => void,
  subscribe: () => HostedRunSubscription,
  previous: ReadonlyMap<string, z.infer<typeof eventSchema>>,
  board?: BoardWaitOption,
) {
  const command = hostedSubmissionWaitSchema.parse(input);
  const operations = [...new Set(command.operationIds)];
  const discovery = await transport.dispatch('capabilities', {});
  if (isNetworkPending(discovery))
    throw new ForgeError(
      'EXCHANGE_REQUEST_FAILED',
      'Observation is unavailable; retain the original selection.',
    );
  // The board rides on the first operation's existing subscription, only on servers that say so.
  const features = (discovery.result as { features?: unknown }).features;
  const boardWait = board && Array.isArray(features) && features.includes('board-wait') ? board : undefined;
  const capsuleArgs =
    Array.isArray(features) && features.includes('landing-capsules-v1') ? { capsuleProtocol: 1 } : {};
  const actor = z.object({ actor: z.string() }).parse(discovery.result).actor;
  // A reply read only in part across a deploy (Issue 71ef0a66): reported, never silent.
  let skew: ReplySkew | undefined;
  const side = () => replySkewSide(features);
  const waitStarted = Date.now();
  const cursor = new HostedSubmissionWaitCursor(transport.address, actor, operations, command.cursor);
  const canonicalOperations = new Map<string, string>();
  const current = new Map<string, z.infer<typeof eventSchema>>();
  // Input pages describe an attempt's Lane-relative outcome. They may settle
  // after that attempt was replaced, or before the canonical receipt is visible.
  // Only the current submission can end the wait; its existing subscription and
  // register-then-reread path deliver settlement without another query per wake.
  const terminal = () =>
    current.size === operations.length &&
    [...current.values()].every(e => e.submission.observation.state !== 'pending');
  // Main already took files a queued entry changes (f7539ebb): waiting cannot land it, so the wait
  // returns at once with the sync recovery. The predecessor variant keeps waiting (no action needed).
  const syncRequired = () =>
    [...current.values()].some(e => syncRequiredAdvice(e.wouldConflict, e.submission) !== undefined);
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
    if (!selected.request.finish || observed.pendingAttempt) return;
    let index: number | null = 0;
    do {
      const args = {
        projectId: transport.address.projectId,
        submissionId: selected.id,
        attemptId: selected.attemptId,
        index,
        ...capsuleArgs,
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
      if (stopped || signal.aborted) return;
      if (!page.staged) break;
      for (const entry of page.entries) {
        invariant(
          entry.submissionId === selected.id &&
            entry.operationId === selected.operationId &&
            entry.attemptId === selected.attemptId,
          'HOSTED_PROTOCOL_INVALID',
          'Input observation differs from the selected submission/attempt.',
        );
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
  };
  let changed = false,
    baseline = command.cursor == null,
    stopped = false,
    resnapshot = false;
  const redrive = landingRedriver(transport, () => stopped || Boolean(signal?.aborted));
  const publish = (operationId: string, event: z.infer<typeof eventSchema>, snapshot: boolean) => {
    const state = event.submission;
    invariant(
      state.projectId === transport.address.projectId &&
        state.operationId === (canonicalOperations.get(operationId) ?? operationId),
      'HOSTED_PROTOCOL_INVALID',
      'Submission observation differs from the selected project/operation.',
    );
    const key = `submission:${state.id}`;
    // ETA moves with the clock, without a committed queue change. It belongs in
    // the receipt but must not turn a reconnect or duplicate wake into progress.
    const hashEvent =
      event.queue && typeof event.queue === 'object'
        ? {
            ...event,
            queue: Object.fromEntries(
              Object.entries(event.queue).filter(([key]) => key !== 'eta' && key !== 'message'),
            ),
          }
        : event;
    const hash = digest(JSON.stringify(hashEvent));
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
  // The latest value of each operation's live page subscription. A wake drains from it instead of
  // reading the same page again (686ecdde: one call per wake, not two), when it is complete from the
  // cursor on; an older, partial or resnapshot value falls back to the read.
  const live = new Map<string, unknown>();
  const livePage = (operationId: string, nextVersion: number) => {
    const page = live.get(operationId) as
      | { isDone?: unknown; resnapshot?: unknown; nextVersion?: unknown; events?: unknown }
      | undefined;
    if (
      !page ||
      page.isDone !== true ||
      page.resnapshot !== false ||
      typeof page.nextVersion !== 'number' ||
      page.nextVersion < nextVersion ||
      !Array.isArray(page.events)
    )
      return undefined;
    const version = (event: unknown) =>
      (event as { submission?: { version?: unknown } } | null)?.submission?.version;
    if (!page.events.every(event => typeof version(event) === 'number')) return undefined;
    return { ...page, events: page.events.filter(event => (version(event) as number) >= nextVersion) };
  };
  const drain = async (operationId: string) => {
    for (;;) {
      if (stopped || signal.aborted) return;
      const nextVersion = cursor.versions.get(operationId) ?? 0;
      const read = parseHostedOutcome(
        pageSchema,
        stableSubmissionPageSchema,
        livePage(operationId, nextVersion) ??
          decode(await transport.query('projectHostedFinishObserve:page', { operationId, nextVersion })),
      );
      if (read.skew) skew = read.skew;
      // The stable read carries every other field as sent; authority keeps its normal form so a
      // skewed page never looks like an authority change (which would cost a resnapshot read).
      const page = (
        read.skew?.stable
          ? {
              ...read.data,
              authority: ((authority: { success: boolean; data?: unknown }) =>
                authority.success ? authority.data : read.data.authority)(
                safeParseHostedResponse(sourceAuthoritySchema, read.data.authority),
              ),
            }
          : read.data
      ) as z.infer<typeof pageSchema>;
      invariant(
        page.projectId === transport.address.projectId &&
          page.operationId === operationId &&
          page.submission.projectId === page.projectId &&
          page.submission.operationId === (page.canonicalOperationId ?? operationId),
        'HOSTED_PROTOCOL_INVALID',
        'Submission page differs from the selected project/operation.',
      );
      if (stopped || signal.aborted) return;
      redrive(page.submission);
      canonicalOperations.set(operationId, page.canonicalOperationId ?? operationId);
      const authority = JSON.stringify(page.authority);
      if (cursor.authority && cursor.authority !== authority) {
        cursor.authority = authority;
        resnapshot = true;
        // Resnapshot under fresh authority. Retained version identities remain
        // offsets only; every replay/page still rechecks access at the server.
        continue;
      }
      cursor.authority = authority;
      resnapshot ||= page.resnapshot;
      for (const event of page.events) {
        invariant(
          (page.resnapshot || event.submission.version >= nextVersion) &&
            event.submission.version < page.nextVersion,
          'HOSTED_PROTOCOL_INVALID',
          'Submission page has an invalid version range.',
        );
        cursor.versions.set(operationId, event.submission.version + 1);
        // The final page supplies the fresh canonical state and queue metadata.
        // Publish that version once below, rather than again after its retained event.
        if (!page.isDone || event.submission.version !== page.submission.version)
          publish(operationId, event, page.resnapshot);
      }
      cursor.versions.set(operationId, page.nextVersion);
      const prior = current.get(operationId) ?? previous.get(operationId);
      const suppliedAdvice =
        page.events.find(
          event =>
            event.submission.attemptId === page.submission.attemptId &&
            event.submission.version === page.submission.version &&
            Boolean(event.recovery || event.conflict),
        ) ?? (prior?.submission.attemptId === page.submission.attemptId ? prior : undefined);
      current.set(
        operationId,
        page.isDone
          ? await observedConflictRecovery(transport, {
              submission: page.submission,
              ...(page.providerDelay ? { providerDelay: page.providerDelay } : {}),
              ...((page.recovery ?? suppliedAdvice?.recovery)
                ? { recovery: page.recovery ?? suppliedAdvice?.recovery }
                : {}),
              ...((page.conflict ?? suppliedAdvice?.conflict)
                ? { conflict: page.conflict ?? suppliedAdvice?.conflict }
                : {}),
              pendingAttempt: page.pendingAttempt,
              ...(page.queue ? { queue: page.queue } : {}),
              ...(page.queueAheadSelection !== undefined
                ? { queueAheadSelection: page.queueAheadSelection }
                : {}),
              ...(page.wouldConflict ? { wouldConflict: page.wouldConflict } : {}),
              ...(page.orderWait ? { orderWait: page.orderWait } : {}),
              ...(page.reservation ? { reservation: page.reservation } : {}),
            })
          : page.events.at(-1)!,
      );
      if (page.isDone) {
        publish(operationId, current.get(operationId)!, page.resnapshot);
        if (command.until !== 'acceptance') await readInputs(operationId);
        return;
      }
      invariant(
        page.nextVersion > nextVersion,
        'HOSTED_PROTOCOL_INVALID',
        'Submission page did not advance.',
      );
    }
  };
  const result = (
    status: 'terminal' | 'changed' | 'timeout' | 'cancelled' | 'message' | 'sync-required',
    delivery?: BoardDelivery,
  ) => {
    const successful =
      terminal() && [...current.values()].every(e => e.submission.observation.state === 'landed');
    // A landed operation is the canary's waitable read (edcb0fc8): one local write, no call.
    if (successful) rememberLandedOperations(transport.address.projectId, operations);
    return resultOf(status, successful, delivery);
  };
  const resultOf = (
    status: 'terminal' | 'changed' | 'timeout' | 'cancelled' | 'message' | 'sync-required',
    successful: boolean,
    delivery?: BoardDelivery,
  ) => ({
    ...discovery,
    action: 'observe' as const,
    result: {
      status,
      successful,
      submissions: [...current.values()],
      resnapshot,
      cursor: cursor.encode() as string | null,
      ...(delivery ? { board: delivery } : {}),
      ...(skew ? { contractSkew: contractSkew(skew, side()) } : {}),
    },
  });
  let waker: ReturnType<typeof boardWaker> | undefined;
  let stop: (() => void) | undefined;
  try {
    for (const operation of operations) await drain(operation);
    if (terminal()) return result('terminal');
    if (syncRequired()) return result('sync-required');
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
            if (stopped || signal.aborted) return;
            for (const operation of operations) await drain(operation);
            if (stopped || signal.aborted) return;
            if (terminal()) resolve(result('terminal'));
            else if (syncRequired()) resolve(result('sync-required'));
            else if (!baseline && changed && command.until === 'any-change') resolve(result('changed'));
            changed = false;
          })
          .catch(reject);
      };
      wake = refresh;
      stop = () => resolve(result('cancelled'));
      signal?.addEventListener('abort', stop, { once: true });
      if (signal?.aborted) {
        stop();
        return;
      }
      if (boardWait) waker = boardWaker(boardWait, delivery => resolve(result('message', delivery)));
      // Board-only changes of the page value (a note arrived) wake the waker, never a page drain.
      let pageKey: string | undefined;
      const offer = (operationId: string, value: unknown) => {
        try {
          const decoded = decode(value);
          // The board note is the waker's; the drained page is the reply a read would return.
          if (decoded && typeof decoded === 'object') {
            const page = { ...(decoded as Record<string, unknown>) };
            delete page.board;
            if (hasLandingCapsule(page)) live.delete(operationId);
            else live.set(operationId, page);
          }
        } catch {
          /* Unreadable: the next drain reads the page itself. */
        }
      };
      const update = (value: unknown) => {
        const decoded = waker ? decode(value) : undefined;
        if (waker && decoded && typeof decoded === 'object') {
          const { board: note, ...page } = decoded as { board?: unknown };
          waker.offer({ board: note });
          const key = JSON.stringify(page);
          if (key === pageKey) return;
          pageKey = key;
        }
        refresh();
      };
      for (const [index, operationId] of operations.entries()) {
        unsubscribes.push(
          client!.onUpdate(
            makeFunctionReference<'query'>('projectHostedFinishObserve:page'),
            {
              projectId: transport.address.projectId,
              operationId,
              nextVersion: cursor.versions.get(operationId) ?? 0,
              ...capsuleArgs,
              ...(boardWait && index === 0
                ? {
                    board: { laneId: boardWait.laneId, after: boardWait.after },
                  }
                : {}),
            },
            boardWait && index === 0
              ? value => {
                  offer(operationId, value);
                  update(value);
                }
              : value => {
                  offer(operationId, value);
                  refresh();
                },
            error => reject(hostedActionError(error, 'submission observation')),
          ),
        );
      }
      refresh();
    });
  } catch (error) {
    if (error instanceof z.ZodError || error instanceof SyntaxError) {
      // Not even the stable outcome fields were readable: the landing may still have succeeded.
      const seen = [...current.values()]
        .map(entry => Date.parse(entry.submission.at))
        .filter(Number.isFinite);
      const from = new Date(Math.min(waitStarted - 3_600_000, ...seen) - 60_000).toISOString();
      throw replySkewError(
        'submission observation',
        error instanceof z.ZodError ? replyIssuePaths(error.issues) : ['reply'],
        side(),
        {
          outcome: 'The landing may have succeeded; this failed read changes nothing.',
          command: hostedRecoveryCommand(transport.root, 'landings', {
            ...transport.address,
            from,
            to: new Date(Date.now() + 60_000).toISOString(),
          }),
        },
      );
    }
    throw hostedActionError(error, 'submission observation');
  } finally {
    stopped = true;
    waker?.stop();
    if (stop) signal?.removeEventListener('abort', stop);
    try {
      for (const unsubscribe of unsubscribes) unsubscribe();
    } finally {
      await client?.close();
    }
  }
}
