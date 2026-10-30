// SPDX-License-Identifier: Apache-2.0
'use node';
import { makeFunctionReference } from 'convex/server';
import type { Doc, Id } from './_generated/dataModel';
import type { IndexEntry } from '../src/work-hosted-index';
import type { WorkView } from '../src/work-types';
import type { recordExchange } from './projectWorkRecordExchange';
export type Identity = { projectId: Id<'hostedProjects'>; owner: string };
export type Selected = Identity & { generationId: Id<'projectWorkGenerations'> };
export const resume = makeFunctionReference<'query', Identity, Doc<'projectWorkGenerations'> | null>(
  'projectWorkIndexBuildStore:resume',
);
export const rowsRef = makeFunctionReference<
  'query',
  Selected & { collection: string; parent?: string; offset?: number; last?: boolean },
  IndexEntry[]
>('projectWorkIndexBuildStore:rows');
export type RowRequest = { collection: string; parent?: string; offset?: number; last?: boolean };
export const rowBatchRef = makeFunctionReference<
  'query',
  Selected & { requests: RowRequest[] },
  IndexEntry[][]
>('projectWorkIndexBuildStore:rowBatch');
export const lookupRef = makeFunctionReference<
  'query',
  Selected & { collection: string; key: string },
  IndexEntry | null
>('projectWorkIndexBuildStore:lookup');
export const lookupsRef = makeFunctionReference<
  'query',
  Selected & { keys: { collection: string; key: string }[] },
  (IndexEntry | null)[]
>('projectWorkIndexBuildStore:lookups');
export const putPageRef = makeFunctionReference<
  'mutation',
  Selected & { key: string; position: number; body: string },
  null
>('projectWorkIndexBuildStore:putPage');
export const readPageRef = makeFunctionReference<
  'query',
  Selected & { key: string; position: number },
  string
>('projectWorkIndexBuildStore:readPage');
export const stepRef = makeFunctionReference<
  'mutation',
  Selected & {
    expected?: string;
    cursor: string;
    entries: IndexEntry[];
    metadata?: string;
    cleanup?: string;
  },
  Doc<'projectWorkGenerations'> | null
>('projectWorkIndexBuildStore:step');
export type Cursor = {
  phase:
    | 'settings'
    | 'records'
    | 'parents'
    | 'summaries'
    | 'trees'
    | 'blobs'
    | 'journal'
    | 'cleanup'
    | 'done';
  field: number;
  record: number;
  source: number;
  cleanup?: number;
  filesTotal?: number;
  journalCursor?: string | null;
  replayRevision?: number;
  output?: { key: string; part: number; parts: number; after: Omit<Cursor, 'output'>; metadata?: string };
};
export type Exchange = NonNullable<Awaited<ReturnType<typeof recordExchange>>>;
export const scratch = [
  '_buildSource',
  '_buildFamily',
  '_buildSubmission',
  '_buildLocalAcceptance',
  '_buildHostedAcceptance',
  '_buildLocalAcceptance:payload',
  '_buildHostedAcceptance:payload',
  '_pages',
];
export const fields: Record<string, string[]> = {
  intents: ['intents', 'notes', 'lifecycle', 'intentAuthorities', 'githubRepositories'],
  landingEntries: ['landingEntries'],
  landingBatches: ['landingBatches'],
  initiatives: ['initiatives'],
  intentAliases: ['intentAliases'],
  automaticActions: ['automaticActions'],
  policyChanges: ['policyChanges'],
  lanes: ['lanes', 'checkpoints'],
  views: ['views'],
  checks: ['checks'],
  runs: ['runs'],
  planningItems: ['planningItems', 'planningVersions'],
  planningComments: ['planningComments'],
  channelMoves: ['channelMoves'],
  hostedChannelMoves: ['hostedChannelMoves'],
  hostedEvents: ['events'],
};
export const family = (view: WorkView) =>
  JSON.stringify([view.intentId, view.inputs.map(i => i.laneId).sort()]);
