// SPDX-License-Identifier: Apache-2.0
import { cleanPoolClaims } from './projectHostedActionsPool';
export { cleanPoolClaims } from './projectHostedActionsPool';
import { collectResultBatch, resultBatchTargets } from './projectHostedActionsBatch';
import { actionsPreflightSignature } from '../src/hosted-actions-preflight';
import { makeFunctionReference } from 'convex/server';
import { httpAction, type ActionCtx } from './_generated/server';
import { z } from 'zod';
import { sourcePackCommand } from './projectSourcePacks';
import { verifyActionsOidc } from '../src/github-actions-oidc';
import { directRequestSchema, directResultSchema } from '../src/hosted-actions-direct';
import { canonicalPayload } from '../src/hosted-source-operation';
import { verifyOutputObject, storeOutputObject } from './projectHostedOutputApi';
import { directOutput } from '../src/hosted-actions-direct';
import { outputSigningKey } from './projectHostedOutputApi';
import { outputMessage, type OutputRoot } from '../src/hosted-check-output';
import { hostedCheckOutputSettled } from '../src/hosted-check-verdict';
import type { HostedCheckRun } from '../src/hosted-check';
import type { Id } from './_generated/dataModel';
import { invariant } from '../src/errors';
import { convexValueLimit } from '../src/convex-value-limit';
import { landingProofSignature } from '../src/hosted-actions-preflight';
import { runnerPublicCode } from '../src/runner-visibility';
import { storeSourceBytes } from './projectSourceBytes';
import { savePin } from '../src/hosted-save';
import type { SessionInput } from './projectHostedActionsSession';
import { activeStoragePause } from './legacyStoragePause';
import { presignPoolClaim, r2Config } from './r2';
import type { HostedActionsRecipe } from '../src/hosted-actions';
import { poolClaimBody, poolClaimExpirySeconds, poolClaimKey, poolUnits } from '../src/hosted-actions-pool';
import { submoduleReadTokens, type SubmodulePolicy } from './githubAppToken';
import type { RunnerScope } from './githubBindingAccess';
import { convexFetch } from './networkFetch';
/** Refused writes that resolve on their own: the runner keeps its result and
 * retries the same request (Issue 72d50375). */
