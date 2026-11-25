// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { z } from 'zod';
import { checkBackendSchema } from './check-backend.js';
import { checkEnvironmentSchema } from './check-environment-schema.js';
import { checkSchema } from './work-check-definition.js';
import { inputObservationSchema } from './work-input-types.js';
import { dependencySchema, viewInputsSchema } from './work-view-inputs.js';
import { safeRelative } from './safe-relative.js';
import { workActorSchema } from './work-actor-types.js';

const id = z.string().uuid();
const oid = z.string().regex(/^[0-9a-f]{40,64}$/);
const artifactSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('retained'),
    sourcePath: z.string(),
    filename: z.string().regex(/^artifact-[0-9]+\.bin$/),
    size: z.number().safe().nonnegative(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
  }),
  z.object({ status: z.literal('unavailable'), sourcePath: z.string(), details: z.string() }),
]);
const resourceUsageSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('measured'),
    producer: z.string(),
    realSeconds: z.number().finite().nonnegative(),
    userSeconds: z.number().finite().nonnegative(),
    systemSeconds: z.number().finite().nonnegative(),
    peakRssBytes: z.number().safe().nonnegative(),
    report: z.string(),
    details: z.string(),
  }),
  z.object({ status: z.literal('unavailable'), producer: z.string().optional(), details: z.string() }),
]);
export const interactionRequestSchema = z.object({
  version: z.literal(1),
  reusedRunId: id,
  base: oid,
  checkedHead: oid,
  main: oid,
});
export const interactionEvidenceSchema = interactionRequestSchema.extend({
  mergedHead: oid,
  eligible: z.boolean(),
  reason: z.string(),
  mainRunId: id.optional(),
  basis: z.enum(['docs-overlap', 'main-full-coverage']).optional(),
  lanePaths: z.array(z.string()),
  mainPaths: z.array(z.string()),
  overlap: z.array(z.string()),
});
export const explicitTestsSchema = z
  .array(
    z.string().refine(
      // Which files are tests is the check's: Forge's standard check takes tests/*.test.mjs, any
      // other check its project test runner's files (src/explicit-test-runner.ts, at the head).
      path => safeRelative(path) && path.length <= 1024 && !/[\x00-\x1f\x7f*?\[\]{}!]/.test(path),
      'Use a relative test file path (no globs).',
    ),
  )
  .transform(tests => [...new Set(tests)].sort());
const checkDetailSummarySchema = z.object({
  tests: z.number().safe().nonnegative(),
  coverageTests: z.number().safe().nonnegative(),
  verdicts: z.record(z.string(), z.number().safe().nonnegative()),
  failedTests: z.array(z.string().max(512)).max(20),
});
const checkSelectionEvidenceSchema = z.object({
  partial: z.boolean().optional(),
  scope: z.enum(['docs', 'interaction', 'scoped', 'full', 'partial']),
  reason: z.string(),
  tests: z.array(z.string()),
  coverage: z
    .object({
      mode: z.literal('shadow'),
      head: oid.optional(),
      age: z.number().int().nonnegative().optional(),
      currentCount: z.number().int().nonnegative(),
      coverageCount: z.number().int().nonnegative(),
      tests: z.array(z.string()),
      fallback: z.string().nullable(),
    })
    .optional(),
});
const checkCancellationSchema = z.object({
  reason: z.enum(['command', 'superseded', 'signal', 'queue']),
  at: z.string(),
  actor: z.union([workActorSchema, z.object({ kind: z.literal('system'), name: z.string() })]).optional(),
  details: z.string().optional(),
  signal: z.string().optional(),
  supersededBy: id.optional(),
});

export const recoveryCheckSchema = z.object({
  auditRunId: id,
  phase: z.enum(['retry', 'bisect', 'revert']),
  tests: z.array(z.string()).optional(),
});
export const checkRunSchema = z
  .object({
    reuseKey: oid.optional(),
    reusedFrom: z.object({ runId: id, endedAt: z.string(), evidence: oid }).optional(),
    supersessionBaseline: id.optional(),
    optimistic: z.boolean().optional(),
    recovery: recoveryCheckSchema.optional(),
    backend: checkBackendSchema.optional(),
    id,
    detailRef: z
      .object({ sha256: z.string().regex(/^[0-9a-f]{64}$/), size: z.number().safe().nonnegative() })
      .optional(),
    detailSummary: checkDetailSummarySchema.optional(),
    failureSummary: z.string().max(4096).optional(),
    mainCheck: z.object({ channel: z.string() }).optional(),
    viewId: id,
    head: oid,
    base: oid,
    inputs: viewInputsSchema,
    dependencies: z.array(dependencySchema),
    check: checkSchema,
    environment: checkEnvironmentSchema,
    inputObservations: z.array(inputObservationSchema).optional(),
    comparisonBase: oid.optional(),
    interaction: interactionEvidenceSchema.nullable().optional(),
    checkSelection: checkSelectionEvidenceSchema.optional(),
    status: z.enum([
      'queued',
      'preparing',
      'running',
      'passed',
      'failed',
      'cancelled',
      'interrupted',
      'runner-unavailable',
      'runner-budget-exhausted',
    ]),
    startedAt: z.string(),
    endedAt: z.string().optional(),
    // A virtual reuse receipt has no process. Older readers reject PID 0 rather
    // than stripping reusedFrom and treating it as an independently executed pass.
    runner: z
      .object({ pid: z.number().int().nonnegative(), host: z.string(), startTime: z.string().optional() })
      .refine(runner => runner.pid > 0 || runner.host === 'retained-check'),
    childPid: z.number().int().positive().optional(),
    childStartTime: z.string().optional(),
    queuedAt: z.string().optional(),
    warnings: z.array(z.string()).optional(),
    error: z.object({ code: z.string(), message: z.string() }).optional(),
    cancellation: checkCancellationSchema.optional(),
    cancelRequested: z.boolean().optional(),
    exitCode: z.number().int().nullable().optional(),
    signal: z.string().nullable().optional(),
    details: z.string(),
    playbookRunId: id.optional(),
    artifacts: z.array(artifactSchema).optional(),
    resourceUsage: resourceUsageSchema.optional(),
  })
  .refine(run => (run.runner.pid === 0) === Boolean(run.reusedFrom), {
    message:
      'A virtual check must retain its source run; executed checks must retain their process identity.',
  });
