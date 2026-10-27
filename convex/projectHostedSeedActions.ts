// SPDX-License-Identifier: Apache-2.0
'use node';
import { makeFunctionReference } from 'convex/server';
import { v } from 'convex/values';
import { action } from './cliServer';
import { exchangeObjectReader } from './projectExchangeReader';
import { caller } from './projectWorkActions';
import { digest } from '../src/hash';
import { recordReferences, recordKey } from '../src/work-exchange-records';
import { channelMoveSchema } from '../src/work-types';
import { parseNativeState } from '../src/native-state-format';
import { exchangeRootSchema } from '../src/native-exchange-tree';
import { canonicalPayload } from '../src/hosted-source-operation';
import { seedPageSchema, seedRequestSchema, validateSeedPage } from '../src/hosted-seed-protocol';
import { invariant } from '../src/errors';
import { report } from './errors';
const identity = { projectId: v.id('hostedProjects'), operationId: v.string() };
export const stage = action({
  args: { ...identity, index: v.number(), body: v.string(), previous: v.string() },
  returns: v.string(),
  handler: async (ctx, input): Promise<string> => {
    try {
      const owner = await caller(ctx),
        entries = seedPageSchema.parse(JSON.parse(input.body));
      validateSeedPage(entries);
      const states = entries.filter(entry => entry.kind === 'state' || entry.records);
      invariant(
        states.length <= 1 || states.reduce((n, pin) => n + pin.size, 0) <= 2 * 1024 * 1024,
        'BAD_ARGUMENT',
        'Continue source validation in bounded pages.',
      );
      const reader = exchangeObjectReader(ctx);
      const bodies = states.length ? await reader.read(input.projectId, owner, states) : [];
      for (const [index, pin] of states.entries()) {
        const bytes = bodies[index];
        if (pin.kind === 'state') parseNativeState(bytes!);
        for (const record of pin.records ?? []) {
          const value = JSON.parse(bytes!.toString('utf8'));
          invariant(
            recordKey(value, record.collection) === record.key,
            'INVALID_WORK_BACKUP',
            'A seed record changed its original ID.',
          );
          recordReferences(record.collection, value, record.format);
        }
      }
      return await ctx.runMutation(makeFunctionReference<'mutation'>('projectHostedSeed:commitPage'), {
        ...input,
        owner,
        body: canonicalPayload(entries),
      });
    } catch (error) {
      return report(error);
    }
  },
});
export const finish = action({
  args: identity,
  returns: v.string(),
  handler: async (ctx, input): Promise<string> => {
    try {
      const owner = await caller(ctx);
      const row = JSON.parse(
        (await ctx.runQuery(makeFunctionReference<'query'>('projectHostedSeed:inspect'), {
          ...input,
          owner,
        })) as string,
      );
      if (row.backupId)
        return canonicalPayload({
          nextPage: row.nextPage,
          chain: row.chain,
          backupId: row.backupId,
          mainDigest: row.mainDigest ?? null,
        });
      const request = seedRequestSchema.parse(JSON.parse(row.request));
      invariant(
        row.nextPage === request.pages && row.chain === request.chain,
        'INVALID_WORK_BACKUP',
        'Finish only after every seed page is committed.',
      );
      const reader = exchangeObjectReader(ctx);
      const [root] = await reader.read(input.projectId, owner, [request.root]);
      const metadata = exchangeRootSchema.parse(JSON.parse(root!.toString('utf8')));
      invariant(
        metadata.manifest.sha256 === request.manifest.sha256 &&
          metadata.manifest.size === request.manifest.size &&
          metadata.work.sha256 === request.work.sha256 &&
          metadata.work.size === request.work.size,
        'INVALID_WORK_BACKUP',
        'The seed root differs from its pinned Work and manifest.',
      );
      let mainDigest: string | null = null;
      if (request.format === 'native') {
        invariant(request.main, 'INVALID_WORK_BACKUP', 'Pin native main at seed start.');
        if (request.receipt) {
          const [bytes] = await reader.read(input.projectId, owner, [request.receipt]);
          const receipt = channelMoveSchema.parse(JSON.parse(bytes!.toString('utf8')));
          invariant(
            receipt.channel === 'main' &&
              receipt.status === 'accepted' &&
              receipt.id === request.receiptId &&
              receipt.head === request.head &&
              receipt.previous === request.previousHead,
            'INVALID_WORK_BACKUP',
            'The seed receipt differs from pinned native main.',
          );
        } else
          invariant(
            request.receiptId === null && request.previousHead === null,
            'INVALID_WORK_BACKUP',
            'Bootstrap has no native acceptance receipt.',
          );
        const [main] = await reader.read(input.projectId, owner, [request.main]);
        parseNativeState(main!);
        mainDigest = digest(main!);
        invariant(
          mainDigest === request.head,
          'SOURCE_HASH_MISMATCH',
          'Hosted main differs from native main.',
        );
      }
      return await ctx.runMutation(makeFunctionReference<'mutation'>('projectHostedSeed:commit'), {
        ...input,
        owner,
        mainDigest,
        ...(request.format === 'native' && metadata.schema === 2 ? { validatedWorkRecords: 1 } : {}),
      });
    } catch (error) {
      return report(error);
    }
  },
});
