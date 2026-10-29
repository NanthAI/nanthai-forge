// SPDX-License-Identifier: Apache-2.0
'use node';
import { v } from 'convex/values';
import { action, type ActionCtx } from './cliServer';
import { makeFunctionReference } from 'convex/server';
import type { Id } from './_generated/dataModel';
import { exchangeObjectReader, type ExchangeObjectReader } from './projectExchangeReader';
import { parseNativeState } from '../src/native-state-format';
import {
  contractTestsInput,
  contractProposal,
  confirmTestContract,
  latestTestContract,
} from '../src/intent-test-contract';
import { intentContractSelection, selectionSourcePath } from '../src/intent-contract-selection';
import { hostedContractTimings } from '../src/hosted-contract-timings';
import { hostedRecordSchema } from '../src/hosted-records';
import { canonicalPayload } from '../src/hosted-source-operation';
import { digest } from '../src/hash';
import { invariant } from '../src/errors';
import { z } from 'zod';
import { report } from './errors';
const commandSchema = contractTestsInput.extend({
  action: z.enum(['tests', 'confirm-tests']),
  candidateId: z.uuid(),
});
/** Exact source and existing measured output are read outside metadata transactions. */
export async function executeIntentTests(
  ctx: ActionCtx,
  projectId: Id<'hostedProjects'>,
  request: string,
  suppliedReader?: ExchangeObjectReader,
) {
  const command = commandSchema.parse(JSON.parse(request));
  const query = async (name: string, args: Record<string, unknown>) => {
    const value = await ctx.runQuery(makeFunctionReference<'query'>(name), { projectId, ...args });
    return typeof value === 'string' ? JSON.parse(value) : value;
  };
  const mutation = async (name: string, args: Record<string, unknown>) => {
    const value = await ctx.runMutation(makeFunctionReference<'mutation'>(name), { projectId, ...args });
    return typeof value === 'string' ? JSON.parse(value) : value;
  };
  const contextSchema = z.object({
    actor: z.string(),
    authorityEpoch: z.number(),
    head: z.string(),
    candidate: hostedRecordSchema.options[3],
    intent: hostedRecordSchema.options[0],
  });
  const context = contextSchema.parse(
    await query('projectIntentTestStore:context', { candidateId: command.candidateId }),
  );
  const { candidate, intent, head, actor } = context;
  const requestDigest = digest(canonicalPayload(command));
  const prior =
    command.action === 'confirm-tests'
      ? intent.testContracts?.find(item => item.operationId === command.operationId)
      : undefined;
  if (prior) {
    invariant(
      prior.request === requestDigest,
      'WORK_OPERATION_CHANGED',
      'Replay the original contract confirmation.',
    );
    return { intentId: intent.id, contract: prior, gate: 'unchanged' };
  }
  invariant(
    !command.expectedHead || command.expectedHead === head,
    'VIEW_STALE',
    'Select the original Candidate head.',
  );
  const reader = suppliedReader ?? exchangeObjectReader(ctx);
  const read = async (digests: string[]) => {
    const objects = z
      .array(z.object({ object: z.object({ sha256: z.string(), size: z.number() }) }))
      .parse(await query('projectIntentTestStore:objects', { digests }));
    return reader.read(
      projectId,
      actor,
      objects.map(row => row.object),
    );
  };
  const [beforeBytes, afterBytes] = await read([candidate.base.head, head]);
  const before = parseNativeState(beforeBytes!),
    after = parseNativeState(afterBytes!);
  const old = new Map(before.files.map(file => [file.path, file])),
    next = new Map(after.files.map(file => [file.path, file]));
  const paths = [...new Set([...old.keys(), ...next.keys()])].filter(
    path => old.get(path)?.blob !== next.get(path)?.blob || old.get(path)?.mode !== next.get(path)?.mode,
  );
  const selected = after.files.filter(file => selectionSourcePath(file.path)),
    files = new Map<string, string>();
  for (let at = 0; at < selected.length; at += 100) {
    const batch = selected.slice(at, at + 100),
      bytes = await read(batch.map(file => file.blob));
    batch.forEach((file, index) => files.set(file.path, bytes[index]!.toString('utf8')));
  }
  const selection = intentContractSelection(files, paths);
  const historical =
    command.timingBasis === 'history'
      ? z
          .object({ runId: z.uuid(), measuredOn: z.string(), timings: z.record(z.string(), z.number()) })
          .nullable()
          .parse(await query('projectHostedGate:history', { candidateId: candidate.id }))
      : null;
  const timings =
    command.timingBasis === 'history'
      ? (historical?.timings ?? {})
      : command.runId
        ? await hostedContractTimings({
            runId: command.runId,
            candidateId: candidate.id,
            head,
            query,
            mutation,
            download: async url => {
              const response = await fetch(url);
              invariant(response.ok, 'SOURCE_UNAVAILABLE', 'Timing output download failed.');
              return new Uint8Array(await response.arrayBuffer());
            },
          })
        : {};
  if (command.action === 'confirm-tests') {
    const contract = confirmTestContract({
      command,
      candidateId: candidate.id,
      head,
      required: selection.tests,
      available: selection.available,
      timings,
      version: latestTestContract(intent)?.version ?? 0,
      request: requestDigest,
      at: new Date().toISOString(),
      ...(historical ? { history: historical } : {}),
    });
    return mutation(
      command.timingBasis === 'history'
        ? 'projectHostedGate:confirmHistory'
        : 'projectIntentTestStore:confirm',
      {
        candidateId: candidate.id,
        contract: canonicalPayload(contract),
        authorityEpoch: context.authorityEpoch,
      },
    );
  }
  // Recheck current access even when every source byte was a cache hit.
  await query('projectIntentTestStore:context', { candidateId: candidate.id });
  return {
    ...selection,
    intentId: intent.id,
    candidateId: candidate.id,
    head,
    main: candidate.base.head,
    contractVersion: latestTestContract(intent)?.version ?? 0,
    contract: latestTestContract(intent),
    contractProposal: {
      ...contractProposal(command.tests ?? selection.tests, timings, selection.tests),
      timingBasis: historical ? 'history' : command.runId ? 'exact-candidate-run' : 'unavailable',
      measuredOn: historical?.measuredOn ?? (command.runId ? head : null),
      runId: historical?.runId ?? command.runId ?? null,
    },
  };
}
export const execute = action({
  args: { projectId: v.id('hostedProjects'), request: v.string() },
  returns: v.string(),
  handler: async (ctx, input) => {
    try {
      return canonicalPayload(await executeIntentTests(ctx, input.projectId, input.request));
    } catch (error) {
      return report(error);
    }
  },
});
