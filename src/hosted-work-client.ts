import { rebuildWorkIndex } from './work-index-client.js';
// SPDX-License-Identifier: Apache-2.0
import { hostedActionError } from './hosted-action-error.js';
import { SourceAuthorityStaleError } from './hosted-source-authority.js';
import { assembleIndexValue } from './work-index-value.js';
import { policyWriteSchema } from './autonomy-policy.js';
import { ConvexError } from 'convex/values';
import { makeFunctionReference, type FunctionReference } from 'convex/server';
import { z } from 'zod';
import { ForgeError, invariant } from './errors.js';
export const hostedWorkRequestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('policy') }).strict(),
  policyWriteSchema,
  z.object({ action: z.literal('workspace') }).strict(),
  z.object({ action: z.literal('rebuild-index') }).strict(),
  z.object({ action: z.literal('migrate-record-details'), operationId: z.uuid() }).strict(),
  z
    .object({
      action: z.literal('records'),
      collection: z.string().min(1),
      parentId: z.string().optional(),
      generationId: z.string().optional(),
      cursor: z.string().nullable().default(null),
      pageSize: z.number().int().positive().default(50),
    })
    .strict(),
  z
    .object({
      action: z.literal('detail'),
      collection: z.string().min(1),
      id: z.string().min(1),
      generationId: z.string().optional(),
    })
    .strict(),
]);
export interface HostedWorkTransport {
  query(reference: FunctionReference<'query'>, args: Record<string, unknown>): Promise<unknown>;
  mutation?(reference: FunctionReference<'mutation'>, args: Record<string, unknown>): Promise<unknown>;
  action(reference: FunctionReference<'action'>, args: Record<string, unknown>): Promise<unknown>;
}
type Workspace = {
  generationId: string;
  backupId: string;
  revision: number;
  sourceRevision?: number;
  [key: string]: unknown;
};
type Page = {
  generationId: string | null;
  revision: number | null;
  page: { id: string; position: number; value: string }[];
  isDone: boolean;
  continueCursor: string;
};
type Detail = {
  generationId: string | null;
  revision: number | null;
  value: string | null;
  editable: boolean;
  intentPin: string | null;
};
const cursorPrefix = 'forge-hosted-work-v1:';
const reference = (name: string) => makeFunctionReference<'query'>(`projectWorkIndex:${name}`);
async function workspace(client: HostedWorkTransport, projectId: string): Promise<Workspace> {
  const value = await client.query(reference('workspace'), { projectId });
  invariant(
    typeof value === 'string',
    'PROJECT_WORK_INDEX_MISSING',
    'The Work index is unavailable. Run hosted-work with action rebuild-index explicitly.',
  );
  return JSON.parse(value) as Workspace;
}
/** Hydrates this selected record only; Intent notes/lifecycle remain separately paged histories. */
export async function readIndexedWorkDetail(
  client: Pick<HostedWorkTransport, 'query'>,
  args: { projectId: string; generationId: string; collection: string; id: string; sourceRevision?: number },
) {
  const { sourceRevision, ...selection } = args;
  while (true) {
    const result = (await client.query(reference('detail'), selection)) as Detail;
    invariant(
      result.generationId === args.generationId &&
        (sourceRevision === undefined || result.revision === sourceRevision),
      'WORK_STALE',
      'Hosted source changed. Read its current workspace before continuing.',
    );
    if (!result.value) return { ...result, value: null };
    const header = JSON.parse(result.value) as Record<string, unknown>;
    if (!header.payloadKey)
      return { ...result, value: header, intentPin: result.intentPin ? JSON.parse(result.intentPin) : null };
    let cursor: string | null = null;
    const chunks: Page['page'] = [];
    do {
      const page = (await client.query(reference('records'), {
        projectId: args.projectId,
        generationId: args.generationId,
        collection: `${args.collection}:payload`,
        parentId: header.payloadKey,
        paginationOpts: { cursor, numItems: 50 },
      })) as Page;
      invariant(
        page.generationId === args.generationId,
        'WORK_STALE',
        'Hosted source changed while reading this record.',
      );
      chunks.push(...page.page);
      cursor = page.isDone ? null : page.continueCursor;
    } while (cursor !== null);
    const latest = (await client.query(reference('detail'), selection)) as Detail;
    invariant(
      latest.generationId === args.generationId,
      'WORK_STALE',
      'Hosted source changed while reading this record.',
    );
    if (latest.value !== result.value || latest.revision !== result.revision) continue;
    chunks.sort((a, b) => a.position - b.position);
    const value = assembleIndexValue(args.collection, header, chunks, {
      overlayLocalObservation: true,
      incomplete: () => {
        throw new ForgeError('INVALID_WORK_JOURNAL', 'Indexed record payload coverage is incomplete.');
      },
    });
    return { ...latest, value, intentPin: latest.intentPin ? JSON.parse(latest.intentPin) : null };
  }
}
export async function dispatchHostedWork(
  client: HostedWorkTransport,
  projectId: string,
  input: unknown,
  progress?: (line: string) => void,
): Promise<unknown> {
  const parsed = hostedWorkRequestSchema.safeParse(input);
  invariant(
    parsed.success,
    'BAD_ARGUMENT',
    'Use workspace, records, detail, policy, set-policy, rebuild-index or migrate-record-details.',
  );
  try {
    const request = parsed.data;
    if (request.action === 'rebuild-index') {
      await rebuildWorkIndex(client, projectId);
      return await workspace(client, projectId);
    }
    if (request.action === 'migrate-record-details') {
      let result: { complete: boolean };
      do {
        result = JSON.parse(
          (await client.action(makeFunctionReference('projectWorkDetailMigrationActions:step'), {
            projectId,
            operationId: request.operationId,
          })) as string,
        );
        progress?.(
          `Work detail migration ${request.operationId}: ${result.complete ? 'completed' : 'page saved'}.`,
        );
      } while (!result.complete);
      return result;
    }

    if (request.action === 'policy')
      return await client.query(makeFunctionReference('projectAutonomy:read'), { projectId });
    if (request.action === 'set-policy') {
      invariant(client.mutation, 'UNSUPPORTED', 'This transport needs hosted mutations for set-policy.');
      return await client.mutation(makeFunctionReference('projectAutonomy:set'), {
        projectId,
        command: JSON.stringify(request),
      });
    }
    const current = await workspace(client, projectId);
    if (request.action === 'workspace') return current;
    invariant(
      !request.generationId || request.generationId === current.generationId,
      'WORK_STALE',
      'The selected source generation changed. Start a fresh page from its current workspace.',
    );
    if (request.action === 'detail') {
      const selected = await readIndexedWorkDetail(client, {
        projectId,
        generationId: current.generationId,
        ...(current.sourceRevision === undefined ? {} : { sourceRevision: current.sourceRevision }),
        collection: request.collection,
        id: request.id,
      });
      const row = selected.value as { detailRef?: unknown; resultRef?: unknown } | null;
      if (
        (request.collection === 'runs' && row?.detailRef) ||
        (request.collection === 'automaticActions' && row?.resultRef)
      ) {
        const value = await client.action(makeFunctionReference('projectWorkRecordDetails:detail'), {
          projectId,
          generationId: current.generationId,
          collection: request.collection,
          id: request.id,
        });
        return { ...selected, value: JSON.parse(value as string) };
      }
      return selected;
    }
    let cursor = request.cursor;
    if (cursor?.startsWith(cursorPrefix)) {
      let binding;
      try {
        binding = JSON.parse(cursor.slice(cursorPrefix.length)) as {
          projectId: string;
          generationId: string;
          sourceRevision?: number;
          collection: string;
          parentId?: string;
          cursor: string;
        };
      } catch {
        throw new ForgeError('BAD_ARGUMENT', 'Use the original returned Work page cursor.');
      }
      invariant(
        binding.projectId === projectId &&
          binding.collection === request.collection &&
          binding.parentId === request.parentId,
        'BAD_ARGUMENT',
        'Use this project and collection’s original page cursor.',
      );
      invariant(
        binding.generationId === current.generationId && binding.sourceRevision === current.sourceRevision,
        'WORK_STALE',
        'Hosted source changed since this page. Start a fresh page from the current workspace.',
      );
      cursor = binding.cursor;
    } else
      invariant(
        cursor === null || request.generationId,
        'BAD_ARGUMENT',
        'Use the returned page cursor, or provide the original generationId with a raw server cursor.',
      );
    const page = (await client.query(reference('records'), {
      projectId,
      generationId: current.generationId,
      collection: request.collection,
      ...(request.parentId !== undefined ? { parentId: request.parentId } : {}),
      paginationOpts: { cursor, numItems: request.pageSize },
    })) as Page;
    invariant(
      page.generationId === current.generationId &&
        (current.sourceRevision === undefined || page.revision === current.sourceRevision),
      'WORK_STALE',
      'Hosted source changed while reading this page.',
    );
    return {
      ...page,
      continueCursor:
        cursorPrefix +
        JSON.stringify({
          projectId,
          generationId: current.generationId,
          sourceRevision: current.sourceRevision,
          collection: request.collection,
          ...(request.parentId !== undefined ? { parentId: request.parentId } : {}),
          cursor: page.continueCursor,
        }),
      page: page.page.map(row => ({
        ...row,
        value: request.collection.endsWith(':payload') ? row.value : JSON.parse(row.value),
      })),
    };
  } catch (error) {
    if (error instanceof ForgeError) throw error;
    const authorityFailure = hostedActionError(error, 'hosted Work');
    if (authorityFailure instanceof SourceAuthorityStaleError) throw authorityFailure;
    const data =
      error instanceof ConvexError && error.data && typeof error.data === 'object'
        ? (error.data as { code?: unknown; message?: unknown })
        : null;
    if (typeof data?.code === 'string' && typeof data.message === 'string')
      throw new ForgeError(data.code, data.message);
    throw new ForgeError(
      'HOSTED_WORK_REQUEST_FAILED',
      'The hosted Work request did not return success. Check current authentication/access; no successful result is claimed.',
    );
  }
}
