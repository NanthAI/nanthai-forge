// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { z } from 'zod';
import { declaredInputSchema } from './work-input-types.js';
import { docsPathsSchema, globalRiskPathsSchema } from './docs-paths.js';
import { safeRelative } from './safe-relative.js';
import { actionsCacheSchema, actionsToolchainsSchema } from './actions-toolchains.js';

const id = z.string().uuid();
const oid = z.string().regex(/^[0-9a-f]{40,64}$/);
const artifactPaths = z.array(
  z
    .string()
    .refine(
      path => safeRelative(path) && !path.toLowerCase().split('/').includes('.git'),
      'Select relative build-output file paths.',
    ),
);
const checkEnvNames = z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/));
/** Optional fixed Actions supervisor preparation; never a verdict or source hook. */
const checkActions = z
  .object({
    setup: z.object({ executable: z.string().trim().min(1), args: z.array(z.string()).default([]) }).strict(),
  })
  .strict();
/** Pinned Actions workflow steps (src/actions-toolchains.ts). Sibling fields, not under `actions`,
 * so released CLIs that require `actions.setup` keep parsing every check reply. */
const actionsDeclarationFields = {
  actionsToolchains: actionsToolchainsSchema.optional(),
  actionsCache: actionsCacheSchema.optional(),
};
/** A configured command's selection contract (docs/workflows.md#check-command-scope).
 * `scope`: the command reads the changed-paths file and may run less than everything; Forge
 * counts its reduced run as scoped evidence, never as full. `shards`: the command runs one
 * `FORGE_CHECK_SHARD` part per job. Absent: the command runs in full in one job. */
export const checkSelectionDeclaration = z
  .object({
    scope: z.literal('changed-paths').optional(),
    shards: z.number().int().min(2).max(20).optional(),
  })
  .strict()
  .refine(value => value.scope !== undefined || value.shards !== undefined, 'Declare scope or shards.');
export const checkSchema = z.object({
  id,
  name: z.string().trim().min(1),
  executable: z.string().trim().min(1),
  args: z.array(z.string()),
  environmentLabel: z.string(),
  env: checkEnvNames.optional(),
  credentials: checkEnvNames.optional(),
  artifactPaths: artifactPaths.optional(),
  static: z.boolean().optional(),
  measureResources: z.boolean().optional(),
  declaredInputs: z.array(declaredInputSchema).optional(),
  actions: checkActions.optional(),
  selection: checkSelectionDeclaration.optional(),
  docsPaths: docsPathsSchema.optional(),
  globalRiskPaths: globalRiskPathsSchema.optional(),
  /** false: checks keep submodule pointers instead of fetching their pinned trees. */
  submodules: z.boolean().optional(),
  ...actionsDeclarationFields,
  definition: oid,
  at: z.string(),
});
export const defineCheckCommandSchema = z.object({
  action: z.literal('define-check'),
  checkId: id.optional(),
  name: z.string().trim().min(1),
  executable: z.string().trim().min(1),
  args: z.array(z.string()).default([]),
  environmentLabel: z.string().default(''),
  env: checkEnvNames.optional(),
  credentials: checkEnvNames.optional(),
  artifactPaths: artifactPaths.optional(),
  static: z.boolean().optional(),
  measureResources: z.boolean().optional(),
  declaredInputs: z.array(declaredInputSchema).optional(),
  actions: checkActions.optional(),
  selection: checkSelectionDeclaration.optional(),
  docsPaths: docsPathsSchema.optional(),
  globalRiskPaths: globalRiskPathsSchema.optional(),
  submodules: z.boolean().optional(),
  ...actionsDeclarationFields,
});
