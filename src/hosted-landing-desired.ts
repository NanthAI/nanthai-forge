// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { z } from 'zod';
import { hostedLandingRequestSchema } from './hosted-landing.js';
export const hostedLandingDesiredSchema = hostedLandingRequestSchema
  .pick({
    authorship: true,
    governanceVersion: true,
    operationId: true,
    authorityEpoch: true,
    check: true,
    keepOpen: true,
    closes: true,
    message: true,
    notVerified: true,
    outside: true,
    priority: true,
    retryReason: true,
    revertOf: true,
  })
  .extend({ composeOperationId: z.uuid(), after: z.uuid().nullable().default(null) })
  .strict();