// EXCHANGE_REQUEST_*: convexFetch transport faults (deadline or lost connection).
const transientCodes = [
  'RUNNER_UNAVAILABLE',
  'LEGACY_STORAGE_WRITES_PAUSED',
  'HOSTED_CONFLICT',
  'EXCHANGE_REQUEST_TIMEOUT',
  'EXCHANGE_REQUEST_FAILED',
];
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
export const handle = httpAction(async (ctx, request) => {
  let reason: 'authorization' | 'validation' | 'storage' | 'cancelled' | 'limit' = 'authorization';
  let verified: SessionInput | undefined;
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
    verified = input;
    reason = 'authorization';
    let value: unknown;
    if (command.kind === 'source') {
      const reply = await ctx.runMutation(
        makeFunctionReference<'mutation'>('projectHostedActionsSource:resolve'),
        {
          ...input,
          digests: command.digests,
          ...(command.batch ? { batch: true } : {}),
          ...(command.closures ? { closures: true } : {}),
          ...(command.runs ? { runs: true } : {}),
        },
      );
      value = command.batch ? JSON.parse(reply as string) : reply;
    } else if (command.kind === 'results') value = await collectResultBatch(ctx, input);
    else if (command.kind === 'output')
      value = JSON.parse(
        await ctx.runMutation(makeFunctionReference<'mutation'>('projectHostedActionsResults:output'), {
          ...input,
          index: command.index,
          log: canonicalPayload(command.log),
        }),
      );
    else if (command.kind === 'session')
      value = JSON.parse(
        await ctx.runMutation(makeFunctionReference<'mutation'>('projectHostedActionsSession:session'), {
          ...input,
          ...(command.timings ? { timings: true } : {}),
        }),
      );
    else if (command.kind === 'sourcePack')
      value = await sourcePackCommand(ctx, input, command.phase, command.object);
    else if (command.kind === 'submoduleAccess') {
      // Authorize the live run first; the same call reads the owner's current submodule
      // allowlist. Tokens are minted for allowed repositories of its installation only.
      const {
        run,
        policy,
        runnerScope,
      }: { run: HostedCheckRun; policy: SubmodulePolicy; runnerScope?: RunnerScope | null } = JSON.parse(
        await ctx.runMutation(makeFunctionReference<'mutation'>('projectHostedActionsSession:session'), {
          ...input,
          submodules: true,
        }),
      );
      invariant(
        run.configuration.provider === 'github-actions',
        'EVIDENCE_CHANGED',
        'Submodule access belongs to GitHub Actions runs.',
      );
      value = await submoduleReadTokens(
        ctx,
        input.projectId,
        run.configuration.repository,
        command.repositories,
        policy,
        convexFetch,
        Date.now(),
        runnerScope ?? null,
      );
    } else if (command.kind === 'plan') {
      // Recheck before and after storage IO; only immutable small plan metadata crosses this action.
      await ctx.runMutation(makeFunctionReference<'mutation'>('projectHostedActionsSession:session'), input);
      const plan = command.plan;
      reason = 'storage';
      // Content keys dedupe identical selections across rechecks. A verified
      // existing HEAD avoids uploading the selection body again. The two objects are
      // independent, so their R2 round trips overlap (same requests, half the wait).
      const [selection, recipe] = await Promise.all([
        storeSourceBytes(
          ctx,
          input.projectId,
          new TextEncoder().encode(canonicalPayload(plan.recipe.selection)),
          savePin(plan.recipe.selection),
          true,
        ),
        storeSourceBytes(
          ctx,
          input.projectId,
          new TextEncoder().encode(canonicalPayload(plan.recipe)),
          savePin(plan.recipe),
          true,
        ),
      ]);
      reason = 'authorization';
      value = JSON.parse(
        await ctx.runMutation(makeFunctionReference<'mutation'>('projectHostedActionsPlan:prepare'), {
          ...input,
          recipe: canonicalPayload(plan.recipe),
          lockfile: plan.lockfile,
          ...(command.packRefresh ? { packRefresh: true } : {}),
          ...(command.resultsBatch ? { resultsBatch: true } : {}),
          ...(command.resultsPacked ? { resultsPacked: true } : {}),
          ...('storageId' in selection
            ? { selectionStorage: selection.storageId }
            : { selectionR2Key: selection.r2Key }),
          ...('storageId' in recipe ? { recipeStorage: recipe.storageId } : { recipeR2Key: recipe.r2Key }),
        }),
      );
      if (command.resultsBatch)
        value = {
          run: value,
          resultBatch: await resultBatchTargets(value as HostedCheckRun, command.resultsPacked),
        };
      // Shard pool: sign one claim per unit here (CPU only), so shards claim with no Convex call.
      if (plan.recipe.pool) {
        reason = 'storage';
        value = {
          ...(command.resultsBatch ? (value as object) : { run: value }),
          claims: await poolClaims(
            input.projectId,
            (command.resultsBatch ? (value as { run: HostedCheckRun }).run : value) as HostedCheckRun,
            plan.recipe,
          ),
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
      const { target, run } = JSON.parse(
        await ctx.runMutation(makeFunctionReference<'mutation'>('projectHostedActionsResults:output'), {
          ...input,
          index: command.result.index,
          log: canonicalPayload(log),
          withRun: true,
        }),
      ) as { target: { url: string; headers: Record<string, string> }; run: HostedCheckRun };
      reason = 'storage';
      await storeOutputObject(target, body);
      await verifyOutputObject(
        input.projectId,
        directOutput(run, command.result.index, log, outputSigningKey(run.keyId))[0]!.message,
      );
      reason = 'authorization';
      value = await settleResult(ctx, input, command.result, phase => (reason = phase));
    } else {
      // Storage verification happens outside the result transaction. The transaction
      // repeats authority/fence checks before atomically committing output and evidence.
      const run: HostedCheckRun = JSON.parse(
        await ctx.runMutation(
          makeFunctionReference<'mutation'>('projectHostedActionsSession:session'),
          input,
        ),
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
    if (command.kind === 'plan') {
      const run = ((value as { run?: HostedCheckRun }).run ?? value) as HostedCheckRun;
      if (run.proofOnLanding)
        headers['X-Forge-Landing-Proof'] = JSON.stringify({
          endpoint: process.env.CONVEX_CLOUD_URL!,
          signature: landingProofSignature(run, outputSigningKey(run.keyId)),
        });
    }
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
    // A Convex value-shape limit fails the same way on every retry: refuse it, never 503.
    const limit = convexValueLimit(error);
    // Codes and schema paths only: request bodies and messages may carry runner data.
    console.error(
      'Actions request refused',
      error instanceof z.ZodError
        ? `validation ${error.issues.map(issue => issue.path.join('.')).join(',')}`
        : limit
          ? 'CONVEX_VALUE_LIMIT'
          : ((error as { code?: unknown })?.code ?? (error as Error)?.name ?? 'unknown'),
    );
    if (limit) reason = 'limit';
    else if ((error as { data?: { code?: string } })?.data?.code === 'CHECK_CANCELLED') reason = 'cancelled';
    else if (error instanceof z.ZodError) reason = 'validation';
    else if (String((error as { code?: unknown })?.code ?? '').startsWith('R2_')) reason = 'storage';
    const code =
      (error as { data?: { code?: string }; code?: string })?.data?.code ??
      (error as { code?: string })?.code;
    // Rare refusal path only: settle with the reason; the runner gets the same 403.
    if (code === runnerPublicCode && verified)
      await ctx
        .runMutation(makeFunctionReference<'mutation'>('projectHostedActionsSession:refusePublicRunner'), {
          projectId: verified.projectId,
          runId: verified.runId,
          claims: verified.claims,
          ...(verified.fence !== undefined ? { fence: verified.fence } : {}),
        })
        .catch(() => console.error('Actions request refused', 'refusal settlement failed'));
    const unavailable =
      !limit &&
      (reason === 'storage' ||
        transientCodes.includes(code ?? '') ||
        ['TimeoutError', 'AbortError', 'TypeError'].includes((error as Error)?.name) ||
        (!code && (error as Error)?.name === 'Error' && reason !== 'validation'));
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
  // The terminal result also returns the final output target (Issue 75cb5074): no prepare call.
  // JSON text (Issue 0c457ae4): the settled run's reports are keyed by test file.
  const { run: settled, final } = JSON.parse(
    await ctx.runMutation(makeFunctionReference<'mutation'>('projectHostedActionsResults:result'), {
      ...input,
      result: canonicalPayload(result),
      withFinal: true,
    }),
  ) as { run: HostedCheckRun; final: FinalOutput | 'prepare' };
  if (!hostedCheckOutputSettled(settled)) return settled;
  // Runs beside the output manifest work; it never throws.
  const cleanup = settled.poolClaimed ? cleanPoolClaims(input.projectId, settled.id) : undefined;
  try {
    return await finalOutput(ctx, input, settled, phase, final);
  } finally {
    await cleanup;
  }
}
type FinalOutput = { root: OutputRoot; target: { url: string; headers: Record<string, string> } } | null;
export async function finalOutput(
  ctx: ActionCtx,
  input: SessionInput,
  settled: HostedCheckRun,
  phase: (reason: 'authorization' | 'storage') => void,
  prepared: FinalOutput | 'prepare',
) {
  // Unsealed output: prepare refuses exactly as before, after the result committed.
  const final =
    prepared === 'prepare'
      ? ((await ctx.runMutation(
          makeFunctionReference<'mutation'>('projectHostedActionsOutput:prepare'),
          input,
        )) as FinalOutput)
      : prepared;
  if (!final) return settled;
  phase('storage');
  await storeOutputObject(final.target, canonicalPayload(final.root));
  await verifyOutputObject(input.projectId, outputMessage(settled, { kind: 'final', root: final.root }));
  phase('authorization');
  await ctx.runMutation(makeFunctionReference<'mutation'>('projectHostedActionsOutput:apply'), {
    ...input,
    root: canonicalPayload(final.root),
  });
  return settled;
}
