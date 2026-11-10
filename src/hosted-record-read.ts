// SPDX-License-Identifier: Apache-2.0
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
    collection: z.enum(
      Object.keys(recordCollectionKinds) as [
        keyof typeof recordCollectionKinds,
        ...Array<keyof typeof recordCollectionKinds>,
      ],
    ),
    parentId: z.string().min(1).optional(),
    status: z.string().min(1).optional(),
    id: z.uuid().optional(),
    version: z.number().int().nonnegative().safe().optional(),
    cursor: z.string().nullable().default(null),
  })
  .strict()
  .refine(value => !(value.parentId && value.status), 'Choose parentId or status.')
  .refine(value => value.version === undefined || value.id, 'A version needs id.')
  .refine(
    value => !value.id || (!value.parentId && !value.status && value.cursor === null),
    'Choose id or page filters.',
  );
