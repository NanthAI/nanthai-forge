// SPDX-License-Identifier: Apache-2.0
import { hydrateLandingHistory, hasJournalHistory } from './landing-capsule-client.js';
import { randomUUID } from 'node:crypto';
import { ConvexError } from 'convex/values';
import { makeFunctionReference } from 'convex/server';
import type { CoordinationTransport } from './coordination-client.js';
import { ForgeError, invariant } from './errors.js';
import {
  coordinationRequestSchema,
  type CoordinationCommand,
  type CoordinationRequest,
} from './coordination-types.js';
import { compactClaim, compactEvent, type StoredEvent } from './coordination-compact.js';
import type { WatchInput } from './coordination-watch.js';

const ref = {
  query: (name: string) => makeFunctionReference<'query'>(name),
  mutation: (name: string) => makeFunctionReference<'mutation'>(name),
};
const defined = <T extends Record<string, unknown>>(value: T) =>
  Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T;

async function call<T>(work: () => Promise<unknown>): Promise<T> {
  try {
    return (await work()) as T;
  } catch (error) {
    const data =
      error instanceof ConvexError && error.data && typeof error.data === 'object'
        ? (error.data as { code?: unknown; message?: unknown })
        : null;
    if (typeof data?.code === 'string' && typeof data.message === 'string')
      throw new ForgeError(data.code, data.message);
    throw new ForgeError(
      'COORDINATION_REQUEST_FAILED',
      'The coordination request did not return success. Check current authentication/access and reconcile the original operation; no successful result is claimed.',
    );
  }
}
type Write = Extract<CoordinationRequest, { action: 'ack' | 'claim' | 'release' }>;
/** Concise write actions become ordinary publish commands; a generated operation UUID is returned for retries. */
export function conciseCommand(request: Write): CoordinationCommand {
  const sessionId = request.sessionId;
  switch (request.action) {
    case 'ack':
      return defined({
        kind: 'ack',
        sessionId,
        messageId: request.messageId,
        text: request.text,
        choice: request.choice,
      });
    case 'claim':
      return defined({
        kind: 'claim',
        sessionId,
        claimId: request.claimId,
        paths: request.paths,
        intentId: request.intentId,
        laneId: request.laneId,
        ttlSeconds: request.ttlMinutes * 60,
        note: request.note,
      });
    case 'release':
      return defined({ kind: 'release', sessionId, claimId: request.claimId });
  }
}

export async function dispatchCoordination(
  client: CoordinationTransport,
  projectId: string,
  input: unknown,
  watch?: (input: WatchInput) => Promise<unknown>,
): Promise<unknown> {
  const parsed = coordinationRequestSchema.safeParse(input);
  invariant(
    parsed.success,
    'BAD_ARGUMENT',
    'Use publish, feed, sessions, recent, inbox, related, watch, touch, ack, claim, release, unacked, claims, overlaps or counts. For a new question or hand-back, use nforge agent ROOT ask or hand-back.',
  );
  const request = parsed.data;
  const query = async (name: string, args: Record<string, unknown>) => {
    const request = { projectId, ...defined(args) };
    const value = await call<Record<string, unknown>>(async () => {
      try {
        return (await client.query(ref.query(name), request)) as Record<string, unknown>;
      } catch (error) {
        if (hasJournalHistory(error)) return error as Record<string, unknown>;
        throw error;
      }
    });
    const result = await hydrateLandingHistory(name, request, value, (action, input) => {
      invariant(
        client.action,
        'HOSTED_ACTION_UNSUPPORTED',
        'Update this coordination client to read archived history.',
      );
      return client.action(makeFunctionReference<'action'>(action), { ...input, projectId });
    });
    return (typeof result === 'string' ? JSON.parse(result) : result) as Record<string, unknown>;
  };
  const publish = (operationId: string, command: CoordinationCommand, replayOnly = false) =>
    call<StoredEvent>(() =>
      client.mutation(ref.mutation('projectCoordination:publish'), {
        projectId,
        operationId,
        command,
        ...(replayOnly ? { replayOnly: true } : {}),
      }),
    );
  switch (request.action) {
    case 'counts':
      return query('projectCoordination:counts', {});
    case 'watch': {
      invariant(watch, 'BAD_ARGUMENT', 'This transport has no live subscription.');
      const rest: WatchInput & { action?: string } = { ...request };
      delete rest.action;
      return watch(rest);
    }
    case 'publish':
      return publish(
        request.operationId,
        request.command,
        ['message', 'handoff'].includes(request.command.kind),
      );
    case 'feed':
    case 'sessions':
    case 'recent':
      return query(`projectCoordination:${request.action}`, {
        paginationOpts: { cursor: request.cursor, numItems: request.pageSize },
        ...(request.action === 'feed'
          ? { intentId: request.intentId, laneId: request.laneId, planningItemId: request.planningItemId }
          : {}),
        ...(request.action === 'sessions'
          ? defined({ parentSessionId: request.parentSessionId, all: request.all })
          : {}),
      });
    case 'touch':
      return call(() =>
        client.mutation(ref.mutation('projectCoordination:touch'), {
          projectId,
          sessionId: request.sessionId,
          ...(request.activityKind ? { activityKind: request.activityKind } : {}),
        }),
      );
    case 'inbox':
    case 'related': {
      const { action, cursor, pageSize, ...scope } = request;
      const page = await query(`projectCoordinationReads:${action}`, {
        paginationOpts: { cursor, numItems: pageSize },
        ...scope,
      });
      return defined({
        items: (page.page as StoredEvent[]).map(compactEvent),
        cursor: page.continueCursor,
        isDone: page.isDone,
        cursorReset: page.cursorReset || undefined,
        scope: page.scope,
      });
    }
    case 'unacked': {
      const result = await query('projectCoordinationReads:unacked', {
        sessionId: request.sessionId,
        limit: request.limit,
      });
      return { items: (result.items as StoredEvent[]).map(compactEvent), complete: result.complete };
    }
    case 'claims': {
      const result = await query('projectCoordinationReads:claims', {});
      return {
        claims: (result.claims as Parameters<typeof compactClaim>[0][]).map(compactClaim),
        complete: result.complete,
      };
    }
    case 'overlaps':
      return overlaps(query, request.paths, request.includeMine);
    default: {
      const operationId = request.operationId ?? randomUUID();
      const event = await publish(operationId, conciseCommand(request));
      const receipt = { operationId, kind: event.command.kind, at: event.at };
      if (request.action !== 'claim') return receipt;
      const claimId = request.claimId ?? operationId;
      return {
        ...receipt,
        claimId,
        expiresAt: event.at + request.ttlMinutes * 60_000,
        ...(await overlaps(query, request.paths)),
      };
    }
  }
}
async function overlaps(
  query: (name: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>,
  paths: string[],
  includeMine?: boolean,
) {
  const result = await query('projectCoordinationReads:overlaps', { paths, includeMine });
  return {
    overlaps: (result.overlaps as (Parameters<typeof compactClaim>[0] & { overlapping: string[] })[]).map(
      item => ({ ...compactClaim(item), overlapping: item.overlapping }),
    ),
    complete: result.complete as boolean,
  };
}
