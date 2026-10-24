// SPDX-License-Identifier: Apache-2.0
'use node';
import { createHash } from 'node:crypto';
import type { ActionCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { readReturnJson } from './projectSourceReturnCursor';
import { storeReturnMetadata, readReturnMetadata, type MetadataRef } from './projectSourceReturnMetadata';
import { jsonChunks } from '../src/json-chunks';
import { intentHeader, indexedRecord, type IndexEntry } from '../src/work-hosted-index';
import type { WorkData } from '../src/work-types';
import { validateWorkSize } from '../src/work-metadata';
export const RECORD_BUDGET = { bytes: 64 * 1024, pages: 32 };
export type IntentRecords = {
  refs: { ref: MetadataRef; ids: string[] }[];
  digest: string;
  projected?: number;
  positions?: { intents: number; notes: number; lifecycle: number; authorities: number };
  repositories?: string[];
  defaultIntentId?: string;
  output?: MetadataRef[];
  counts?: Record<string, number>;
};
type Candidate = Awaited<ReturnType<typeof import('./projectWorkLoad').source>>;
/** Upgrade legacy durable snapshots while decoding. Only one bounded Intent
 * page and compact relationship headers survive the parser's read window. */
export async function readCandidateRecords(
  ctx: ActionCtx,
  projectId: Id<'hostedProjects'>,
  owner: string,
  partitionId: Id<'projectWorkGenerations'>,
  id: Id<'_storage'>,
) {
  const refs: IntentRecords['refs'] = [],
    context: WorkData['intents'] = [];
  const bases = new Set<string>(),
    seen = new Set<string>(),
    contextIds = new Set<string>();
  let lastIntent: string | undefined, activeIntent: string | undefined;
  let batch: WorkData['intents'] = [],
    bytes = 0;
  async function flush() {
    if (!batch.length) return;
    refs.push({
      ref: await storeReturnMetadata(ctx, projectId, owner, partitionId, batch),
      ids: batch.map(i => i.id),
    });
    batch = [];
    bytes = 0;
  }
  const hash = createHash('sha256');
  hash.update('{');
  let fields = 0,
    intentCount = 0;
  function field(key: string) {
    hash.update(`${fields++ ? ',' : ''}\n  ${JSON.stringify(key)}: `);
  }
  function encode(value: unknown, indent: number) {
    const padding = ' '.repeat(indent);
    for (const part of jsonChunks(value, 2)) hash.update(part.replaceAll('\n', `\n${padding}`));
  }
  const candidate = await readReturnJson<Candidate>(
    ctx,
    id,
    'The original prepared candidate is unavailable.',
    {
      descend: path =>
        path.length === 0 ||
        (path[0] === 'data' && (path.length === 1 || (path.length === 2 && path[1] === 'intents'))),
      select: path =>
        path[0] === 'data' && (path.length === 2 || (path.length === 3 && path[1] === 'intents')),
      value: async (value, path) => {
        if (path.length === 2) {
          if (path[1] !== 'intents') {
            field(String(path[1]));
            encode(value, 2);
            return value;
          }
          if (!intentCount) {
            field('intents');
            hash.update('[]');
          } else hash.update('\n  ]');
          return context;
        }
        const intent = value as WorkData['intents'][number],
          size = Buffer.byteLength(JSON.stringify(intent));
        if (!intentCount) {
          field('intents');
          hash.update('[');
        }
        hash.update(`${intentCount++ ? ',' : ''}\n    `);
        // Native JSON encoding avoids a generator/object allocation per scalar
        // for small records. Indivisible large records retain streamed encoding.
        if (size <= 256 * 1024) hash.update(JSON.stringify(intent, null, 2).replaceAll('\n', '\n    '));
        else encode(intent, 4);
        if (batch.length && bytes + size > RECORD_BUDGET.bytes) await flush();
        batch.push(intent);
        bytes += size;
        lastIntent = intent.id;
        if (intent.status === 'active') activeIntent = intent.id;
        // Source membership needs distinct bases and exact PR observations, not
        // one header per retained Intent. First-ID lookup semantics stay intact.
        if (intent.external) {
          // All observations contribute source membership, even on duplicate
          // IDs. A first plain record still wins dependency lookup over a later
          // duplicate carrying PR data.
          if (seen.has(intent.id) && !contextIds.has(intent.id))
            context.push({ id: intent.id } as WorkData['intents'][number]);
          context.push({ ...intentHeader(intent), external: intent.external } as WorkData['intents'][number]);
          contextIds.add(intent.id);
        } else if (intent.base && !bases.has(intent.base)) {
          context.push(intentHeader(intent) as WorkData['intents'][number]);
          contextIds.add(intent.id);
        }
        if (intent.base) bases.add(intent.base);
        seen.add(intent.id);
        return null;
      },
    },
  );
  await flush();
  // Hash the exact parsed Work in property/record order as it is decoded.
  // There is no second payload read or reconstructed complete collection.
  hash.update(fields ? '\n}' : '}');
  const digest = hash.digest('hex');
  return { candidate, records: { refs, digest, defaultIntentId: activeIntent ?? lastIntent } };
}
export async function hydrateIntents(
  ctx: ActionCtx,
  projectId: Id<'hostedProjects'>,
  owner: string,
  records: IntentRecords,
  ids: ReadonlySet<string>,
) {
  const found = new Map<string, WorkData['intents'][number]>();
  for (const { ref, ids: keys } of records.refs) {
    if (!keys.some(id => ids.has(id) && !found.has(id))) continue;
    for (const intent of await readReturnMetadata<WorkData['intents']>(ctx, projectId, owner, ref))
      if (ids.has(intent.id) && !found.has(intent.id)) found.set(intent.id, intent);
  }
  return [...found.values()];
}
/** Schema validation and payload projection consume one durable page at a time. */
export async function projectIntentRecords(
  ctx: ActionCtx,
  projectId: Id<'hostedProjects'>,
  owner: string,
  records: IntentRecords,
  skeleton: WorkData,
  emit: (rows: Iterable<IndexEntry>) => Promise<void>,
) {
  const positions = (records.positions ??= { intents: 0, notes: 0, lifecycle: 0, authorities: 0 });
  const empty = Object.fromEntries(
    Object.entries(skeleton).map(([key, value]) => [key, Array.isArray(value) ? [] : value]),
  ) as unknown as WorkData;
  const end = Math.min(records.refs.length, (records.projected ?? 0) + RECORD_BUDGET.pages);
  for (const { ref } of records.refs.slice(records.projected ?? 0, end)) {
    const intents = await readReturnMetadata<WorkData['intents']>(ctx, projectId, owner, ref);
    validateWorkSize({ ...empty, intents });
    function* rows() {
      for (const intent of intents) {
        const header = intentHeader(intent),
          attributes = { ...intent, notes: [], ...(intent.lifecycle ? { lifecycle: [] } : {}) };
        yield* indexedRecord(
          'intents',
          intent.id,
          '',
          positions.intents++,
          Object.keys(attributes).some(k => !Object.hasOwn(header, k)) ? attributes : header,
          header,
        );
        const accounts = intent as typeof intent & {
          creatorAccountId?: string;
          assigneeAccountIds?: string[];
        };
        for (const accountId of new Set([
          ...(accounts.creatorAccountId ? [accounts.creatorAccountId] : []),
          ...(accounts.assigneeAccountIds ?? []),
        ]))
          yield* indexedRecord(
            'intentAuthorities',
            `${intent.id}:${accountId}`,
            intent.id,
            positions.authorities++,
            { intentId: intent.id, accountId },
          );
        if (intent.external && !(records.repositories ??= []).includes(intent.external.repository)) {
          const repository = intent.external.repository;
          yield* indexedRecord('githubRepositories', repository, '', records.repositories.length, {
            id: repository,
            repository,
          });
          records.repositories.push(repository);
        }
        for (const [index, note] of intent.notes.entries())
          yield* indexedRecord('notes', `${intent.id}:${index}`, intent.id, positions.notes++, {
            ...note,
            intentId: intent.id,
            index,
          });
        for (const [index, entry] of (intent.lifecycle ?? []).entries())
          yield* indexedRecord('lifecycle', `${intent.id}:${index}`, intent.id, positions.lifecycle++, {
            ...entry,
            intentId: intent.id,
            index,
          });
      }
    }
    await emit(rows());
  }
  records.projected = end;
}
