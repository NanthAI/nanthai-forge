// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
const id = z.string().uuid(),
  sha = z.string().regex(/^[0-9a-f]{64}$/),
  git = z.string().regex(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/);
export const historicalWorkSchema = z.object({
  id,
  request: sha,
  name: z.string().trim().min(1),
  at: z.string(),
  archive: z.object({ sha256: sha, size: z.number().safe().nonnegative() }),
  original: z.object({
    head: git,
    revision: z.number().int().nonnegative(),
    manifestSha256: sha,
    workSha256: sha,
  }),
  destination: z.object({ head: sha, acceptanceId: id }),
  provenance: z.literal('original-git-work-archive'),
  coverage: z.string(),
  unavailable: z.array(z.string()),
});
export const historicalCollections = [
  'landingEntries',
  'landingBatches',
  'intents',
  'lanes',
  'views',
  'checks',
  'runs',
  'reviews',
  'githubChecks',
  'playbooks',
  'playbookRuns',
  'automations',
  'githubDiscussions',
  'channelMoves',
  'invariants',
  'planningItems',
  'planningComments',
  'releases',
  'deployments',
  'environmentMoves',
  'publications',
  'mirrors',
  'hostedEvents',
  'hostedChannelMoves',
] as const;
export const historicalCommandSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('import-work-history'),
    operationId: id,
    path: z.string().min(1),
    sha256: sha,
    name: z.string().trim().min(1),
    acceptanceId: id,
    expectedHead: sha,
  }),
  z.object({
    action: z.literal('read-work-history-record'),
    id,
    collection: z.enum(historicalCollections),
    recordId: id.optional(),
  }),
  z.object({
    action: z.literal('list-work-history-files'),
    id,
    offset: z.number().int().nonnegative().default(0),
    limit: z.number().int().min(1).max(200).default(50),
  }),
  z.object({
    action: z.literal('read-work-history-file'),
    id,
    path: z.string().min(1),
    offset: z.number().int().nonnegative().default(0),
    bytes: z.number().int().min(1).max(65536).default(16384),
  }),
  z.object({ action: z.literal('export-work-history'), id }),
]);
export type HistoricalWork = z.infer<typeof historicalWorkSchema>;
export type HistoricalCommand = z.infer<typeof historicalCommandSchema>;
