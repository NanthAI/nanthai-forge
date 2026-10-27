// SPDX-License-Identifier: Apache-2.0
import type { StreamProgress } from './projectCheckLogCleanupStream';
import { makeFunctionReference } from 'convex/server';
import type { Id, Doc } from './_generated/dataModel';
export type Identity = { projectId: Id<'hostedProjects'>; actor: string; operationId: string };
export type Node = {
  key: string;
  candidate?: boolean;
  protected?: boolean;
  state?: boolean;
  tree?: { sha256: string; size: number; height: number };
  children?: string[];
};
export const reviewParts = ['objects', 'logs', 'shared', 'archives', 'hostedOutputs', 'digests'] as const;
export type Part = (typeof reviewParts)[number];
export type PlanState = {
  version: 2;
  automatic?: boolean;
  guard: string;
  now: number;
  phase: string;
  step: number;
  cursor: string | null;
  fileOffset: number;
  selected?: Doc<'projectBackups'> | Doc<'projectProposals'>;
  counts: Record<Part, number>;
  bytes: number;
  planDigest: string;
  recipeCount: number;
  recipeOffset: number;
  sourceOffset?: number;
  sourceParts?: number;
  queueCount: number;
  queueOffset: number;
  treeCount: number;
  treeOffset: number;
  offset: number;
  outputOffset: number;
  stream?: StreamProgress;
};
export type PlanWrite = { part: string; position: number; value: string };
export const readRef = makeFunctionReference<'query'>('projectCheckLogCleanupStore:planRead');
export const stepRef = makeFunctionReference<'mutation'>('projectCheckLogCleanupStore:planStep');
export const beginRef = makeFunctionReference<'mutation'>('projectCheckLogCleanupStore:planBegin');
export const lookupRef = makeFunctionReference<'query'>('projectCheckLogCleanupStore:planLookup');
export const nodesRef = makeFunctionReference<'query'>('projectCheckLogCleanupStore:planNodes');

export const queueRef = makeFunctionReference<'query'>('projectCheckLogCleanupStore:planQueue');

export const sourcesRef = makeFunctionReference<'query'>('projectCheckLogCleanupStore:planSources');
