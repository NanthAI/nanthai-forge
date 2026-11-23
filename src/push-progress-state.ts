// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Validators retain readability of historic local transport sidecars only.
import { z } from 'zod';
export const pushProgressSchema = z.object({
  projectId: z.string(),
  deployment: z.string(),
  operationId: z.string().optional(),
  worker: z.object({ pid: z.number(), startTime: z.string() }),
  phase: z.string(),
  lastProgressAt: z.number(),
});
