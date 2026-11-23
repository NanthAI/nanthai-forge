// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { z } from 'zod';
export const guidanceInputSchema = z.object({
  operationId: z.string().uuid(),
  scope: z.enum(['project', 'personal']),
  agentGuidance: z.string().max(4000),
});
