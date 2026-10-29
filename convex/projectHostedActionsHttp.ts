// SPDX-License-Identifier: Apache-2.0
import { makeFunctionReference } from 'convex/server';
import { httpAction } from './_generated/server';
import { z } from 'zod';
import { verifyActionsOidc } from '../src/github-actions-oidc';
import { directCommandSchema } from '../src/hosted-actions-direct';
import { hostedActionsRecipeSchema } from '../src/hosted-actions';
import { canonicalPayload } from '../src/hosted-source-operation';
import { verifyOutputObject } from './projectHostedOutputApi';
import { directOutput } from '../src/hosted-actions-direct';
import { outputSigningKey } from './projectHostedOutputApi';
import { outputMessage, type OutputRoot } from '../src/hosted-check-output';
import { hostedCheckTerminal } from '../src/hosted-check';
import type { HostedCheckRun } from '../src/hosted-check';
import type { Id } from './_generated/dataModel';
import { invariant } from '../src/errors';
const requestSchema = z
  .object({
    projectId: z.string(),
    runId: z.uuid(),
    fence: z.number().safe().nonnegative().optional(),
    command: directCommandSchema,
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
    const claims = await verifyActionsOidc(request.headers.get('authorization')!.slice(7), site);
    // Byte bound on protocol metadata, not repository size; source bytes use storage.
    const reader = request.body?.getReader();
    invariant(reader, 'BAD_ARGUMENT', 'A JSON body is required.');
    let size = 0;
    const chunks: Uint8Array[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 512 * 1024) {
        await reader.cancel();
        throw new Error('Metadata window exceeded.');
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    const parsed = requestSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
    const { command, ...id } = parsed;
    const input = {
      ...id,
      projectId: id.projectId as Id<'hostedProjects'>,
      claims: canonicalPayload(claims),
    };
    let value: unknown;
    if (command.kind === 'source')
      value = await ctx.runMutation(makeFunctionReference<'mutation'>('projectHostedActionsSource:resolve'), {
        ...input,
        digests: command.digests,
      });
    else if (command.kind === 'output')
      value = await ctx.runMutation(makeFunctionReference<'mutation'>('projectHostedActionsResults:output'), {
        ...input,
        index: command.index,
        log: canonicalPayload(command.log),
      });
    else if (command.kind === 'session')
      value = await ctx.runMutation(
        makeFunctionReference<'mutation'>('projectHostedActionsSession:session'),
        input,
      );
    else if (command.kind === 'plan') {
      // Recheck before and after storage IO; only immutable small plan metadata crosses this action.
      await ctx.runMutation(makeFunctionReference<'mutation'>('projectHostedActionsSession:session'), input);
      const plan = z
        .object({ recipe: hostedActionsRecipeSchema, lockfile: z.string().regex(/^[a-f0-9]{64}$/) })
        .strict()
        .parse(command.plan);
      const selectionStorage = await ctx.storage.store(new Blob([canonicalPayload(plan.recipe.selection)]));
      const recipeStorage = await ctx.storage.store(new Blob([canonicalPayload(plan.recipe)]));
      value = await ctx.runMutation(makeFunctionReference<'mutation'>('projectHostedActionsPlan:prepare'), {
        ...input,
        recipe: canonicalPayload(plan.recipe),
        lockfile: plan.lockfile,
        selectionStorage,
        recipeStorage,
      });
    } else {
      // Storage verification happens outside the result transaction. The transaction
      // repeats authority/fence checks before atomically committing output and evidence.
      const run: HostedCheckRun = await ctx.runMutation(
        makeFunctionReference<'mutation'>('projectHostedActionsSession:session'),
        input,
      );
      if (command.result.log)
        await verifyOutputObject(
          input.projectId,
          directOutput(run, command.result.index, command.result.log, outputSigningKey(run.keyId))[0]!
            .message,
        );
      value = await ctx.runMutation(makeFunctionReference<'mutation'>('projectHostedActionsResults:result'), {
        ...input,
        result: canonicalPayload(command.result),
      });
      const settled = value as HostedCheckRun;
      if (hostedCheckTerminal(settled)) {
        const final = (await ctx.runMutation(
          makeFunctionReference<'mutation'>('projectHostedActionsOutput:prepare'),
          input,
        )) as { root: OutputRoot; target: { url: string; headers: Record<string, string> } } | null;
        if (final) {
          const stored = await fetch(final.target.url, {
            method: 'PUT',
            headers: final.target.headers,
            body: canonicalPayload(final.root),
            redirect: 'error',
            signal: AbortSignal.timeout(20_000),
          });
          invariant(stored.ok || stored.status === 412, 'R2_VERIFY_FAILED', 'Output manifest upload failed.');
          await verifyOutputObject(
            input.projectId,
            outputMessage(settled, { kind: 'final', root: final.root }),
          );
          await ctx.runMutation(makeFunctionReference<'mutation'>('projectHostedActionsOutput:apply'), {
            ...input,
            root: canonicalPayload(final.root),
          });
        }
      }
    }
    return Response.json(value, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    // Codes and schema paths only: request bodies and messages may carry runner data.
    console.error(
      'Actions request refused',
      error instanceof z.ZodError
        ? `validation ${error.issues.map(issue => issue.path.join('.')).join(',')}`
        : ((error as { code?: unknown })?.code ?? (error as Error)?.name ?? 'unknown'),
    );
    return Response.json(
      { error: 'Actions request failed authorization, validation or storage verification.' },
      { status: 403, headers: { 'Cache-Control': 'no-store' } },
    );
  }
});
