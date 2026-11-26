// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { z } from 'zod';
import type { HostedRecordKind } from './hosted-records.js';

export const recordCollectionKinds = {
  intents: 'intent',
  lanes: 'lane',
  saves: 'save',
  candidates: 'candidate',
  jobs: 'job',
  issues: 'issue',
  comments: 'comment',
  lifecycle: 'lifecycle',
} as const satisfies Record<string, HostedRecordKind>;
export const hostedRecordsReadSchema = z
  .object({
    collection: z.enum([
      ...(Object.keys(recordCollectionKinds) as Array<keyof typeof recordCollectionKinds>),
      'landing-attempts',
      'retained-landing-attempts',
    ] as const),
    parentId: z.string().min(1).optional(),
    status: z.string().min(1).optional(),
    id: z.uuid().optional(),
    version: z.number().int().nonnegative().safe().optional(),
    cursor: z.string().nullable().default(null),
  })
  .strict()
  .refine(
    value =>
      (value.collection !== 'landing-attempts' && value.collection !== 'retained-landing-attempts') ||
      (value.status === undefined &&
        value.version === undefined &&
        (value.collection === 'landing-attempts' || value.id === undefined)),
    'Select landing attempts by attempt id, submission parentId, or project page.',
  )
  .refine(value => !(value.parentId && value.status), 'Choose parentId or status.')
  .refine(value => value.version === undefined || value.id, 'A version needs id.')
  .refine(
    value => !value.id || (!value.parentId && !value.status && value.cursor === null),
    'Choose id or page filters.',
  );
