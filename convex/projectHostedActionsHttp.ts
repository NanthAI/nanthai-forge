// SPDX-License-Identifier: Apache-2.0
import { actionsPreflightSignature } from '../src/hosted-actions-preflight';
import { makeFunctionReference } from 'convex/server';
import { httpAction, type ActionCtx } from './_generated/server';
import { z } from 'zod';
import { sourcePackCommand } from './projectSourcePacks';
import { verifyActionsOidc } from '../src/github-actions-oidc';
import { directRequestSchema, directResultSchema } from '../src/hosted-actions-direct';
import { canonicalPayload } from '../src/hosted-source-operation';
import { verifyOutputObject } from './projectHostedOutputApi';
import { directOutput } from '../src/hosted-actions-direct';
import { outputSigningKey } from './projectHostedOutputApi';
import { outputMessage, type OutputRoot } from '../src/hosted-check-output';
import { hostedCheckTerminal } from '../src/hosted-check';
import type { HostedCheckRun } from '../src/hosted-check';
import type { Id } from './_generated/dataModel';
import { invariant } from '../src/errors';
import { storeSourceBytes } from './projectSourceBytes';
import { savePin } from '../src/hosted-save';
import type { SessionInput } from './projectHostedActionsSession';
import { activeStoragePause } from './legacyStoragePause';
import { presignPoolClaim, r2Config } from './r2';
import type { HostedActionsRecipe } from '../src/hosted-actions';
import {
  poolClaimBody,
  poolClaimExpirySeconds,
  poolClaimKey,
  poolClaimPrefix,
  poolUnits,
} from '../src/hosted-actions-pool';
import { deleteR2Object, listR2Prefix } from './r2Operations';
/** Refused writes that resolve on their own: the runner keeps its result and
 * retries the same request (Issue 72d50375). */
const transientCodes = ['RUNNER_UNAVAILABLE', 'LEGACY_STORAGE_WRITES_PAUSED', 'HOSTED_CONFLICT'];
async function poolClaims(projectId: string, run: HostedCheckRun, recipe: HostedActionsRecipe) {
  invariant(run.executionId, 'EVIDENCE_CHANGED', 'Prepare this exact Actions execution.');
  const config = r2Config(),
    execution = savePin(run.executionId).sha256.slice(0, 16);
  return Promise.all(
    poolUnits(recipe.groups, recipe.pool!).map(({ unit }) =>
      presignPoolClaim(
        config,
        poolClaimKey(projectId, run.id, execution, unit),
        poolClaimBody(unit),
        poolClaimExpirySeconds,
      ),
    ),
  );
}
/** Forge deletes its own claim objects, so no bucket lifecycle rule is needed: the final result
 * deletes this run's claims, then one page of other runs' claims older than their signed URLs
 * (a cancelled or crashed check never posts a final result), starting after this run's random id
 * so successive checks sweep the whole prefix. Best effort and time bounded: never fails a result. */
