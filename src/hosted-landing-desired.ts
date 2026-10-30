// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { hostedLandingRequestSchema } from './hosted-landing.js';
export const hostedLandingDesiredSchema = hostedLandingRequestSchema
  .pick({
    governanceVersion: true,
    operationId: true,
    authorityEpoch: true,
    check: true,
    keepOpen: true,
    priority: true,
  })
  .extend({ composeOperationId: z.uuid(), after: z.uuid().nullable().default(null) })
  .strict();
