// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { sourceAuthoritySchema } from './hosted-source-authority.js';
import { hostedMainV2Schema } from './hosted-main.js';

const revision = z.number().safe().nonnegative();
export const cutoverPinsSchema = z
  .object({
    authority: sourceAuthoritySchema,
    main: hostedMainV2Schema,
    backupId: z.string().min(1),
    backupDigest: z.string().regex(/^[a-f0-9]{64}$/),
    projectRevision: revision,
    journalRevision: revision,
    ownerRevision: revision,
  })
  .strict();
export const cutoverRequestSchema = z
  .object({
    operationId: z.uuid(),
    mode: z.enum(['server', 'native-owner']),
    pins: cutoverPinsSchema,
  })
  .strict();
export type CutoverRequest = z.infer<typeof cutoverRequestSchema>;
