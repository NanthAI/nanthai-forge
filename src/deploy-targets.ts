// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { z } from 'zod';

export const deployTargetName = z.string().regex(/^(?!all$)[a-z0-9][a-z0-9_-]{0,63}$/);
export const deployTargetSchema = z.strictObject({
  name: deployTargetName,
  label: z.string().trim().min(1),
  environment: z.string().trim().min(1),
  triggerPaths: z.array(z.string().min(1)).optional(),
  githubActions: z
    .strictObject({
      workflow: z.string().regex(/^[A-Za-z0-9_-][A-Za-z0-9_.-]*\.ya?ml$/),
      minimumIntervalMs: z.number().int().nonnegative().optional(),
    })
    .optional(),
});
export type DeployTarget = z.infer<typeof deployTargetSchema>;

export const deploySettingsSchema = z.strictObject({
  targets: z
    .array(deployTargetSchema)
    .refine(
      targets => new Set(targets.map(target => target.name)).size === targets.length,
      'Deploy target names must be unique.',
    ),
  /** Omit to use the automatic one-hour threshold. */
  needsAttentionAfterMinutes: z.number().int().positive().optional(),
});
export const DEFAULT_DEPLOY_ATTENTION_MINUTES = 60;