export async function cleanPoolClaims(projectId: string, runId: string, now = Date.now()) {
  const config = r2Config(),
    root = poolClaimPrefix(projectId),
    own = `${root}${runId}/`,
    stale = now - poolClaimExpirySeconds * 1000;
  const remove = (keys: string[]) => Promise.all(keys.map(key => deleteR2Object(config, key)));
  const work = Promise.allSettled([
    (async () => {
      // At most two pages: a run has at most maxPoolUnits (128) claims.
      let cursor: string | null = null;
      for (let page = 0; page < 2; page++) {
        const listed = await listR2Prefix(config, own, cursor);
        await remove(listed.keys);
        if (!(cursor = listed.cursor)) break;
      }
    })(),
    (async () => {
      const listed = await listR2Prefix(config, root, null, `${own}~`);
      await remove(
        listed.keys.filter((key, index) => !key.startsWith(own) && listed.modified[index]! < stale),
      );
    })(),
  ]);
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([work, new Promise(resolve => (timer = setTimeout(resolve, 10_000)))]);
  clearTimeout(timer);
}
export const handle = httpAction(async (ctx, request) => {
  let reason: 'authorization' | 'validation' | 'storage' | 'cancelled' = 'authorization';
  try {
    const site = process.env.CONVEX_SITE_URL;
    invariant(
      site && request.headers.get('authorization')?.startsWith('Bearer '),
      'EVIDENCE_CHANGED',
      'GitHub OIDC authorization required.',
    );
    const claims = await verifyActionsOidc(request.headers.get('authorization')!.slice(7), site);
    reason = 'validation';
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
    const parsed = directRequestSchema.parse(
      JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
    );
    const { command, ...id } = parsed;
    const input = {
      ...id,
      projectId: id.projectId as Id<'hostedProjects'>,
      claims: canonicalPayload(claims),
    };
    reason = 'authorization';
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
        { ...input, ...(command.timings ? { timings: true } : {}) },
      );
    else if (command.kind === 'sourcePack')
      value = await sourcePackCommand(ctx, input, command.phase, command.object);
    else if (command.kind === 'plan') {
      // Recheck before and after storage IO; only immutable small plan metadata crosses this action.
      await ctx.runMutation(makeFunctionReference<'mutation'>('projectHostedActionsSession:session'), input);
      const plan = command.plan;
      reason = 'storage';
      // Content keys dedupe identical selections across rechecks. A verified
      // existing HEAD avoids uploading the selection body again.
      const selection = await storeSourceBytes(
        ctx,
        input.projectId,
        new TextEncoder().encode(canonicalPayload(plan.recipe.selection)),
        savePin(plan.recipe.selection),
        true,
      );
      const recipe = await storeSourceBytes(
        ctx,
        input.projectId,
        new TextEncoder().encode(canonicalPayload(plan.recipe)),
        savePin(plan.recipe),
        true,
      );
      reason = 'authorization';
      value = await ctx.runMutation(makeFunctionReference<'mutation'>('projectHostedActionsPlan:prepare'), {
        ...input,
        recipe: canonicalPayload(plan.recipe),
        lockfile: plan.lockfile,
        ...('storageId' in selection
          ? { selectionStorage: selection.storageId }
          : { selectionR2Key: selection.r2Key }),
        ...('storageId' in recipe ? { recipeStorage: recipe.storageId } : { recipeR2Key: recipe.r2Key }),
      });
      // Shard pool: sign one claim per unit here (CPU only), so shards claim with no Convex call.
      if (plan.recipe.pool) {
        reason = 'storage';
        value = {
          run: value,
          claims: await poolClaims(input.projectId, value as HostedCheckRun, plan.recipe),
        };
      }
    } else if (command.logBytes !== undefined) {
      // Inline log: authorize and store the bytes, then verify them like a separate
      // output upload would. The result transaction repeats authority/fence checks.
      reason = 'validation';
      const log = command.result.log,
        body = Uint8Array.from(atob(command.logBytes), c => c.charCodeAt(0));
      invariant(
        log && body.length === log.object.size,
        'BAD_ARGUMENT',
        'Log bytes differ from the result log.',
      );
      reason = 'authorization';
      const { target, run } = (await ctx.runMutation(
        makeFunctionReference<'mutation'>('projectHostedActionsResults:output'),
        { ...input, index: command.result.index, log: canonicalPayload(log), withRun: true },
      )) as { target: { url: string; headers: Record<string, string> }; run: HostedCheckRun };
      reason = 'storage';
      // The signed create-only PUT enforces the sha256; 412 means this object is already stored.
      const stored = await fetch(target.url, {
        method: 'PUT',
        headers: target.headers,
        body,
        redirect: 'error',
        signal: AbortSignal.timeout(20_000),
      });
      invariant(stored.ok || stored.status === 412, 'R2_VERIFY_FAILED', 'Output upload failed.');
      await verifyOutputObject(
        input.projectId,
        directOutput(run, command.result.index, log, outputSigningKey(run.keyId))[0]!.message,
      );
      reason = 'authorization';
      value = await settleResult(ctx, input, command.result, phase => (reason = phase));
    } else {
      // Storage verification happens outside the result transaction. The transaction
      // repeats authority/fence checks before atomically committing output and evidence.
      const run: HostedCheckRun = await ctx.runMutation(
        makeFunctionReference<'mutation'>('projectHostedActionsSession:session'),
        input,
      );
      if (command.result.log) {
        reason = 'storage';
        await verifyOutputObject(
          input.projectId,
          directOutput(run, command.result.index, command.result.log, outputSigningKey(run.keyId))[0]!
            .message,
        );
      }
      reason = 'authorization';
      value = await settleResult(ctx, input, command.result, phase => (reason = phase));
    }
    const headers: Record<string, string> = { 'Cache-Control': 'no-store' };
    if (command.kind === 'session') {
      const run = (command.timings ? (value as { run: HostedCheckRun }).run : value) as HostedCheckRun;
      // Additive header keeps the oldest session JSON shape unchanged.
      headers['X-Forge-Actions-Preflight'] = JSON.stringify({
        endpoint: process.env.CONVEX_CLOUD_URL!,
        signature: actionsPreflightSignature(run, outputSigningKey(run.keyId)),
      });
    }
    return Response.json(value, { headers });
  } catch (error) {
    // Codes and schema paths only: request bodies and messages may carry runner data.
    console.error(
      'Actions request refused',
      error instanceof z.ZodError
        ? `validation ${error.issues.map(issue => issue.path.join('.')).join(',')}`
        : ((error as { code?: unknown })?.code ?? (error as Error)?.name ?? 'unknown'),
    );
    if ((error as { data?: { code?: string } })?.data?.code === 'CHECK_CANCELLED') reason = 'cancelled';
    else if (error instanceof z.ZodError) reason = 'validation';
    else if (String((error as { code?: unknown })?.code ?? '').startsWith('R2_')) reason = 'storage';
    const code =
      (error as { data?: { code?: string }; code?: string })?.data?.code ??
      (error as { code?: string })?.code;
    const unavailable =
      reason === 'storage' ||
      transientCodes.includes(code ?? '') ||
      ['TimeoutError', 'AbortError', 'TypeError'].includes((error as Error)?.name) ||
      (!code && (error as Error)?.name === 'Error' && reason !== 'validation');
    // A paused deployment names its end, so runners wait once instead of polling.
    const pause = unavailable ? activeStoragePause() : null;
    return Response.json(
      { reason, error: 'Actions request failed authorization, validation or storage verification.' },
      {
        status: unavailable ? 503 : 403,
        headers: {
          'Cache-Control': 'no-store',
          ...(pause
            ? { 'Retry-After': String(Math.max(1, Math.ceil((pause.expiresAt - Date.now()) / 1000))) }
            : {}),
        },
      },
    );
  }
});

