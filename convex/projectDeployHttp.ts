// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// GitHub Actions adapter. The live target declaration authorizes the signed workflow on main
// before it can access source or record an outcome.
import { makeFunctionReference } from 'convex/server';
import { z } from 'zod';
import { httpAction } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { verifyDeployActionsOidc } from '../src/github-actions-oidc';
import { directSourceBatch } from '../src/hosted-actions-direct';
import { invariant } from '../src/errors';
import { deployTargetName } from '../src/deploy-targets';
import { stateSourceGrants } from './projectStateSourceGrants';
import { RUNNER_SOURCE_READ_BUDGET_MS } from './projectStateSourceApi';

const DIAGNOSTIC_CHARS = 240;
const clampDiagnostic = (value: string | undefined) => {
  const clean = value?.replace(/\s+/g, ' ').trim();
  return clean ? clean.slice(0, DIAGNOSTIC_CHARS) : undefined;
};

const smokeCheckSchema = z
  .object({
    name: z.string().min(1).max(64),
    ok: z.boolean(),
    status: z.number().int().min(0).max(999).optional(),
    detail: z.string().max(2048).optional(),
  })
  .strict();

const deployRequestSchema = z
  .object({
    projectId: z.string().min(1).max(128),
    target: deployTargetName,
    command: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('main') }).strict(),
      z
        .object({
          kind: z.literal('manifest'),
          state: z.string().regex(/^[a-f0-9]{64}$/),
          sequence: z.number().int().positive().optional(),
        })
        .strict(),
      z
        .object({
          kind: z.literal('source'),
          state: z.string().regex(/^[a-f0-9]{64}$/),
          sequence: z.number().int().positive().optional(),
          digests: z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(directSourceBatch),
          object: z
            .string()
            .regex(/^[a-f0-9]{64}$/)
            .optional(),
        })
        .strict(),
      z
        .object({
          kind: z.literal('report'),
          state: z.string().regex(/^[a-f0-9]{64}$/),
          sequence: z.number().int().positive(),
          status: z.enum(['succeeded', 'failed', 'smoke-failed']),
          url: z.string().max(400).optional(),
          summary: z.string().max(4096).optional(),
          cause: z.string().max(240).optional(),
          smoke: z
            .object({
              ok: z.boolean(),
              checks: z.array(smokeCheckSchema).max(16),
            })
            .strict()
            .optional(),
          unchanged: z.literal(true).optional(),
          liveSequence: z.number().int().positive().optional(),
          liveHead: z
            .string()
            .regex(/^[a-f0-9]{64}$/)
            .optional(),
        })
        .strict(),
    ]),
  })
  .strict();

export const handle = httpAction(async (ctx, request) => {
  try {
    const site = process.env.CONVEX_SITE_URL;
    invariant(
      site && request.headers.get('authorization')?.startsWith('Bearer '),
      'EVIDENCE_CHANGED',
      'GitHub OIDC authorization required.',
    );
    const claims = await verifyDeployActionsOidc(request.headers.get('authorization')!.slice(7), site);
    const reader = request.body?.getReader();
    invariant(reader, 'BAD_ARGUMENT', 'A JSON body is required.');
    let size = 0;
    const chunks: Uint8Array[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 128 * 1024) {
        await reader.cancel();
        throw new Error('Deploy metadata window exceeded.');
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    const parsed = deployRequestSchema.parse(
      JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
    );
    const projectId = parsed.projectId as Id<'hostedProjects'>;
    const identity = {
      projectId,
      target: parsed.target,
      repository: claims.repository,
      workflow: claims.workflow,
    };
    let value: unknown;
    if (parsed.command.kind === 'main') {
      value = JSON.parse(
        await ctx.runQuery(makeFunctionReference<'query'>('projectDeployStore:mainContext'), identity),
      );
    } else if (parsed.command.kind === 'manifest') {
      const selected = JSON.parse(
        await ctx.runMutation(makeFunctionReference<'mutation'>('projectDeployStore:selectState'), {
          ...identity,
          state: parsed.command.state,
          ...(parsed.command.sequence !== undefined ? { sequence: parsed.command.sequence } : {}),
        }),
      ) as {
        descriptor: { object: { sha256: string; size: number }; recipe?: unknown };
        url: string | null;
        range?: { offset: number; length: number };
      };
      value = {
        sha256: selected.descriptor.object.sha256,
        size: selected.descriptor.object.size,
        url: selected.url,
        ...(selected.range ? { range: selected.range } : {}),
        ...(selected.descriptor.recipe ? { recipe: selected.descriptor.recipe } : {}),
      };
    } else if (parsed.command.kind === 'source') {
      const { state, sequence, digests, object } = parsed.command;
      value = await stateSourceGrants({
        projectId,
        state,
        digests,
        ...(object ? { object } : {}),
        preparation: true,
        budget: { deadline: Date.now() + RUNNER_SOURCE_READ_BUDGET_MS },
        select: async recheck =>
          JSON.parse(
            await ctx.runMutation(makeFunctionReference<'mutation'>('projectDeployStore:selectState'), {
              ...identity,
              state,
              ...(sequence !== undefined ? { sequence } : {}),
              ...(recheck ? { recheck } : {}),
            }),
          ),
        catalog: async (ids, raw) =>
          ctx.runMutation(makeFunctionReference<'mutation'>('projectDeployStore:catalog'), {
            ...identity,
            digests: ids,
            ...(raw ? {} : { runs: false }),
          }),
        log: message => console.log('FORGE_DEPLOY_SOURCE ' + JSON.stringify({ message })),
      });
    } else {
      const { state, sequence, status, url, summary, cause, smoke, unchanged, liveSequence, liveHead } =
        parsed.command;
      const clampedSummary = clampDiagnostic(summary);
      const clampedSmoke = smoke
        ? {
            ok: smoke.ok,
            checks: smoke.checks.map(check => ({
              name: check.name,
              ok: check.ok,
              ...(check.status !== undefined ? { status: check.status } : {}),
              ...(clampDiagnostic(check.detail) ? { detail: clampDiagnostic(check.detail) } : {}),
            })),
          }
        : undefined;
      value = JSON.parse(
        await ctx.runMutation(makeFunctionReference<'mutation'>('projectDeployStore:record'), {
          ...identity,
          state,
          sequence,
          status,
          runId: `${claims.run_id}:${claims.run_attempt}`,
          ...(url ? { url } : {}),
          ...(clampedSummary ? { summary: clampedSummary } : {}),
          ...(cause ? { cause } : {}),
          ...(clampedSmoke ? { smoke: clampedSmoke } : {}),
          ...(unchanged ? { unchanged } : {}),
          ...(liveSequence !== undefined ? { liveSequence } : {}),
          ...(liveHead ? { liveHead } : {}),
        }),
      );
    }
    return Response.json(value, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    const code =
      (error as { data?: { code?: string }; code?: string })?.data?.code ??
      (error as { code?: string })?.code ??
      (error instanceof z.ZodError ? 'BAD_ARGUMENT' : 'unknown');
    console.warn('FORGE_DEPLOY_HTTP_REFUSED', JSON.stringify({ code }));
    const status = code === 'RUNNER_UNAVAILABLE' ? 503 : code === 'BAD_ARGUMENT' ? 400 : 403;
    return Response.json(
      { error: 'Deploy actions request failed authorization or validation.', code },
      { status, headers: { 'Cache-Control': 'no-store' } },
    );
  }
});