/** Commit one job result; the last one also publishes the final output manifest. */
async function settleResult(
  ctx: ActionCtx,
  input: SessionInput,
  result: z.infer<typeof directResultSchema>,
  phase: (reason: 'authorization' | 'storage') => void,
) {
  const settled: HostedCheckRun = await ctx.runMutation(
    makeFunctionReference<'mutation'>('projectHostedActionsResults:result'),
    { ...input, result: canonicalPayload(result) },
  );
  if (!hostedCheckTerminal(settled)) return settled;
  // Runs beside the output manifest work; it never throws.
  const cleanup = settled.poolClaimed ? cleanPoolClaims(input.projectId, settled.id) : undefined;
  try {
    return await finalOutput(ctx, input, settled, phase);
  } finally {
    await cleanup;
  }
}
async function finalOutput(
  ctx: ActionCtx,
  input: SessionInput,
  settled: HostedCheckRun,
  phase: (reason: 'authorization' | 'storage') => void,
) {
  const final = (await ctx.runMutation(
    makeFunctionReference<'mutation'>('projectHostedActionsOutput:prepare'),
    input,
  )) as { root: OutputRoot; target: { url: string; headers: Record<string, string> } } | null;
  if (!final) return settled;
  phase('storage');
  const stored = await fetch(final.target.url, {
    method: 'PUT',
    headers: final.target.headers,
    body: canonicalPayload(final.root),
    redirect: 'error',
    signal: AbortSignal.timeout(20_000),
  });
  invariant(stored.ok || stored.status === 412, 'R2_VERIFY_FAILED', 'Output manifest upload failed.');
  await verifyOutputObject(input.projectId, outputMessage(settled, { kind: 'final', root: final.root }));
  phase('authorization');
  await ctx.runMutation(makeFunctionReference<'mutation'>('projectHostedActionsOutput:apply'), {
    ...input,
    root: canonicalPayload(final.root),
  });
  return settled;
}
